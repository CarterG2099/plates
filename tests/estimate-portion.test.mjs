/**
 * Adjusting the portions of an AI meal estimate before logging it, driven
 * through the real log panel in app.js.
 *
 * The model's portion is its guess at the plate; the eater knows it was half
 * the bowl, or seconds. Each item steps by quarters, the totals follow, and the
 * multiplier is what gets logged as the quantity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/app.mjs';
import { reset } from './helpers/fake-idb.mjs';

const { Alpine, components } = await loadApp();
const local = await import('../docs/js/local.js');
const photo = await import('../docs/js/photo.js');

const ME = 'me@example.com';

function panelWithEstimate() {
  reset();
  navigator.onLine = false;
  Alpine.store('auth').session = { user: { email: ME } };
  const log = Alpine.reactive(components.logPage());
  log.estimate = {
    items: [
      { name: 'Baked potato', portion: '1 medium (about 220g)', calories: 210, protein_g: 5, carbs_g: 47, fat_g: 0 },
      { name: 'Lentil soup', portion: 'about 1/2 cup', calories: 95, protein_g: 7, carbs_g: 16, fat_g: null },
    ],
    confidence: 'medium',
    note: null,
  };
  return log;
}

test('an estimate opens at the portions the model guessed', () => {
  const log = panelWithEstimate();
  assert.equal(log.portionLabel(log.estimate.items[0]), '×1');
  assert.equal(log.estimateTotals.calories, 305);
});

test('stepping a portion scales that item and the totals', () => {
  const log = panelWithEstimate();
  log.stepEstimateItem(1, 1);
  log.stepEstimateItem(1, 1);

  assert.equal(log.portionLabel(log.estimate.items[1]), '×1½');
  assert.equal(log.estimateItemLine(log.estimate.items[1]), '≈143 kcal · P11 C24 F—');
  assert.deepEqual(log.estimateTotals, { calories: 353, protein_g: 16, carbs_g: 71, fat_g: 0 });
  assert.equal(log.estimateItemLine(log.estimate.items[0]), '≈210 kcal · P5 C47 F0', 'the other item is untouched');
});

test('the portion is logged as the quantity, with the macros scaled to it', async () => {
  const log = panelWithEstimate();
  log.stepEstimateItem(0, -1);
  log.stepEstimateItem(0, -1);   // half the potato
  log.stepEstimateItem(1, 1);    // and a bit more soup
  await log.logEstimate();

  const rows = (await local.all('food_log')).filter((r) => r.owner_email === ME);
  const potato = rows.find((r) => r.description.startsWith('Baked potato'));
  const soup = rows.find((r) => r.description.startsWith('Lentil soup'));

  assert.equal(potato.quantity, 0.5);
  assert.equal(potato.calories, 105);
  assert.equal(potato.carbs_g, 23.5);
  assert.equal(soup.quantity, 1.25);
  assert.equal(soup.protein_g, 8.8);   // logged amounts keep one decimal
  assert.equal(soup.fat_g, null, 'a macro the model never gave is not logged as zero');
});

// ---- the stepping itself ----------------------------------------------------

test('portions step by quarters between a quarter and five', () => {
  assert.equal(photo.stepPortion(1, 1), 1.25);
  assert.equal(photo.stepPortion(1, -1), 0.75);
  assert.equal(photo.stepPortion(0.25, -1), 0.25);
  assert.equal(photo.stepPortion(5, 1), 5);
  let n = 1;
  for (let i = 0; i < 7; i++) n = photo.stepPortion(n, 1);
  assert.equal(n, 2.75, 'no floating-point drift after many steps');
});

test('a portion reads as a fraction of the guess', () => {
  assert.deepEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.75].map(photo.portionLabel),
    ['×¼', '×½', '×¾', '×1', '×1¼', '×1½', '×2', '×2¾']);
});

test('an item with no portion set counts as one', () => {
  assert.equal(photo.servingsOf({}), 1);
  assert.equal(photo.servingsOf({ servings: 0 }), 1);
  assert.deepEqual(photo.mealTotals([{ calories: 100, protein_g: 10, servings: 2 }, { calories: 50 }]),
    { calories: 250, protein_g: 20, carbs_g: 0, fat_g: 0 });
});
