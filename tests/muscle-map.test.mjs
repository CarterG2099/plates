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

// ---- generated art ---------------------------------------------------------

test('artSlug matches the filenames in exercise-art.md', () => {
  assert.equal(mm.artSlug('Bench Press (Barbell)'), 'bench-press-barbell');
  assert.equal(mm.artSlug('Lat Pulldown - Close Grip (Cable)'), 'lat-pulldown-close-grip-cable');
  assert.equal(mm.artSlug('T Bar Row'), 't-bar-row');
  assert.equal(mm.artSlug('21s Bicep Curl'), '21s-bicep-curl');
  assert.equal(mm.artSlug('Chin-Up'), 'chin-up');
});

test('artSlug never leaves a leading or trailing separator', () => {
  assert.equal(mm.artSlug('  Squat (Barbell)  '), 'squat-barbell');
  assert.equal(mm.artSlug('!!!'), '');
  assert.equal(mm.artSlug(''), '');
  assert.equal(mm.artSlug(null), '');
});

test('exerciseArt renders the figure and layers the image over it', () => {
  const html = mm.exerciseArt(null, 'Bench Press (Barbell)');
  assert.match(html, /<svg/, 'the figure must be present as the fallback');
  assert.match(html, /src="\/img\/exercises\/t\/bench-press-barbell\.png"/,
    'lists use the 128px thumbnail — the 512px original decoding late is what made the figure flash first');
  assert.match(html, /decoding="sync"/, 'a cached thumbnail must paint in the same frame as the figure');
  assert.equal(html.includes('loading="lazy"'), false,
    'x-html rebuilds the img on every re-render, so lazy meant a visible late pop-in each time');
  assert.match(html, /onerror="this\.remove\(\)"/, 'a missing file must fall back, not 404 visibly');
});

// Every thumbnail must exist for every full-size drawing, or the list falls
// back to the figure for an exercise that has art. tools/art.mjs writes both
// sizes on every command; this catches a file added by hand.
test('every full-size drawing has its 128px thumbnail and a manifest entry', async () => {
  const fs = await import('node:fs');
  // Sorted as slugs, not filenames — "-" and "." order differently, and the
  // manifest holds slugs.
  const slugsIn = (dir) => fs.readdirSync(dir)
    .filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort();
  const full = slugsIn('docs/img/exercises');
  const thumbs = slugsIn('docs/img/exercises/t');
  assert.deepEqual(thumbs, full, 'run `node tools/art.mjs thumbs` to backfill');

  const manifest = JSON.parse(fs.readFileSync('docs/img/exercises/t/manifest.json', 'utf8'));
  assert.deepEqual(manifest, full,
    'the service worker warms from the manifest, so a stale one leaves new drawings cold');
});

test('exerciseArt falls back to the figure alone when there is no name', () => {
  const html = mm.exerciseArt(null, '');
  assert.match(html, /<svg/);
  assert.equal(html.includes('<img'), false);
});

test('exerciseArt prefers the exercise row name over the passed name', () => {
  const html = mm.exerciseArt({ name: 'Squat (Barbell)' }, 'ignored');
  assert.match(html, /squat-barbell\.png/);
});

test('exerciseArtPair layers the image over the front/back pair', () => {
  const html = mm.exerciseArtPair(null, 'Bench Press (Barbell)');
  assert.match(html, /FRONT/, 'the pair must still be the fallback');
  assert.match(html, /BACK/);
  assert.match(html, /src="\/img\/exercises\/bench-press-barbell\.png"/);
});

// The overlay trick the thumbnails use does not work on a wide canvas, so the
// pair is hidden on load instead. Without the onload the drawing never shows;
// without the onerror an exercise with no drawing shows a broken image.
test('exerciseArtPair hides the pair only once the drawing has loaded', () => {
  const html = mm.exerciseArtPair(null, 'Bench Press (Barbell)');
  assert.match(html, /onload="this\.parentElement\.classList\.add\('has-art'\)"/);
  assert.match(html, /onerror="this\.remove\(\)"/);
});

test('exerciseArtPair falls back to the pair alone when there is no name', () => {
  const html = mm.exerciseArtPair(null, '');
  assert.match(html, /FRONT/);
  assert.equal(html.includes('<img'), false);
});

test('exerciseArtPair prefers the exercise row name over the passed name', () => {
  const html = mm.exerciseArtPair({ name: 'Squat (Barbell)' }, 'ignored');
  assert.match(html, /squat-barbell\.png/);
});
