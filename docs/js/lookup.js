/**
 * lookup.js — Open Food Facts barcode lookup.
 *
 * This is the cold path: it runs only for a food you have never eaten before.
 * Once saved, the food lives in IndexedDB and never needs the network again,
 * which is why the logging path can stay offline.
 *
 * OFF is ODbL — results may be stored and snapshotted, which is precisely why
 * FatSecret was rejected. See DESIGN.md.
 *
 * A result is returned as an unsaved draft for review, never written directly.
 * OFF is crowd-sourced and frequently incomplete, so a human confirms before it
 * becomes one of your foods — the same convention as the import-photo function.
 */

/**
 * Only the fields we actually map.
 *
 * This matters more than it looks. A full OFF product response is hundreds of
 * kilobytes — every ingredient list in twelve languages, every uploaded image,
 * ecoscore breakdowns, and thousands of popularity tags. Requesting five fields
 * turns a multi-hundred-KB download into a couple of KB, which is the difference
 * between usable and not on a phone in a supermarket.
 */
const FIELDS = 'code,product_name,generic_name,brands,nutriments';

const ENDPOINTS = [
  (code) => `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`,
  (code) => `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`,
];

const TIMEOUT_MS = 6000;

/** Macros we need to consider a lookup usable without hand-editing. */
const REQUIRED = ['calories', 'protein_g', 'carbs_g', 'fat_g'];

/**
 * @returns {Promise<{status: 'found'|'not_found'|'offline'|'error',
 *                    draft?: object, missing?: string[], message?: string}>}
 */
export async function lookupBarcode(code) {
  if (!navigator.onLine) return { status: 'offline' };

  let lastError = null;

  for (const build of ENDPOINTS) {
    try {
      const data = await fetchJson(build(code));

      // OFF answers 200 with status 0 for an unknown barcode.
      if (!data?.product || data.status === 0) return { status: 'not_found' };

      const draft = toDraft(data.product, code);
      const missing = REQUIRED.filter((k) => draft[k] == null);
      return { status: 'found', draft, missing };
    } catch (error) {
      lastError = error;
    }
  }

  return { status: 'error', message: lastError?.message ?? 'Lookup failed.' };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map an OFF product onto the shape `plates.foods` expects.
 *
 * Serving basis is preferred over per-100g. You scan a tub of yoghurt to log
 * the serving on its label, not to do arithmetic — forcing everything to 100g
 * rewrites the label into numbers that appear nowhere on the packaging.
 *
 * Per-100g remains the fallback because it is the one basis OFF always
 * populates; plenty of products carry no serving size at all.
 */
function toDraft(product, code) {
  const n = product.nutriments ?? {};
  const serving = servingBasis(product, n);
  const per = serving ? '_serving' : '_100g';

  return {
    barcode: code,
    name: (product.product_name || product.generic_name || '').trim() || `Barcode ${code}`,
    brand: firstBrand(product.brands),
    serving_qty: serving ? serving.qty : 100,
    serving_unit: serving ? serving.unit : 'g',
    calories: num(n[`energy-kcal${per}`]) ?? kjToKcal(n[`energy${per}`]),
    protein_g: num(n[`proteins${per}`]),
    carbs_g: num(n[`carbohydrates${per}`]),
    fat_g: num(n[`fat${per}`]),
    fiber_g: num(n[`fiber${per}`]),
    sodium_mg: sodiumMg(n, per),
    basis: serving ? serving.label : 'per 100 g',
    source: 'off',
  };
}

/**
 * The serving OFF recorded, or null to fall back to per-100g.
 *
 * Requires both a parseable size and per-serving calories — a serving size with
 * no serving nutriments would otherwise pair the label's quantity with 100g
 * macros, which is worse than either basis on its own.
 */
function servingBasis(product, n) {
  const kcal = num(n['energy-kcal_serving']) ?? kjToKcal(n.energy_serving);
  if (kcal == null) return null;

  const size = parseServing(product);
  return size && size.qty > 0 ? size : null;
}

/**
 * `serving_quantity` is OFF's own numeric parse of the free-text `serving_size`
 * ("3/4 cup (170 g)" → 170) and is what the per-serving nutriments are keyed to,
 * so it is trusted ahead of anything scraped out of the string.
 */
function parseServing(product) {
  const text = String(product.serving_size ?? '').trim();
  const qty = num(product.serving_quantity);

  if (qty != null && qty > 0) {
    const unit = String(product.serving_quantity_unit ?? '').trim().toLowerCase()
      || (/\bml\b/i.test(text) ? 'ml' : 'g');
    return { qty, unit, label: text || `${qty} ${unit}` };
  }

  // No numeric parse from OFF; take the first number-and-unit in the string.
  const match = text.match(/([\d.]+)\s*(g|ml|oz)\b/i);
  if (!match) return null;

  return {
    qty: Number(match[1]),
    unit: match[2].toLowerCase(),
    label: text,
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** Some entries carry only kilojoules. */
function kjToKcal(kj) {
  const n = num(kj);
  return n == null ? null : Math.round(n / 4.184);
}

/**
 * OFF reports sodium and salt in grams; we store milligrams. Nutella's 0.0428 g
 * is 43 mg — displaying the raw gram figure rounds it to zero, which is why this
 * conversion happens at the mapping layer rather than in the view.
 */
function sodiumMg(n, per = '_100g') {
  // Deliberately not num(): its 1-decimal rounding happens in grams, where it
  // is catastrophic. Nutella's 0.0428 g would round to 0.0 and report 0 mg.
  const raw = (key) => {
    const v = Number(n[key]);
    return Number.isFinite(v) ? v : null;
  };

  const sodium = raw(`sodium${per}`);
  if (sodium != null) return Math.round(sodium * 1000);

  const salt = raw(`salt${per}`);
  return salt == null ? null : Math.round((salt / 2.5) * 1000);
}

function firstBrand(brands) {
  if (!brands) return null;
  return String(brands).split(',')[0].trim() || null;
}
