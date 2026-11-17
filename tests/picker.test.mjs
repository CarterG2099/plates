/**
 * Ticking several exercises in the picker and adding them all at once, to
 * whatever opened it: the workout, or the routine being built. Driven through
 * the real Train screen in app.js. Replacing an exercise stays one tap.
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
const BENCH = { id: 'ex-bench', name: 'Bench Press' };
const FLY = { id: 'ex-fly', name: 'Cable Fly' };
const PUSHDOWN = { id: 'ex-push', name: 'Triceps Pushdown' };

async function train({ session = true } = {}) {
  reset();
  navigator.onLine = false;   // the sync nudge after each write stays out of it
  Alpine.store('auth').session = { user: { email: ME } };
  for (const e of [BENCH, FLY, PUSHDOWN]) await local.save('exercises', { ...e, owner_email: null }, ME);
  if (session) {
    await local.save('sessions', { name: 'Push', started_at: '2026-11-16T10:00:00.000Z', ended_at: null }, ME);
  }
  await Alpine.store('data').refreshTraining();
  return Alpine.reactive(components.trainPage());
}

test('rows tick and untick, in the order ticked, and the button counts them', async () => {
  const page = await train();
  page.openPicker();
  assert.equal(page.pickedLabel, 'Add exercises to workout');

  page.togglePick(FLY);
  page.togglePick(BENCH);
  assert.equal(page.isPicked(FLY), true);
  assert.deepEqual(page.picked.map((e) => e.id), ['ex-fly', 'ex-bench']);
  assert.equal(page.pickedLabel, 'Add 2 exercises to workout');

  page.togglePick(FLY);
  assert.deepEqual(page.picked.map((e) => e.id), ['ex-bench']);
  assert.equal(page.pickedLabel, 'Add 1 exercise to workout');
});

test('a tick survives a search that hides it', async () => {
  const page = await train();
  page.openPicker();
  page.togglePick(BENCH);
  page.pickerTerm = 'fly';
  assert.ok(!page.library.some((e) => e.id === BENCH.id), 'hidden by the search');
  assert.equal(page.picked.length, 1);
});

test('adding puts every ticked exercise in the workout, in order, each with its opening sets', async () => {
  const page = await train();
  page.openPicker();
  page.togglePick(FLY);
  page.togglePick(BENCH);
  await page.addPicked();

  assert.equal(page.picker, false, 'the picker closes');
  assert.deepEqual(page.picked, [], 'and forgets the ticks');
  const sets = page.sets.slice().sort((a, b) => a.set_index - b.set_index);
  assert.equal(sets.length, 2 * workout.DEFAULT_SETS);
  assert.deepEqual(sets.map((s) => s.set_index), [0, 1, 2, 3, 4, 5], 'one index each, none repeated');
  assert.deepEqual(sets.map((s) => s.exercise_id),
    ['ex-fly', 'ex-fly', 'ex-fly', 'ex-bench', 'ex-bench', 'ex-bench']);
});

test('from the routine builder, they go into the routine after what is there', async () => {
  const page = await train({ session: false });
  page.newRoutine();
  page.builder.name = 'Push day';
  await page.saveRoutineName();
  await workout.addRoutineExercise({ routineId: page.builder.routine.id, exercise: PUSHDOWN, position: 0, ownerEmail: ME });
  await Alpine.store('data').refreshTraining();

  page.openPicker();
  assert.equal(page.pickedLabel, 'Add exercises to routine');
  page.togglePick(BENCH);
  page.togglePick(FLY);
  await page.addPicked();

  assert.equal(page.picker, false);
  assert.deepEqual(page.builderExercises.map((row) => [row.name, row.item.position]),
    [['Triceps Pushdown', 0], ['Bench Press', 1], ['Cable Fly', 2]]);
});

test('nothing ticked adds nothing', async () => {
  const page = await train();
  page.openPicker();
  await page.addPicked();
  assert.equal(page.sets.length, 0);
  assert.equal(page.picker, true, 'stays open');
});

test('closing or reopening the picker forgets the ticks', async () => {
  const page = await train();
  page.openPicker();
  page.togglePick(BENCH);
  page.closePicker();
  page.openPicker();
  assert.deepEqual(page.picked, []);
});

// ---- markup -----------------------------------------------------------------------

const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');
const picker = html.slice(html.indexOf('<template x-if="picker">'), html.indexOf('<!-- Overflow menu'));

test('a row ticks when adding and still replaces in one tap', () => {
  assert.match(picker, /@click="replacing \? applyReplace\(e\) : togglePick\(e\)"/);
  assert.match(picker, /:aria-pressed="replacing \? null : String\(isPicked\(e\)\)"/);
  assert.match(picker, /:class="isPicked\(e\) && 'is-picked'"/);
});

test('one button adds them, hidden while replacing, and Cancel stays a direct child for the keyboard rule', () => {
  assert.match(picker, /<button class="btn btn-primary btn-block" x-show="!replacing"\s+:disabled="!picked\.length" @click="addPicked\(\)" x-text="pickedLabel"><\/button>\s*<button class="btn btn-ghost btn-block" @click="closePicker\(\)">Cancel<\/button>\s*<\/div>\s*<\/div>/);
});
