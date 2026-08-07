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
const FIELDS = 'code,product_name,generic_name,brands,nutriments'
  + ',serving_size,serving_quantity,serving_quantity_unit';

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
  const size = parseServing(product);
  const basis = servingBasis(n, size);

  return {
    barcode: code,
    name: (product.product_name || product.generic_name || '').trim() || `Barcode ${code}`,
    brand: firstBrand(product.brands),
    serving_qty: basis.qty,
    serving_unit: basis.unit,
    // Nothing to override: one serving is already the amount you want.
    default_qty: null,
    calories: basis.read('energy-kcal') ?? kjToKcal(basis.raw('energy')),
    protein_g: basis.read('proteins'),
    carbs_g: basis.read('carbohydrates'),
    fat_g: basis.read('fat'),
    fiber_g: basis.read('fiber'),
    sodium_mg: sodiumMg(basis),
    basis: basis.label,
    source: 'off',
  };
}

/**
 * One serving is the unit. You scan a can of Fresca to log a can of Fresca —
 * how many grams that is doesn't come into it.
 *
 * So a scanned food is stored as `1 serving`, and the macros are the macros of
 * one serving. Grams appear only in the human-readable basis label, and only
 * because it is worth being able to see what the serving actually was.
 *
 *  1. OFF published per-serving nutriments — use them directly.
 *  2. Only per-100g, but the serving is a known mass or volume — one serving is
 *     that much of it, so the numbers are scaled onto it. Exact arithmetic on a
 *     figure OFF gave us, not an estimate.
 *  3. Nothing about servings at all — per 100 g, because there is no serving to
 *     express it in. Rare, and the review form can fix it.
 */
function servingBasis(n, size) {
  const perServing = num(n['energy-kcal_serving']) ?? kjToKcal(n.energy_serving);

  if (perServing != null) {
    return {
      qty: 1,
      unit: 'serving',
      label: size?.label || 'one serving',
      raw: (key) => n[`${key}_serving`],
      read: (key) => num(n[`${key}_serving`]),
    };
  }

  if (size && (size.unit === 'g' || size.unit === 'ml')) {
    const factor = size.qty / 100;
    return {
      qty: 1,
      unit: 'serving',
      label: size.label,
      raw: (key) => scale(n[`${key}_100g`], factor),
      read: (key) => num(scale(n[`${key}_100g`], factor)),
    };
  }

  return {
    qty: 100,
    unit: 'g',
    label: 'per 100 g',
    raw: (key) => n[`${key}_100g`],
    read: (key) => num(n[`${key}_100g`]),
  };
}

function scale(value, factor) {
  const v = Number(value);
  return Number.isFinite(v) ? v * factor : null;
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
function sodiumMg(basis) {
  // basis.raw, not basis.read: read()'s 1-decimal rounding happens in grams,
  // where it is catastrophic. Nutella's 0.0428 g would round to 0.0 and report
  // 0 mg. Rounding belongs after the conversion, not before it.
  const grams = (key) => {
    const v = Number(basis.raw(key));
    return Number.isFinite(v) ? v : null;
  };

  const sodium = grams('sodium');
  if (sodium != null) return Math.round(sodium * 1000);

  const salt = grams('salt');
  return salt == null ? null : Math.round((salt / 2.5) * 1000);
}

function firstBrand(brands) {
  if (!brands) return null;
  return String(brands).split(',')[0].trim() || null;
}
