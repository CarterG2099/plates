/**
 * The bars beside protein, carbs and fat in the amount sheet: each macro's
 * share of the food's calories, so a glance says what kind of food it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const food = await import('../docs/js/food.js');

const TURKEY = {
  id: 't', name: 'Turkey breast', brand: 'Green Farm', serving_qty: 1, serving_unit: 'serving',
  calories: 45, protein_g: 7.8, carbs_g: 0.3, fat_g: 1.2,
};

test('each macro\'s share of the calories, from 4, 4 and 9 kcal a gram', () => {
  // 31.2 + 1.2 + 10.8 = 43.2 kcal from the macros.
  assert.deepEqual(food.calorieShare(TURKEY), { protein_g: 72, carbs_g: 3, fat_g: 25 });
});

test('fat counts for more than its grams', () => {
  assert.deepEqual(food.calorieShare({ protein_g: 10, carbs_g: 0, fat_g: 10 }), { protein_g: 31, carbs_g: 0, fat_g: 69 });
});

test('an unknown macro adds nothing, and a food with none is all empty bars', () => {
  assert.deepEqual(food.calorieShare({ protein_g: 5, carbs_g: null, fat_g: undefined }), { protein_g: 100, carbs_g: 0, fat_g: 0 });
  assert.deepEqual(food.calorieShare({}), { protein_g: 0, carbs_g: 0, fat_g: 0 });
  assert.deepEqual(food.calorieShare(), { protein_g: 0, carbs_g: 0, fat_g: 0 });
});

test('the share is the same at any amount, since it describes the food', () => {
  Alpine.store('auth').session = { user: { email: 'me@example.com' } };
  const log = Alpine.reactive(components.logPage());
  log.openSheet(TURKEY);
  const one = { ...log.sheetShare };
  log.step(1);
  log.step(1);
  assert.deepEqual(log.sheetShare, one);
  assert.deepEqual(one, { protein_g: 72, carbs_g: 3, fat_g: 25 });
});

test('the closed sheet hands its bars an empty share rather than throwing', () => {
  const log = Alpine.reactive(components.logPage());
  assert.deepEqual(log.sheetShare, { protein_g: 0, carbs_g: 0, fat_g: 0 });
});

test('each macro row in the amount sheet draws its share', async () => {
  const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');
  const sheet = html.slice(html.indexOf('<!-- Quantity sheet'), html.indexOf('confirmSheet()'));
  assert.match(sheet, /<span class="macro-bar"[^>]*><i\s+:style="`background: \$\{m\.color\}; width: \$\{sheetShare\[m\.key\]\}%`"><\/i><\/span>/);
});
