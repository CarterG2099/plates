/**
 * Plate maths for every exercise that takes plates, not only a barbell: a
 * Smith bar weighs 20 lb, a plate-loaded machine starts at 0 until you say
 * what its sled weighs, and either can be changed per person from the
 * exercise sheet. Driven through the real Train screen where it shows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/app.mjs';
import { reset } from './helpers/fake-idb.mjs';

const { Alpine, components } = await loadApp();
const local = await import('../docs/js/local.js');
const workout = await import('../docs/js/workout.js');

const ME = 'me@example.com';
const HER = 'her@example.com';

// Names and equipment as they sit in the real library, wrong fields and all.
const SMITH = { id: 'ex-smith', name: 'Seated Shoulder Press (Smith Machine)', equipment: 'machine' };
const BENCH = { id: 'ex-bench', name: 'Bench Press (Barbell)', equipment: 'barbell' };
const LEG_CURL = { id: 'ex-curl', name: 'Lying Leg Curl', equipment: 'machine' };
const ISO_ROW = { id: 'ex-iso', name: 'Iso-Lateral Row (Machine)', equipment: null };

// ---- the defaults --------------------------------------------------------------

test('a Smith bar is 20 lb, a barbell 45, a plate machine 0', () => {
  assert.deepEqual(workout.plateDefault(SMITH), { loadsPlates: true, startLb: 20, what: 'Smith bar' });
  assert.deepEqual(workout.plateDefault(BENCH), { loadsPlates: true, startLb: 45, what: 'bar' });
  for (const name of ['Leg Press', 'Leg Press Horizontal (Machine)', 'Hack Squat (Machine)',
    'Iso-Lateral Row (Machine)', 'Iso-Lateral Low Row', 'Hip Thrust (Machine)', 'Single Leg Press (Machine)']) {
    assert.deepEqual(workout.plateDefault({ name }), { loadsPlates: true, startLb: 0, what: 'machine' }, name);
  }
});

test('the name decides, not the equipment field the import got wrong', () => {
  assert.equal(workout.plateDefault({ name: 'Shoulder Press (Machine Plates)', equipment: 'bands' }).loadsPlates, true);
  assert.equal(workout.plateDefault({ name: 'Seated Shoulder Press (Machine)', equipment: 'barbell' }).loadsPlates, false);
});

test('pin-stack machines, dumbbells and cables take no plates by default', () => {
  for (const e of [LEG_CURL, { name: 'Chest Fly (Machine)' }, { name: 'Leg Extension', equipment: 'machine' },
    { name: 'Incline Bench Press (Dumbbell)', equipment: 'machine' }, { name: 'Triceps Pushdown (Cable)' }]) {
    assert.equal(workout.plateDefault(e).loadsPlates, false, e.name);
  }
});

// ---- yours over the default ------------------------------------------------------

test('your row overrides either half; nothing set is the default; hers is not yours', () => {
  const notes = [
    { exercise_id: SMITH.id, owner_email: HER, loads_plates: false, start_weight_lb: 35 },
  ];
  assert.deepEqual(
    { ...workout.plateSetup(notes, ME, SMITH), fallback: undefined },
    { loadsPlates: true, startLb: 20, custom: false, fallback: undefined },
  );

  notes.push({ exercise_id: SMITH.id, owner_email: ME, loads_plates: null, start_weight_lb: 25, notes: 'seat 4' });
  const mine = workout.plateSetup(notes, ME, SMITH);
  assert.equal(mine.loadsPlates, true, 'unset switch keeps the default');
  assert.equal(mine.startLb, 25);
  assert.equal(mine.custom, true);

  notes.push({ exercise_id: LEG_CURL.id, owner_email: ME, loads_plates: true, start_weight_lb: null });
  assert.equal(workout.plateSetup(notes, ME, LEG_CURL).loadsPlates, true);
});

test('a starting weight of 0 is kept, not mistaken for unset', () => {
  const notes = [{ exercise_id: SMITH.id, owner_email: ME, start_weight_lb: 0 }];
  assert.equal(workout.plateSetup(notes, ME, SMITH).startLb, 0);
});

test('turning only the switch counts as changed, so Reset shows', () => {
  const notes = [{ exercise_id: LEG_CURL.id, owner_email: ME, loads_plates: true, start_weight_lb: null }];
  assert.equal(workout.plateSetup(notes, ME, LEG_CURL).custom, true);
});

test('a deleted row counts for nothing', () => {
  const notes = [{ exercise_id: SMITH.id, owner_email: ME, start_weight_lb: 30, deleted_at: 'x' }];
  assert.equal(workout.plateSetup(notes, ME, SMITH).startLb, 20);
});

test('a typed starting weight: blank is the default, 0 to 500 is fine, the rest is refused', () => {
  assert.equal(workout.cleanStartWeight(''), null);
  assert.equal(workout.cleanStartWeight('  '), null);
  assert.equal(workout.cleanStartWeight('0'), 0);
  assert.equal(workout.cleanStartWeight('22.5'), 22.5);
  assert.equal(workout.cleanStartWeight('500'), 500);
  assert.equal(workout.cleanStartWeight('-5'), undefined);
  assert.equal(workout.cleanStartWeight('501'), undefined);
  assert.equal(workout.cleanStartWeight('abc'), undefined);
});

test('plate maths takes the starting weight off before splitting', () => {
  assert.deepEqual(workout.plateMath(110, 20).plates, [45], 'Smith: 45 a side');
  assert.deepEqual(workout.plateMath(180, 0).plates, [45, 45], 'iso-lateral logged for both arms: 90 an arm');
});

test('saving keeps the note, updates the one row, and reset puts both back', async () => {
  reset();
  navigator.onLine = false;
  const note = await workout.setExerciseNotes(SMITH, 'seat 4', ME, []);
  const first = await workout.setPlateSetup(SMITH, { start_weight_lb: 25 }, ME, [note]);
  assert.equal(first.id, note.id, 'the same row, not a second one');
  assert.equal(first.notes, 'seat 4');

  const off = await workout.setPlateSetup(SMITH, { loads_plates: false }, ME, [first]);
  assert.equal(off.start_weight_lb, 25, 'one half changed, the other kept');

  const back = await workout.setPlateSetup(SMITH, { loads_plates: null, start_weight_lb: null }, ME, [off]);
  assert.equal(workout.plateSetup([back], ME, SMITH).custom, false);
  assert.equal(back.notes, 'seat 4');
  assert.equal((await local.all('exercise_notes')).length, 1);
});

// ---- on the Train screen ---------------------------------------------------------

async function train() {
  reset();
  navigator.onLine = false;
  Alpine.store('auth').session = { user: { email: ME } };
  for (const e of [SMITH, BENCH, LEG_CURL, ISO_ROW]) await local.save('exercises', { ...e, owner_email: null }, ME);
  await Alpine.store('data').refreshTraining();
  return Alpine.reactive(components.trainPage());
}

const sizes = (page, ex, lb) => page.plateGroups({ exerciseId: ex.id, name: ex.name }, { weight_lb: lb }, 0)
  .map((g) => (g.count > 1 ? `${g.size}x${g.count}` : String(g.size)));

test('each set shows plates after the bar or sled it is on', async () => {
  const page = await train();
  assert.deepEqual(sizes(page, SMITH, 110), ['45']);
  assert.deepEqual(sizes(page, BENCH, 225), ['45x2']);
  assert.deepEqual(sizes(page, ISO_ROW, 180), ['45x2']);
  assert.deepEqual(sizes(page, LEG_CURL, 100), [], 'a pin stack gets none');
});

test('changing it in the exercise sheet changes the chips, and reset undoes it', async () => {
  const page = await train();
  page.openExercise(SMITH.id, SMITH.name);
  assert.equal(page.detailPlates.usual, 'Default: 20 lb Smith bar');

  await page.setDetailStart('30');
  assert.equal(page.detailPlates.startLb, 30);
  assert.deepEqual(sizes(page, SMITH, 110), ['35', '5']);

  await page.setDetailStart('-1');
  assert.equal(page.detailPlates.startLb, 30, 'refused, left as it was');

  await page.setDetailPlates({ loads_plates: false });
  assert.deepEqual(sizes(page, SMITH, 110), []);

  await page.resetDetailPlates();
  assert.equal(page.detailPlates.custom, false);
  assert.deepEqual(sizes(page, SMITH, 110), ['45']);
});

test('a machine switched on starts at the plates only until its sled is set', async () => {
  const page = await train();
  page.openExercise(LEG_CURL.id, LEG_CURL.name);
  assert.equal(page.detailPlates.usual, 'Off by default');
  await page.setDetailPlates({ loads_plates: true });
  assert.deepEqual(sizes(page, LEG_CURL, 100), ['45', '5']);

  page.openExercise(ISO_ROW.id, ISO_ROW.name);
  assert.equal(page.detailPlates.usual, 'Default: the plates only');
});

// ---- markup ------------------------------------------------------------------------

const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');

test('the sheet has the switch, the starting weight and reset, for real lifts only', () => {
  const at = html.indexOf('<div class="plate-setup"');
  assert.ok(at !== -1);
  const block = html.slice(at, html.indexOf('Reset to default', at));
  assert.match(block, /x-show="detail\.exercise\.id && !detailIsCardio"/);
  assert.match(block, /:checked="detailPlates\.loadsPlates"\s+@change="setDetailPlates\(\{ loads_plates: \$el\.checked \}\)"/);
  assert.match(block, /x-text="detailPlates\.usual"/);
  assert.match(block, /<div class="field" x-show="detailPlates\.loadsPlates">/);
  assert.match(block, /:value="detailPlates\.startLb"\s+@change="setDetailStart\(\$event\.target\.value\)"/);
  assert.match(html.slice(at, at + 2000), /x-show="detailPlates\.custom"\s+@click="resetDetailPlates\(\)">Reset to default/);
});
