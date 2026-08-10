import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const mm = await import('../docs/js/muscle-map.js');
const photo = await import('../docs/js/photo.js');

// ---- movement classification -----------------------------------------------

test('a lift is classified by name when the exercise carries no data', () => {
  for (const name of ['Bench Press (Barbell)', 'Squat (Barbell)', 'Deadlift', 'Overhead Press']) {
    const movement = mm.movementFor(null, name);
    assert.ok(movement, `${name} should map to a movement`);
  }
});

test('an unknown exercise has no movement archetype, and says so', () => {
  // null is the honest answer — there is no archetype for it. The fallback
  // belongs in muscleMap, which must still draw a figure either way.
  assert.equal(mm.movementFor(null, 'Underwater Basket Weaving'), null);
  assert.match(mm.muscleMap(null, 'Underwater Basket Weaving'), /<svg/);
});

test('classification is case-insensitive', () => {
  assert.deepEqual(mm.movementFor(null, 'BENCH PRESS'), mm.movementFor(null, 'bench press'));
});

test('muscleFor picks a primary muscle for the common lifts', () => {
  assert.ok(mm.muscleFor(null, 'Bench Press (Barbell)'));
  assert.ok(mm.muscleFor(null, 'Barbell Curl'));
  assert.ok(mm.muscleFor(null, 'Squat (Barbell)'));
});

test('an exercise row beats the name when both are present', () => {
  const withData = { primary_muscle: 'chest', name: 'Mystery Lift' };
  assert.ok(mm.muscleFor(withData, 'Mystery Lift'));
});

// ---- rendering -------------------------------------------------------------

test('muscleMap returns SVG markup', () => {
  const svg = mm.muscleMap(null, 'Bench Press (Barbell)');
  assert.equal(typeof svg, 'string');
  assert.match(svg, /<svg/);
  assert.match(svg, /<\/svg>/);
});

test('muscleMap never returns the literal string "undefined"', () => {
  // This shipped once: a stale cached bundle rendered `undefined` into every row.
  for (const name of ['Bench Press', '', 'Nonsense Exercise', 'Squat']) {
    const svg = mm.muscleMap(null, name);
    assert.equal(svg.includes('undefined'), false, `"${name}" produced undefined`);
    assert.equal(svg.includes('[object Object]'), false);
  }
});

test('muscleMap handles a null exercise and an empty name', () => {
  assert.match(mm.muscleMap(null, ''), /<svg/);
  assert.match(mm.muscleMap(undefined, undefined), /<svg/);
});

test('the paired view renders both figures', () => {
  const single = mm.muscleMap(null, 'Squat (Barbell)');
  const pair = mm.muscleMap(null, 'Squat (Barbell)', { both: true });
  assert.ok(pair.length > single.length, 'front and back should be larger than one figure');
});

test('the worked muscle is marked so CSS can animate it', () => {
  const svg = mm.muscleMap(null, 'Bench Press (Barbell)');
  assert.ok(svg.includes('mm-lit'), 'the lit class is what the pulse animation hooks onto');
});

test('markup is well-formed enough to have balanced tags', () => {
  const svg = mm.muscleMap(null, 'Deadlift (Barbell)');
  const open = (svg.match(/<g[\s>]/g) ?? []).length;
  const close = (svg.match(/<\/g>/g) ?? []).length;
  assert.equal(open, close, 'every <g> should be closed');
});

// ---- photo estimate totals -------------------------------------------------

test('mealTotals adds every item', () => {
  const totals = photo.mealTotals([
    { calories: 245, protein_g: 46, carbs_g: 0, fat_g: 5 },
    { calories: 205, protein_g: 4, carbs_g: 45, fat_g: 0 },
    { calories: 90, protein_g: 3, carbs_g: 7, fat_g: 6 },
  ]);
  assert.deepEqual(totals, { calories: 540, protein_g: 53, carbs_g: 52, fat_g: 11 });
});

test('mealTotals of nothing is zeros, not NaN', () => {
  assert.deepEqual(photo.mealTotals([]), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  assert.deepEqual(photo.mealTotals(undefined), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
});

test('mealTotals treats missing macros as zero rather than poisoning the sum', () => {
  const totals = photo.mealTotals([
    { calories: 100 },
    { calories: 50, protein_g: null, carbs_g: undefined, fat_g: 'x' },
  ]);
  assert.equal(totals.calories, 150);
  assert.equal(Object.values(totals).every(Number.isFinite), true);
});
