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

test('a food is high protein at 40% of its calories from protein, not below', () => {
  assert.equal(food.isHighProtein(TURKEY), true);
  // 10 g protein, 15 g carbs: 40 of 100 kcal.
  assert.equal(food.isHighProtein({ protein_g: 10, carbs_g: 15, fat_g: 0 }), true);
  // 10 g protein, 16 g carbs: 38%.
  assert.equal(food.isHighProtein({ protein_g: 10, carbs_g: 16, fat_g: 0 }), false);
  // Peanut butter: plenty of grams of protein, but fat carries the calories.
  assert.equal(food.isHighProtein({ protein_g: 7, carbs_g: 7, fat_g: 16 }), false);
  assert.equal(food.isHighProtein({}), false);
});

test('the amount sheet tags a high-protein food and leaves others alone', () => {
  Alpine.store('auth').session = { user: { email: 'me@example.com' } };
  const log = Alpine.reactive(components.logPage());
  assert.equal(log.sheetHighProtein, false, 'closed');
  log.openSheet(TURKEY);
  assert.equal(log.sheetHighProtein, true);
  log.closeSheet();
  log.openSheet({ ...TURKEY, id: 'pb', name: 'Peanut butter', protein_g: 7, carbs_g: 7, fat_g: 16 });
  assert.equal(log.sheetHighProtein, false);
});

test('the tag sits under the food\'s name in the amount sheet', async () => {
  const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');
  const sheet = html.slice(html.indexOf('<!-- Quantity sheet'), html.indexOf('confirmSheet()'));
  assert.match(sheet, /<span class="tag-high-protein" x-show="sheetHighProtein">High protein<\/span>/);
});

// The same food once it is logged: tapping the entry on Today opens the edit
// sheet, which reads the entry's own snapshot rather than the food.
const LOGGED_TURKEY = {
  id: 'e', food_id: null, description: 'Turkey breast (Green Farm)', quantity: 2, unit: 'serving',
  calories: 90, protein_g: 15.6, carbs_g: 0.6, fat_g: 2.4,
};

test('a logged entry\'s sheet shows the same bars and tag as before it was logged', () => {
  Alpine.store('auth').session = { user: { email: 'me@example.com' } };
  const today = Alpine.reactive(components.todayPage());
  assert.deepEqual(today.editShare, { protein_g: 0, carbs_g: 0, fat_g: 0 }, 'closed');
  assert.equal(today.editHighProtein, false, 'closed');

  today.openEdit(LOGGED_TURKEY);
  assert.deepEqual(today.editShare, { protein_g: 72, carbs_g: 3, fat_g: 25 });
  assert.equal(today.editHighProtein, true);

  today.closeEdit();
  today.openEdit({ ...LOGGED_TURKEY, id: 'pb', description: 'Peanut butter', protein_g: 7, carbs_g: 7, fat_g: 16 });
  assert.equal(today.editHighProtein, false);
});

test('the logged entry\'s sheet draws the bars and the tag', async () => {
  const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');
  const sheet = html.slice(html.indexOf('<!-- Edit a logged amount'), html.indexOf('saveEdit()'));
  assert.match(sheet, /<span class="tag-high-protein" x-show="editHighProtein">High protein<\/span>/);
  assert.match(sheet, /<span class="macro-bar"[^>]*><i\s+:style="`background: \$\{m\.color\}; width: \$\{editShare\[m\.key\]\}%`"><\/i><\/span>/);
});
