/**
 * The USDA Edge Function's ranker.
 *
 * Imported straight from supabase/functions — Node strips the types, so this is
 * the same source Deno runs, not a copy. That matters: the client has its own
 * near-identical scorer in food.js, and the two have already drifted by hand
 * once. Testing the real file is what keeps this half honest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const r = await import('../supabase/functions/lookup-usda/ranking.ts');

const terms = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const score = (q, food) => r.scoreAgainst(terms(q), food);

const sr = (description, extra = {}) => ({ description, dataType: 'SR Legacy', ...extra });
const branded = (description, brandName, extra = {}) =>
  ({ description, brandName, dataType: 'Branded', ...extra });

// ---- the bug that started it -----------------------------------------------

test('milk beats pudding made with milk', () => {
  const milk = score('milk 2%', sr('Milk, reduced fat, fluid, 2% milkfat, with added vitamin A'));
  const pudding = score('milk 2%', sr('Puddings, chocolate flavor, dry mix, prepared with 2% milk'));
  assert.ok(milk > pudding * 2, `milk ${milk} vs pudding ${pudding}`);
});

test('every pudding variant loses to every milk variant', () => {
  const milks = [
    'Milk, reduced fat, fluid, 2% milkfat, protein fortified',
    'Milk, reduced fat, fluid, 2% milkfat, with added vitamin A',
  ].map((d) => score('milk 2%', sr(d)));

  const puddings = [
    'Puddings, vanilla, dry mix, instant, prepared with 2% milk',
    'Pudding, tapioca, ready-to-eat, made with 2% milk',
    'Cereals ready-to-eat, granola, prepared with 2% milk',
  ].map((d) => score('milk 2%', sr(d)));

  assert.ok(Math.min(...milks) > Math.max(...puddings));
});

// ---- brand handling --------------------------------------------------------

test('searching a brand does not rank by whether the maker restated it', () => {
  // "Great Value Black Tea" repeats the brand in its name; the milk does not.
  const tea = score('great value', branded('Great Value Black Tea', 'Great Value'));
  const milk = score('great value', branded('2% Reduced Fat Milk', 'Great Value'));
  assert.equal(Math.round(tea), Math.round(milk));
});

test('adding a food word to a brand search disambiguates it', () => {
  const milk = score('great value milk', branded('Great Value Whole Milk', 'Great Value'));
  const tea = score('great value milk', branded('Great Value Black Tea', 'Great Value'));
  assert.ok(milk > tea * 3, `milk ${milk} vs tea ${tea}`);
});

test('a brand word cannot win the head-noun bonus', () => {
  const butter = score('great value peanut butter', branded('Peanut Butter, Creamy', 'Great Value'));
  const cookies = score('great value peanut butter', branded('Great Value Sandwich Cookies, Peanut Butter', 'Great Value'));
  assert.ok(butter > cookies, `peanut butter ${butter} vs cookies ${cookies}`);
});

test('brand terms match whole words, not substrings', () => {
  // "myprotein".includes("protein") is true. If "protein" counted as a brand
  // word it would be worth 5 instead of 12 on a product called Impact Whey
  // Protein, and barred from the head bonus.
  const s = score('myprotein protein powder', branded('Impact Whey Protein', 'Myprotein'));
  assert.ok(s > 0);
});

test('a brand-only search returns that brand rather than scoring it zero', () => {
  const s = score('myprotein', branded('Impact Whey Protein, Chocolate Brownie', 'Myprotein'));
  assert.ok(s > 0, 'the padding penalty must not exceed the brand credit');
});

test('brandOwner counts as brand when brandName is absent', () => {
  const s = score('walmart', { description: 'Some Product', brandOwner: 'Walmart Inc', dataType: 'Branded' });
  assert.ok(s > 0);
});

// ---- head noun -------------------------------------------------------------

test('a branded name is read from its last word', () => {
  const s = score('milk', branded('Great Value Whole Milk', 'Great Value'));
  assert.ok(s > 0);
});

test('an SR description is read from its first word only', () => {
  const isMilk = score('milk', sr('Milk, reduced fat, fluid'));
  const endsInMilk = score('milk', sr('Puddings, chocolate, prepared with 2% milk'));
  assert.ok(isMilk > endsInMilk * 2, 'the tail must not qualify an SR description');
});

// ---- coverage and padding --------------------------------------------------

test('coverage multiplies, so half an answer loses to a whole one', () => {
  const half = score('milk 2%', branded('Milk Chocolate Candy Bar', 'Hershey'));
  const whole = score('milk 2%', sr('Milk, reduced fat, fluid, 2% milkfat'));
  assert.ok(whole > half * 2, `whole ${whole} vs half ${half}`);
});

test('a tight description beats a long one carrying the terms incidentally', () => {
  const tight = score('chicken breast', sr('Chicken breast, oven-roasted'));
  const padded = score('chicken breast', sr('Soup, chicken broth, canned, prepared with chicken breast and vegetables'));
  assert.ok(tight > padded);
});

test('a food matching nothing scores zero', () => {
  assert.equal(score('clementine', sr('Tangerines, (mandarin oranges), raw')), 0);
  assert.equal(score('zzz', sr('Milk')), 0);
});

test('an empty description does not throw', () => {
  assert.equal(score('milk', sr('')), 0);
  assert.equal(score('milk', {}), 0);
});

// ---- rank, floor and limit -------------------------------------------------

const candidates = [
  sr('Milk, reduced fat, fluid, 2% milkfat, with added vitamin A'),
  branded('2% Reduced Fat Milk', 'Great Value'),
  sr('Puddings, chocolate flavor, dry mix, prepared with 2% milk'),
  sr('Cocoa, hot chocolate, prepared with 2% milk'),
  branded('Milk Chocolate Candy Bar', 'Hershey'),
  sr('Bread, white, commercially prepared'),      // matches nothing
];

test('rankFoods sorts best first and drops non-matches', () => {
  const ranked = r.rankFoods(candidates, terms('milk 2%'), 10);
  assert.ok(ranked.length > 0);
  assert.equal(ranked.every((x) => x.score > 0), true);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, 'must be descending');
  }
  assert.equal(ranked.some((x) => x.food.description.startsWith('Bread')), false);
});

test('rankFoods applies the relevance floor', () => {
  const ranked = r.rankFoods(candidates, terms('milk 2%'), 100);
  const best = ranked[0].score;
  assert.equal(ranked.every((x) => x.score >= best * r.RELEVANCE_FLOOR), true);
});

test('rankFoods respects the limit', () => {
  assert.ok(r.rankFoods(candidates, terms('milk 2%'), 2).length <= 2);
});

test('rankFoods on nothing returns nothing', () => {
  assert.deepEqual(r.rankFoods([], terms('milk'), 10), []);
});

// ---- unmatched terms -------------------------------------------------------

test('a typo is reported as a word that matched nothing', () => {
  // The candidate set has to cover the other words, or they are unmatched too —
  // which is correct, and was how this test was wrong the first time.
  const unmatched = r.unmatchedTerms(terms('2% great value mlik'), [
    branded('Great Value Black Tea', 'Great Value'),
    branded('2% Reduced Fat Milk', 'Great Value'),
  ]);
  assert.deepEqual(unmatched, ['mlik']);
});

test('a word absent from every result is reported, typo or not', () => {
  const unmatched = r.unmatchedTerms(terms('great value zzz'), [
    branded('Great Value Black Tea', 'Great Value'),
  ]);
  assert.deepEqual(unmatched, ['zzz']);
});

test('nothing is reported when every word landed', () => {
  assert.deepEqual(r.unmatchedTerms(terms('great value'), [branded('Black Tea', 'Great Value')]), []);
});

// ---- serving basis ---------------------------------------------------------

test('a branded label serving in grams becomes one serving', () => {
  const serving = r.servingOf({ servingSize: 55, servingSizeUnit: 'g', householdServingFullText: '2/3 cup' });
  assert.deepEqual(serving, { grams: 55, label: '2/3 cup' });
});

test('a serving with no household text falls back to the measurement', () => {
  assert.equal(r.servingOf({ servingSize: 30, servingSizeUnit: 'ml' }).label, '30 ml');
});

test('a serving in a unit that cannot be scaled is refused', () => {
  assert.equal(r.servingOf({ servingSize: 1, servingSizeUnit: 'bar' }), null);
  assert.equal(r.servingOf({ servingSize: 0, servingSizeUnit: 'g' }), null);
  assert.equal(r.servingOf({}), null);
});

test('a household measure supplies the serving for SR and Foundation rows', () => {
  const serving = r.servingOf({ foodMeasures: [{ gramWeight: 74, disseminationText: '1 fruit' }] });
  assert.deepEqual(serving, { grams: 74, label: '1 fruit' });
});

test('the first usable household measure wins', () => {
  const serving = r.servingOf({ foodMeasures: [
    { gramWeight: 0, disseminationText: 'bad' },
    { gramWeight: 120, disseminationText: '1 cup' },
  ] });
  assert.equal(serving.label, '1 cup');
});

// ---- draft mapping ---------------------------------------------------------

const nutrients = [
  { nutrientId: 1008, value: 59 },      // kcal
  { nutrientId: 1003, value: 10.6 },    // protein
  { nutrientId: 1005, value: 3.5 },     // carbs
  { nutrientId: 1004, value: 0 },       // fat
];

test('a food with a serving is stored as one serving, scaled from per-100g', () => {
  const { draft } = r.toDraft({
    description: 'CLEMENTINES, RAW', foodNutrients: nutrients,
    foodMeasures: [{ gramWeight: 74, disseminationText: '1 fruit' }],
  });
  assert.equal(draft.serving_qty, 1);
  assert.equal(draft.serving_unit, 'serving');
  assert.equal(draft.basis, '1 fruit');
  assert.equal(draft.calories, 43.7);   // 59 × 0.74
});

test('a food with no serving stays per 100 g and says so', () => {
  const { draft } = r.toDraft({ description: 'Milk, whole', foodNutrients: nutrients });
  assert.equal(draft.serving_qty, 100);
  assert.equal(draft.serving_unit, 'g');
  assert.equal(draft.basis, 'per 100 g');
  assert.equal(draft.calories, 59);
});

test('kilojoules are converted when kcal is absent', () => {
  const { draft } = r.toDraft({ description: 'Peanut butter', foodNutrients: [{ nutrientId: 1062, value: 2000 }] });
  assert.equal(draft.calories, 478);
});

test('nutrients are found by number when the id is missing', () => {
  const { draft } = r.toDraft({ description: 'X', foodNutrients: [{ nutrientNumber: '208', value: 100 }] });
  assert.equal(draft.calories, 100);
});

test('missing required macros are reported', () => {
  const { missing } = r.toDraft({ description: 'X', foodNutrients: [{ nutrientId: 1008, value: 100 }] });
  assert.deepEqual(missing.sort(), ['carbs_g', 'fat_g', 'protein_g']);
});

test('a food with no nutrients at all does not throw', () => {
  const { draft, missing } = r.toDraft({ description: 'Empty' });
  assert.equal(draft.calories, null);
  assert.equal(missing.length, 4);
});

test('an unnamed food gets a placeholder rather than an empty row', () => {
  assert.equal(r.toDraft({}).draft.name, 'Unnamed food');
});

// ---- name tidying ----------------------------------------------------------

test('shouted branded descriptions are title-cased', () => {
  assert.equal(r.tidyName('GREAT VALUE, BLACK TEA'), 'Great Value, Black Tea');
  assert.equal(r.tidyName('GREAT VALUE, 2% REDUCED FAT MILK'), 'Great Value, 2% Reduced Fat Milk');
  assert.equal(r.tidyName('CHOBANI, NON-FAT GREEK YOGURT (PLAIN)'), 'Chobani, Non-Fat Greek Yogurt (Plain)');
});

test('sentence-case descriptions are left exactly as written', () => {
  for (const name of [
    'Milk, reduced fat, fluid, 2% milkfat, with added vitamin A',
    'Clementines, raw',
    'Peanut butter, smooth style, with salt',
  ]) {
    assert.equal(r.tidyName(name), name);
  }
});

test('tidyName leaves very short strings alone', () => {
  assert.equal(r.tidyName('AB'), 'AB');
  assert.equal(r.tidyName(''), '');
});

test('the brand is tidied as well as the description', () => {
  const { draft } = r.toDraft({ description: 'X', brandName: 'WAL-MART STORES, INC.', foodNutrients: nutrients });
  assert.equal(draft.brand, 'Wal-Mart Stores, Inc.');
});

// ---- barcodes --------------------------------------------------------------

test('UPC-A and EAN-13 forms of the same code compare equal', () => {
  assert.equal(r.normaliseUpc('078742351872'), r.normaliseUpc('0078742351872'));
});

test('normaliseUpc strips non-digits', () => {
  assert.equal(r.normaliseUpc('0-78742-35187-2'), '78742351872');
});

// ---- the client scorer must not drift from this one ------------------------

test('both scorers agree on the orderings that have already broken once', async () => {
  const { installBrowser } = await import('./helpers/browser.mjs');
  installBrowser();
  const food = await import('../docs/js/food.js');

  // Same cases, expressed for each side's input shape.
  const cases = [
    { q: 'milk 2%',
      a: { desc: 'Milk, reduced fat, fluid, 2% milkfat', brand: null },
      b: { desc: 'Puddings, chocolate, dry mix, prepared with 2% milk', brand: null } },
    { q: 'great value peanut butter',
      a: { desc: 'Peanut Butter, Creamy', brand: 'Great Value' },
      b: { desc: 'Great Value Sandwich Cookies, Peanut Butter', brand: 'Great Value' } },
  ];

  for (const { q, a, b } of cases) {
    const edgeA = r.scoreAgainst(terms(q), { description: a.desc, brandName: a.brand, dataType: a.brand ? 'Branded' : 'SR Legacy' });
    const edgeB = r.scoreAgainst(terms(q), { description: b.desc, brandName: b.brand, dataType: b.brand ? 'Branded' : 'SR Legacy' });

    const clientA = food.scoreDraft(terms(q), { name: a.desc, brand: a.brand });
    const clientB = food.scoreDraft(terms(q), { name: b.desc, brand: b.brand });

    assert.equal(edgeA > edgeB, clientA > clientB,
      `"${q}": edge says ${edgeA > edgeB}, client says ${clientA > clientB} — the two scorers have drifted`);
  }
});
