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

/** @returns {Promise<{items: object[], confidence: string, note: string|null}>} */
export async function estimateMeal(file) {
  return send('meal', file, MEAL_EDGE);
}

async function send(mode, file, maxEdge) {
  if (!file) throw new Error('No photo selected.');
  if (!navigator.onLine) throw new Error('Reading a photo needs a connection.');

  const image = await downscale(file, maxEdge);

  const { data, error } = await supabase.functions.invoke('read-food-photo', {
    body: { mode, images: [image] },
  });

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

/** Totals for a set of estimated items, for the sheet's headline figure. */
export function mealTotals(items) {
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const item of items ?? []) {
    for (const key of Object.keys(totals)) totals[key] += Number(item[key]) || 0;
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key]);
  return totals;
}
