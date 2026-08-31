import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const lookup = await import('../docs/js/lookup.js');

/**
 * Drive lookupBarcode with a canned Open Food Facts response.
 *
 * Forces onLine: the shared helper defaults offline so local writes cannot drain
 * the outbox mid-test, and lookupBarcode short-circuits when offline.
 */
async function scan(product, { status = 1, httpOk = true } = {}) {
  globalThis.fetch = async () => {
    if (!httpOk) return { ok: false, status: 500, statusText: 'Server Error' };
    return { ok: true, status: 200, json: async () => ({ status, product }) };
  };

  const was = navigator.onLine;
  navigator.onLine = true;
  try {
    return await lookup.lookupBarcode('1234567890');
  } finally {
    navigator.onLine = was;
  }
}

const perServingProduct = {
  product_name: 'Non-Fat Greek Yogurt, Plain',
  brands: 'Chobani',
  serving_size: '3/4 cup (170 g)',
  serving_quantity: 170,
  nutriments: {
    'energy-kcal_100g': 59, proteins_100g: 10.6, carbohydrates_100g: 3.5, fat_100g: 0, sodium_100g: 0.038,
    'energy-kcal_serving': 100, proteins_serving: 18, carbohydrates_serving: 6, fat_serving: 0, sodium_serving: 0.065,
  },
};

// ---- serving basis ---------------------------------------------------------

test('per-serving nutriments are used as one serving', async () => {
  const { status, draft } = await scan(perServingProduct);
  assert.equal(status, 'found');
  assert.equal(draft.serving_qty, 1);
  assert.equal(draft.serving_unit, 'serving');
  assert.equal(draft.calories, 100);
  assert.equal(draft.protein_g, 18);
  assert.equal(draft.basis, '3/4 cup (170 g)');
});

test('per-100g plus a known serving is scaled onto one serving', async () => {
  const { draft } = await scan({
    product_name: 'Crackers', brands: 'X',
    serving_size: '30 g', serving_quantity: 30,
    nutriments: { 'energy-kcal_100g': 450, proteins_100g: 8, carbohydrates_100g: 70, fat_100g: 15, sodium_100g: 1.2 },
  });
  assert.equal(draft.serving_qty, 1);
  assert.equal(draft.calories, 135);      // 450 × 0.30
  assert.equal(draft.protein_g, 2.4);
  assert.equal(draft.sodium_mg, 360);
});

test('a can of drink becomes one serving, not 100 ml', async () => {
  const { draft } = await scan({
    product_name: 'Fresca Grapefruit Citrus', brands: 'Fresca',
    serving_size: '1 can (355 ml)', serving_quantity: 355, serving_quantity_unit: 'ml',
    nutriments: { 'energy-kcal_100g': 0, proteins_100g: 0, carbohydrates_100g: 0, fat_100g: 0, sodium_100g: 0.0099 },
  });
  assert.equal(draft.serving_unit, 'serving');
  assert.equal(draft.calories, 0);
  assert.equal(draft.sodium_mg, 35);
  assert.equal(draft.basis, '1 can (355 ml)');
});

test('no serving information at all falls back to 100 g, and says so', async () => {
  const { draft } = await scan({
    product_name: 'Bulk Oats', brands: 'Store',
    nutriments: { 'energy-kcal_100g': 379, proteins_100g: 13, carbohydrates_100g: 67, fat_100g: 7 },
  });
  assert.equal(draft.serving_qty, 100);
  assert.equal(draft.serving_unit, 'g');
  assert.equal(draft.basis, 'per 100 g');
  assert.equal(draft.calories, 379);
});

test('a count-based serving with no weight cannot be scaled, so stays per 100 g', async () => {
  const { draft } = await scan({
    product_name: 'Biscuits', brands: 'Y',
    serving_size: '2 biscuits', serving_quantity: null,
    nutriments: { 'energy-kcal_100g': 480, proteins_100g: 6, carbohydrates_100g: 64, fat_100g: 22 },
  });
  assert.equal(draft.serving_unit, 'g');
  assert.equal(draft.calories, 480);
});

test('a serving size in the text but no numeric quantity is still parsed', async () => {
  const { draft } = await scan({
    product_name: 'Cereal', brands: 'Z',
    serving_size: '55 g',
    nutriments: { 'energy-kcal_100g': 400, proteins_100g: 10, carbohydrates_100g: 70, fat_100g: 5 },
  });
  assert.equal(draft.serving_unit, 'serving');
  assert.equal(draft.calories, 220);      // 400 × 0.55
});

// ---- units and conversions -------------------------------------------------

