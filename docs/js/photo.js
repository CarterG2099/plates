/**
 * photo.js — read a photo into something loggable.
 *
 * Two jobs with very different epistemics:
 *
 *   readLabel()   transcribes a Nutrition Facts panel. The numbers are printed
 *                 on the packet, so a wrong answer is a misread and the review
 *                 form is there to catch it.
 *
 *   estimateMeal() guesses at a plate of food. Portion size is not visible in a
 *                 photograph — it is inferred from whatever is in frame for
 *                 scale — so every number is an opinion. It comes back with a
 *                 confidence and a caveat, and both are shown, because a
 *                 calorie total with no error bars reads as a measurement.
 *
 * Both go through the Edge Function, which holds the Gemini key.
 */

import { supabase } from './supabase.js';

// A phone camera hands back 12 megapixels. Base64 inflates by a third on top of
// that, so an untouched photo is several megabytes uploaded over a phone
// connection before anything can happen. Labels get more pixels than plates
// because small print has to survive; a plate only needs to be recognisable.
const LABEL_EDGE = 1600;
const MEAL_EDGE = 1280;
const QUALITY = 0.85;

/** @returns {Promise<{draft: object, missing: string[]}>} */
export async function readLabel(file) {
  return send('label', file, LABEL_EDGE);
}

/**
 * `note` is what the photo can't show — "made with Greek yogurt", "from Cafe
 * Rio" — and goes to the model as fact about the dish.
 *
 * @returns {Promise<{items: object[], confidence: string, note: string|null}>}
 */
export async function estimateMeal(file, note = '') {
  return send('meal', file, MEAL_EDGE, note);
}

/**
 * No photo at all — the meal already eaten and gone, in words. Same estimate
 * shape as estimateMeal, so it lands in the same review sheet.
 *
 * @returns {Promise<{items: object[], confidence: string, note: string|null}>}
 */
export async function describeMeal(description) {
  const text = (description ?? '').trim();
  if (!text) throw new Error('Describe what you ate first.');
  if (!navigator.onLine) throw new Error('Estimating a meal needs a connection.');

  const { data, error } = await supabase.functions.invoke('read-food-photo', {
    body: { mode: 'describe', description: text },
  });

  if (error) throw new Error(error.message ?? String(error));
  if (data?.error) throw new Error(data.error);

  return data;
}

async function send(mode, file, maxEdge, note = '') {
  if (!file) throw new Error('No photo selected.');
  if (!navigator.onLine) throw new Error('Reading a photo needs a connection.');

  const image = await downscale(file, maxEdge);
  const body = { mode, images: [image] };
  if (note.trim()) body.note = note.trim();

  const { data, error } = await supabase.functions.invoke('read-food-photo', { body });

  // A thrown FunctionsHttpError has already lost the response body, so the
  // function returns readable failures as 200 with an `error` field instead.
  if (error) throw new Error(error.message ?? String(error));
  if (data?.error) throw new Error(data.error);

  return data;
}

/**
 * Shrink to fit `maxEdge` and re-encode as JPEG.
 *
 * Never upscales: a small photo stays as it is rather than being blown up into
 * a bigger file with no more detail in it.
 */
async function downscale(file, maxEdge) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
  return {
    imageBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mimeType: 'image/jpeg',
  };
}

// ---- portions ----------------------------------------------------------------
//
// The estimate's portion is the model's guess at what was on the plate, and the
// eater usually knows better: it was half the bowl, or seconds. Each item keeps
// the model's numbers for one of its portions and a `servings` multiplier, which
// is also what gets logged as the quantity — so the entry reads "1.5 serving"
// and can be adjusted again later like any other.

export const PORTION_STEP = 0.25;
export const PORTION_MIN = 0.25;
export const PORTION_MAX = 5;

const MACROS = ['calories', 'protein_g', 'carbs_g', 'fat_g'];

export function servingsOf(item) {
  const n = Number(item?.servings);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** One quarter-portion up or down, kept between a quarter and five. */
export function stepPortion(servings, direction) {
  const next = Math.round((Number(servings) || 1) / PORTION_STEP + direction) * PORTION_STEP;
  return Math.min(PORTION_MAX, Math.max(PORTION_MIN, next));
}

/** "×1½", "×¾", "×2". */
export function portionLabel(servings) {
  const n = Number(servings) || 1;
  const whole = Math.floor(n);
  const part = { 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((n - whole) * 100) / 100] ?? '';
  return `×${whole || !part ? whole : ''}${part}`;
}

/** The item's numbers at the portion chosen. A missing macro stays missing. */
export function scaledItem(item) {
  const by = servingsOf(item);
  const out = { ...item };
  for (const key of MACROS) {
    out[key] = item[key] == null ? null : Math.round(Number(item[key]) * by);
  }
  return out;
}

/** Totals for a set of estimated items, at their chosen portions, for the headline. */
export function mealTotals(items) {
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const item of items ?? []) {
    const by = servingsOf(item);
    for (const key of Object.keys(totals)) totals[key] += (Number(item[key]) || 0) * by;
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key]);
  return totals;
}
