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
 * Everything is normalised to per-100g because that is the one basis OFF
 * populates consistently; its `serving_size` is a free-text string like
 * "2 biscuits (30 g)" and is not reliably parseable.
 */
function toDraft(product, code) {
  const n = product.nutriments ?? {};

  return {
    barcode: code,
    name: (product.product_name || product.generic_name || '').trim() || `Barcode ${code}`,
    brand: firstBrand(product.brands),
    serving_qty: 100,
    serving_unit: 'g',
    calories: num(n['energy-kcal_100g']) ?? kjToKcal(n.energy_100g),
    protein_g: num(n.proteins_100g),
    carbs_g: num(n.carbohydrates_100g),
    fat_g: num(n.fat_100g),
    fiber_g: num(n.fiber_100g),
    sodium_mg: sodiumMg(n),
    source: 'off',
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
function sodiumMg(n) {
  const sodium = num(n.sodium_100g);
  if (sodium != null) return Math.round(sodium * 1000);

  const salt = num(n.salt_100g);
  return salt == null ? null : Math.round((salt / 2.5) * 1000);
}

function firstBrand(brands) {
  if (!brands) return null;
  return String(brands).split(',')[0].trim() || null;
}