test('sodium converts grams to milligrams without rounding to zero first', async () => {
  // Nutella's 0.0428 g is 43 mg. Rounding in grams would report 0.
  const { draft } = await scan({
    product_name: 'Nutella', brands: 'Ferrero',
    nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6, carbohydrates_100g: 57, fat_100g: 31, sodium_100g: 0.0428 },
  });
  assert.equal(draft.sodium_mg, 43);
});

test('salt is converted to sodium when sodium is absent', async () => {
  const { draft } = await scan({
    product_name: 'Salted Thing', brands: 'X',
    nutriments: { 'energy-kcal_100g': 100, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1, salt_100g: 2.5 },
  });
  assert.equal(draft.sodium_mg, 1000);   // 2.5g salt / 2.5
});

test('kilojoules are converted when kcal is missing', async () => {
  const { draft } = await scan({
    product_name: 'EU Product', brands: 'X',
    nutriments: { energy_100g: 2000, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 3 },
  });
  assert.equal(draft.calories, 478);     // 2000 / 4.184
});

// ---- names and brands ------------------------------------------------------

test('brand comes from a comma string or an array', () => {
  const fromProducts = lookup.draftsFromProducts([
    { code: '1', product_name: 'A', brands: 'Chobani, Chobani LLC', nutriments: { 'energy-kcal_100g': 10 } },
    { code: '2', product_name: 'B', brands: ['MyProtein', 'Other'], nutriments: { 'energy-kcal_100g': 10 } },
  ]);
  assert.equal(fromProducts[0].draft.brand, 'Chobani');
  assert.equal(fromProducts[1].draft.brand, 'MyProtein');
});

test('a nameless product falls back to its barcode', async () => {
  const { draft } = await scan({
    product_name: '', generic_name: '',
    nutriments: { 'energy-kcal_100g': 100, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1 },
  });
  assert.match(draft.name, /Barcode/);
});

test('generic_name is used when product_name is blank', async () => {
  const { draft } = await scan({
    product_name: '', generic_name: 'Plain Yoghurt',
    nutriments: { 'energy-kcal_100g': 60, proteins_100g: 5, carbohydrates_100g: 4, fat_100g: 1 },
  });
  assert.equal(draft.name, 'Plain Yoghurt');
});

// ---- failure modes ---------------------------------------------------------

test('an unknown barcode reports not_found rather than an empty draft', async () => {
  const r = await scan(null, { status: 0 });
  assert.equal(r.status, 'not_found');
});

test('being offline is reported as offline, not as a failure', async () => {
  const was = navigator.onLine;
  navigator.onLine = false;
  try {
    assert.equal((await lookup.lookupBarcode('123')).status, 'offline');
  } finally {
    navigator.onLine = was;
  }
});

test('an HTTP error surfaces as an error with a message', async () => {
  const r = await scan(null, { httpOk: false });
  assert.equal(r.status, 'error');
  assert.match(r.message, /500/);
});

test('missing required macros are reported so the form can flag them', async () => {
  const { missing } = await scan({
    product_name: 'Partial', brands: 'X',
    nutriments: { 'energy-kcal_100g': 100 },
  });
  assert.deepEqual(missing.sort(), ['carbs_g', 'fat_g', 'protein_g']);
});

test('a complete product reports nothing missing', async () => {
  const { missing } = await scan(perServingProduct);
  assert.deepEqual(missing, []);
});

// ---- search-result mapping -------------------------------------------------

test('draftsFromProducts drops entries with no name and no calories', () => {
  const drafts = lookup.draftsFromProducts([
    { code: '1', product_name: 'Good', brands: 'X', nutriments: { 'energy-kcal_100g': 100 } },
    { code: '2', product_name: '', brands: 'X', nutriments: { 'energy-kcal_100g': 100 } },
    { code: '3', product_name: 'No calories', brands: 'X', nutriments: {} },
  ]);
  assert.deepEqual(drafts.map((d) => d.draft.name), ['Good']);
});

test('draftsFromProducts tolerates junk input instead of throwing', () => {
  assert.deepEqual(lookup.draftsFromProducts(undefined), []);
  assert.deepEqual(lookup.draftsFromProducts(null), []);
  assert.deepEqual(lookup.draftsFromProducts({}), []);
  assert.deepEqual(lookup.draftsFromProducts([]), []);
});

test('a search hit enriched with a serving is mapped as one serving', () => {
  // What the Edge Function produces after filling in the serving fields the
  // search service omits.
  const [{ draft }] = lookup.draftsFromProducts([{
    code: '5055534348239',
    product_name: 'Myprotein impact whey protein',
    brands: ['MyProtein'],
    serving_size: '1 scoop (31 g)',
    serving_quantity: 31,
    nutriments: { 'energy-kcal_100g': 381, proteins_100g: 69.8, carbohydrates_100g: 5, fat_100g: 7 },
  }]);
  assert.equal(draft.serving_qty, 1);
  assert.equal(draft.serving_unit, 'serving');
  assert.equal(draft.calories, 118.1);    // 381 × 0.31
  assert.equal(draft.basis, '1 scoop (31 g)');
});

test('the raw serving fields are reported for diagnosis', async () => {
  const { draft } = await scan(perServingProduct);
  assert.match(draft.servingRaw, /serving_size/);
  assert.match(draft.servingRaw, /serving_quantity/);
});

// ---- the serving in the source's own words ---------------------------------

const draftFor = (servingSize, extra = {}) => lookup.draftsFromProducts([{
  code: '123',
  product_name: 'Chicken Skewers',
  serving_size: servingSize,
  nutriments: { 'energy-kcal_serving': 190, proteins_serving: 22 },
  ...extra,
}])[0].draft;

test('a serving that names the thing is kept', () => {
  assert.equal(draftFor('2 skewers (114 g)').serving_text, '2 skewers (114 g)');
  assert.equal(draftFor('3 cookies (30g)').serving_text, '3 cookies (30g)');
  assert.equal(draftFor('1 slice').serving_text, '1 slice');
});

test('a serving that is only the measure again is dropped', () => {
  // Printing these would put "114 g" on the label twice.
  assert.equal(draftFor('114 g').serving_text, null);
  assert.equal(draftFor('30ml').serving_text, null);
  assert.equal(draftFor('1 portion (30 g)').serving_text, null);
  assert.equal(draftFor('about 100 g').serving_text, null);
});

test('no serving text at all is null, not an empty string', () => {
  assert.equal(draftFor('').serving_text, null);
  assert.equal(draftFor(undefined).serving_text, null);
});

test('the phrase does not disturb the numbers it came with', () => {
  const draft = draftFor('2 skewers (114 g)');
  assert.equal(draft.serving_size, 114);
  assert.equal(draft.serving_size_unit, 'g');
  assert.equal(draft.serving_unit, 'serving');
});

test('a serving with words but no weight still keeps its words', () => {
  // parseServing finds nothing to measure here, which is precisely when the
  // phrase is the only description there is.
  const draft = draftFor('1 slice');
  assert.equal(draft.serving_text, '1 slice');
  assert.equal(draft.serving_size, null, 'and no measure is invented');
});

test('debris in the serving field is dropped, not printed', () => {
  // All real shapes from Open Food Facts. The flowpack one reached the label.
  assert.equal(draftFor('1 [image of a flowpack] (22 g)').serving_text, null);
  assert.equal(draftFor('<b>2 cookies</b>').serving_text, null);
  assert.equal(
    draftFor('a serving is roughly one third of the tub, or thereabouts, 85g').serving_text,
    null, 'prose is not a serving description');
  // And the good ones still survive the new filter.
  assert.equal(draftFor('2 skewers (114 g)').serving_text, '2 skewers (114 g)');
  assert.equal(draftFor('3 cookies (34g)').serving_text, '3 cookies (34g)');
});

test('a per-serving figure that is really the per-100g one is refused', () => {
  // Golden Oreo: OFF says 484 kcal for a 22 g serving, which is its per-100g
  // number. The derived 484 * 0.22 is what a serving actually is.
  const draft = draftFor('22 g', {
    nutriments: {
      'energy-kcal_serving': 484, 'energy-kcal_100g': 484,
      carbohydrates_serving: 69, carbohydrates_100g: 69,
    },
  });

  assert.equal(draft.serving_unit, 'serving');
  assert.ok(draft.calories < 150,
    `expected a real serving, got ${draft.calories} kcal`);
  assert.equal(draft.calories, 106.5, '484 * 0.22, to the tenth num() keeps');
});

test('a genuine 100 g serving is left alone', () => {
  // Here the two figures agreeing is correct, not a mistake.
  const draft = draftFor('100 g', {
    nutriments: { 'energy-kcal_serving': 250, 'energy-kcal_100g': 250 },
  });
  assert.equal(Math.round(draft.calories), 250);
});

test('a per-serving figure that disagrees with per-100g is trusted', () => {
  // The normal case: 34 g of a 480 kcal/100g biscuit is 163, and OFF says so.
  const draft = draftFor('34 g', {
    nutriments: { 'energy-kcal_serving': 163, 'energy-kcal_100g': 480 },
  });
  assert.equal(Math.round(draft.calories), 163, 'the published serving wins');
});
