/**
 * workout.js — the training domain.
 *
 * Heavy on the exercise-card operations, because those renumber set_index across
 * a whole session and an off-by-one there silently reorders somebody's workout.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();

const local = await import('../docs/js/local.js');
const workout = await import('../docs/js/workout.js');

const ME = 'c@x';
const SESSION = { id: 'w1', owner_email: ME };

beforeEach(() => local.wipe());

/** Seed a session directly, so tests state their own starting shape. */
async function seedSets(specs) {
  const made = [];
  for (const [i, spec] of specs.entries()) {
    made.push(await local.save('session_sets', {
      session_id: 'w1',
      exercise_id: spec.id ?? null,
      exercise_name: spec.name,
      set_index: i,
      weight_lb: spec.weight ?? 100,
      reps: spec.reps ?? 5,
      is_warmup: spec.warmup ?? false,
      completed_at: spec.done ?? null,
    }, ME));
  }
  return made;
}

const liveSets = async () => workout.setsForSession(await local.all('session_sets'), 'w1');
const cards = async () => workout.groupByExercise(await liveSets()).map((g) => [g.name, g.sets.length]);
const groupNamed = async (key) => workout.groupByExercise(await liveSets()).find((g) => g.key === key);

// ---- updateSet: the reps-blanking lost update --------------------------------

test('reps typed just before the checkmark survive the check', async () => {
  // The real event order: `change` fires and saves the reps, then `click` fires
  // holding the set object as it was *before* the change. Spreading that stale
  // copy is what wrote the old reps back over the new ones.
  const [set] = await seedSets([{ id: 'bp', name: 'Bench', reps: null }]);

  await workout.updateSet(set, { reps: 10 });                 // change
  const after = await workout.updateSet(set, { completed_at: 'T' });  // click, stale copy

  assert.equal(after.reps, 10, 'the typed reps must not be reverted');
  assert.equal(after.completed_at, 'T');
  assert.equal(after.weight_lb, 100, 'untouched fields survive too');
});

test('updateSet edits in place rather than adding a row', async () => {
  const [set] = await seedSets([{ id: 'bp', name: 'Bench' }]);
  const saved = await workout.updateSet(set, { reps: 8 });

  assert.equal(saved.id, set.id);
  assert.equal((await liveSets()).length, 1);
});

// ---- replaceExercise ----------------------------------------------------------

test('swapping before you start moves the whole card', async () => {
  const sets = await seedSets([
    { id: 'row', name: 'Barbell Row' }, { id: 'row', name: 'Barbell Row' }, { id: 'row', name: 'Barbell Row' },
  ]);

  const moved = await workout.replaceExercise({
    session: SESSION,
    group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    prefill: { weight_lb: 50, reps: 12 },
    ownerEmail: ME,
    existingSets: sets,
  });

  assert.equal(moved.length, 3);
  assert.deepEqual(await cards(), [['Dumbbell Row', 3]]);
  assert.deepEqual([moved[0].weight_lb, moved[0].reps], [50, 12], 'prefilled from the new exercise');
  assert.deepEqual(moved.map((s) => s.set_index), [0, 1, 2], 'it stays where it was in the workout');
});

test('swapping halfway leaves the done sets on the exercise you actually did', async () => {
  const sets = await seedSets([
    { id: 'row', name: 'Barbell Row', weight: 135, reps: 10, done: 'T1' },
    { id: 'row', name: 'Barbell Row', weight: 135, reps: 10, done: 'T2' },
    { id: 'row', name: 'Barbell Row', weight: null, reps: null },
  ]);

  const moved = await workout.replaceExercise({
    session: SESSION,
    group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    prefill: { weight_lb: 50, reps: 12 },
    ownerEmail: ME,
    existingSets: sets,
  });

  assert.equal(moved.length, 1, 'only the unchecked set moves');
  assert.deepEqual(await cards(), [['Barbell Row', 2], ['Dumbbell Row', 1]],
    'it splits into two cards, in workout order');

  const kept = (await liveSets()).filter((s) => s.exercise_name === 'Barbell Row');
  assert.deepEqual(kept.map((s) => s.weight_lb), [135, 135], 'what was lifted is untouched');
  assert.deepEqual(kept.map((s) => s.completed_at), ['T1', 'T2'], 'and stays checked');
});

test('swapping a finished card gives one fresh set rather than doing nothing', async () => {
  const sets = await seedSets([{ id: 'row', name: 'Barbell Row', done: 'T1' }]);

  const made = await workout.replaceExercise({
    session: SESSION,
    group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    prefill: { weight_lb: 50, reps: 12 },
    ownerEmail: ME,
    existingSets: sets,
  });

  assert.equal(made.length, 1);
  assert.equal(made[0].exercise_name, 'Dumbbell Row');
  assert.equal(made[0].completed_at, null, 'a new set is not pre-checked');
  assert.deepEqual(await cards(), [['Barbell Row', 1], ['Dumbbell Row', 1]]);
});

// ---- reordering ---------------------------------------------------------------

test('orderGroups is pure list surgery and leaves its input alone', () => {
  const groups = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const keys = (gs) => gs.map((g) => g.key);

  assert.deepEqual(keys(workout.orderGroups(groups, 'a', 2)), ['b', 'c', 'a']);
  assert.deepEqual(keys(workout.orderGroups(groups, 'c', 0)), ['c', 'a', 'b']);
  assert.deepEqual(keys(workout.orderGroups(groups, 'b', 1)), ['a', 'b', 'c'], 'same slot is a no-op');
  assert.deepEqual(keys(workout.orderGroups(groups, 'a', 99)), ['b', 'c', 'a'], 'past the end clamps');
  assert.deepEqual(keys(workout.orderGroups(groups, 'a', -5)), ['a', 'b', 'c'], 'before the start clamps');
  assert.deepEqual(keys(workout.orderGroups(groups, 'zz', 0)), ['a', 'b', 'c'], 'unknown key changes nothing');
  assert.deepEqual(keys(groups), ['a', 'b', 'c']);
});

test('dragging a card to the front renumbers the session behind it', async () => {
  await seedSets([
    { id: 'sq', name: 'Squat' }, { id: 'sq', name: 'Squat' },
    { id: 'bp', name: 'Bench' }, { id: 'bp', name: 'Bench' },
    { id: 'dl', name: 'Deadlift' }, { id: 'dl', name: 'Deadlift' },
  ]);

  const ordered = workout.orderGroups(workout.groupByExercise(await liveSets()), 'dl', 0);
  await workout.reindexSets(ordered.flatMap((g) => g.sets));

  assert.deepEqual(await cards(), [['Deadlift', 2], ['Squat', 2], ['Bench', 2]]);
  assert.deepEqual((await liveSets()).map((s) => s.set_index), [0, 1, 2, 3, 4, 5],
    'indices stay contiguous, or the next reorder drifts');
});

test('reindexSets writes only the rows that actually moved', async () => {
  await seedSets([
    { id: 'sq', name: 'Squat' }, { id: 'sq', name: 'Squat' },
    { id: 'bp', name: 'Bench' }, { id: 'bp', name: 'Bench' },
    { id: 'dl', name: 'Deadlift' }, { id: 'dl', name: 'Deadlift' },
  ]);

  assert.equal((await workout.reindexSets(await liveSets())).length, 0, 'already in order: no writes');

  const shuffled = workout.orderGroups(workout.groupByExercise(await liveSets()), 'bp', 0);
  const written = await workout.reindexSets(shuffled.flatMap((g) => g.sets));
  assert.equal(written.length, 4, 'Bench and Squat move; Deadlift does not');
});

// ---- warm-up sets --------------------------------------------------------------

test('a warm-up slots in front of the working sets it warms up for', async () => {
  await seedSets([
    { id: 'sq', name: 'Squat' },
    { id: 'bp', name: 'Bench' }, { id: 'bp', name: 'Bench' },
    { id: 'dl', name: 'Deadlift' },
  ]);

  const set = await workout.addWarmupSet({
    session: SESSION,
    group: await groupNamed('bp'),
    exercise: { id: 'bp', name: 'Bench' },
    weight: 45,
    ownerEmail: ME,
    existingSets: await liveSets(),
  });

  assert.equal(set.is_warmup, true);
  assert.equal(set.reps, null, 'reps are left to fill in');

  const bench = await groupNamed('bp');
  assert.deepEqual(bench.sets.map((s) => s.is_warmup), [true, false, false]);
  assert.deepEqual((await cards()).map(([n]) => n), ['Squat', 'Bench', 'Deadlift'], 'card order is untouched');
  assert.deepEqual((await liveSets()).map((s) => s.set_index), [0, 1, 2, 3, 4]);
});

test('a second warm-up stacks behind the first, not in front of it', async () => {
  await seedSets([{ id: 'bp', name: 'Bench' }]);

  for (const weight of [45, 65]) {
    await workout.addWarmupSet({
      session: SESSION,
      group: await groupNamed('bp'),
      exercise: { id: 'bp', name: 'Bench' },
      weight,
      ownerEmail: ME,
      existingSets: await liveSets(),
    });
  }

  const bench = await groupNamed('bp');
  assert.deepEqual(bench.sets.map((s) => s.is_warmup), [true, true, false]);
  assert.deepEqual(bench.sets.map((s) => s.weight_lb), [45, 65, 100], 'in the order they were added');
});

test('a warm-up on an exercise with no working set still lands', async () => {
  await seedSets([{ id: 'bp', name: 'Bench', warmup: true }]);

  await workout.addWarmupSet({
    session: SESSION,
    group: await groupNamed('bp'),
    exercise: { id: 'bp', name: 'Bench' },
    weight: 65,
    ownerEmail: ME,
    existingSets: await liveSets(),
  });

  assert.equal((await liveSets()).length, 2);
});

// ---- duplicate and remove --------------------------------------------------------

test('duplicating adds the same number of working sets, carrying their loads', async () => {
  await seedSets([
    { id: 'sq', name: 'Squat' },
    { id: 'bp', name: 'Bench', weight: 135, reps: 8 }, { id: 'bp', name: 'Bench', weight: 135, reps: 8 },
  ]);

  const made = await workout.duplicateExercise({
    session: SESSION,
    group: await groupNamed('bp'),
    ownerEmail: ME,
    existingSets: await liveSets(),
  });

  assert.equal(made.length, 2);
  assert.deepEqual(made.map((s) => [s.weight_lb, s.reps]), [[135, 8], [135, 8]]);
  assert.equal(made.every((s) => !s.completed_at), true, 'duplicates start unchecked');
  assert.deepEqual(await cards(), [['Squat', 1], ['Bench', 4]],
    'they join the same card — a card is an exercise here');
});

test('duplicating counts working sets only, not warm-ups', async () => {
  await seedSets([
    { id: 'bp', name: 'Bench', warmup: true },
    { id: 'bp', name: 'Bench' }, { id: 'bp', name: 'Bench' },
  ]);

  const made = await workout.duplicateExercise({
    session: SESSION,
    group: await groupNamed('bp'),
    ownerEmail: ME,
    existingSets: await liveSets(),
  });

  assert.equal(made.length, 2);
  assert.equal(made.some((s) => s.is_warmup), false);
});

test('removing an exercise tombstones its sets and leaves the others alone', async () => {
  await seedSets([
    { id: 'sq', name: 'Squat' },
    { id: 'bp', name: 'Bench' }, { id: 'bp', name: 'Bench' },
  ]);

  const count = await workout.removeExercise(await groupNamed('bp'));

  assert.equal(count, 2);
  assert.deepEqual(await cards(), [['Squat', 1]]);
  assert.equal((await local.allRaw('session_sets')).filter((s) => s.deleted_at).length, 2,
    'soft, like every other delete');
});

// ---- grouping, volume, records ----------------------------------------------------

test('exercises group in the order they were first worked', () => {
  const sets = [
    { session_id: 'w1', set_index: 0, exercise_id: 'a', exercise_name: 'A' },
    { session_id: 'w1', set_index: 1, exercise_id: 'b', exercise_name: 'B' },
    { session_id: 'w1', set_index: 2, exercise_id: 'a', exercise_name: 'A' },
  ];
  assert.deepEqual(workout.groupByExercise(sets).map((g) => g.name), ['A', 'B']);
});

test('a set with no exercise id groups by name, so history is not lost', () => {
  const sets = [
    { session_id: 'w1', set_index: 0, exercise_id: null, exercise_name: 'Cable Fly' },
    { session_id: 'w1', set_index: 1, exercise_id: null, exercise_name: 'Cable Fly' },
  ];
  const [group] = workout.groupByExercise(sets);
  assert.equal(group.key, 'Cable Fly');
  assert.equal(group.sets.length, 2);
});

test('volume counts completed working sets only', () => {
  const sets = [
    { weight_lb: 100, reps: 10, completed_at: 'T' },
    { weight_lb: 100, reps: 10, completed_at: null },          // not done yet
    { weight_lb: 45, reps: 10, completed_at: 'T', is_warmup: true },
    { weight_lb: 100, reps: 10, completed_at: 'T', deleted_at: 'x' },
  ];
  assert.equal(workout.volume(sets), 1000);
});

test('a session index answers by session and by exercise', () => {
  const sets = [
    { id: 's1', session_id: 'w1', set_index: 1, exercise_id: 'e1', exercise_name: 'Bench', weight_lb: 100, reps: 5, completed_at: 'T' },
    { id: 's0', session_id: 'w1', set_index: 0, exercise_id: 'e1', exercise_name: 'Bench', weight_lb: 100, reps: 5, completed_at: 'T' },
    { id: 'gone', session_id: 'w1', set_index: 9, exercise_id: 'e1', exercise_name: 'Bench', deleted_at: 'x' },
  ];
  const sessions = [{ id: 'w1', owner_email: ME, started_at: '2026-08-10T10:00:00Z' }];
  const index = workout.buildIndex(sets, sessions, ME);

  assert.deepEqual(workout.setsOf(index, 'w1').map((s) => s.id), ['s0', 's1'], 'sorted by set_index');
  assert.equal(index.byExercise.get('e1').length, 2, 'tombstones are excluded');
  assert.equal(index.volumeBySession.get('w1'), 1000);
});

test('a record has to beat the previous best, not tie it', () => {
  const set = { weight_lb: 225, reps: 5, is_warmup: false, completed_at: 'T' };
  const rm = workout.estimate1RM(225, 5);

  assert.equal(workout.isRecord(set, rm - 1), true);
  assert.equal(workout.isRecord(set, rm), false, 'matching your best is not a PR');
  assert.equal(workout.isRecord({ ...set, is_warmup: true }, 0), false, 'a warm-up is never a PR');
  assert.equal(workout.isRecord({ ...set, completed_at: null }, 0), false, 'nor is an unchecked set');
});

test('plate maths splits the load either side of the bar', () => {
  const { plates } = workout.plateMath(225);
  assert.equal(plates.reduce((t, p) => t + p, 0) * 2 + workout.DEFAULT_BAR_LB, 225);
});

// ---- turning a session back into a routine ---------------------------------

/** A finished session with two exercises, the second done heavier than the first. */
async function seedFinishedSession() {
  await seedSets([
    { id: 'bp', name: 'Bench', warmup: true, weight: 45, reps: 10 },
    { id: 'bp', name: 'Bench', weight: 135, reps: 8 },
    { id: 'bp', name: 'Bench', weight: 155, reps: 5 },
    { id: 'row', name: 'Barbell Row', weight: 95, reps: 10 },
  ]);
  return local.all('session_sets');
}

test('saving a session as a routine records what was actually done', async () => {
  const sets = await seedFinishedSession();
  const routine = await workout.saveSessionAsRoutine({
    name: 'Push A', session: SESSION, sets, ownerEmail: ME,
  });

  assert.equal(routine.name, 'Push A');

  const plan = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.deepEqual(plan.map((i) => i.notes), ['Bench', 'Barbell Row'], 'in the order worked');
  assert.equal(plan[0].target_sets, 2, 'warm-ups do not count towards the plan');
  assert.equal(plan[0].target_weight_lb, 155, 'the heaviest working set sets the target');
  assert.equal(plan[0].target_reps, '5');
  assert.deepEqual(plan.map((i) => i.position), [0, 1]);
});

test('updating a routine keeps the routine itself, replacing only its plan', async () => {
  const sets = await seedFinishedSession();
  const routine = await workout.saveSessionAsRoutine({
    name: 'Push A', session: SESSION, sets, ownerEmail: ME,
  });

  // A later session: one exercise swapped out, and heavier.
  await local.wipe();
  await local.save('routines', { ...routine }, ME);
  await seedSets([
    { id: 'bp', name: 'Bench', weight: 185, reps: 5 },
    { id: 'db', name: 'Dumbbell Row', weight: 60, reps: 12 },
    { id: 'db', name: 'Dumbbell Row', weight: 60, reps: 12 },
  ]);

  await workout.updateRoutineFromSession({
    routine,
    session: SESSION,
    sets: await local.all('session_sets'),
    ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  const kept = (await local.all('routines')).find((r) => r.id === routine.id);
  assert.equal(kept.id, routine.id, 'the routine row survives, so its history does');
  assert.equal(kept.name, 'Push A', 'and keeps its name');

  const plan = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.deepEqual(plan.map((i) => i.notes), ['Bench', 'Dumbbell Row'], 'the swap is reflected');
  assert.equal(plan[0].target_weight_lb, 185, 'and the new weight');
  assert.equal(plan[1].target_sets, 2);
});

test('updating tombstones the old plan rather than leaving it behind', async () => {
  const sets = await seedFinishedSession();
  const routine = await workout.saveSessionAsRoutine({
    name: 'Push A', session: SESSION, sets, ownerEmail: ME,
  });
  const before = workout.routineExercises(await local.all('routine_exercises'), routine.id);

  await workout.updateRoutineFromSession({
    routine,
    session: SESSION,
    sets,
    ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  const live = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.equal(live.length, 2, 'no duplicates from the rewrite');

  const raw = await local.allRaw('routine_exercises');
  const tombstoned = raw.filter((r) => r.deleted_at).map((r) => r.id);
  assert.deepEqual(tombstoned.sort(), before.map((i) => i.id).sort(),
    'every old row is soft-deleted, so the delete reaches the other device');
});

test('updating a routine from a session that did nothing leaves it empty, not stale', async () => {
  const sets = await seedFinishedSession();
  const routine = await workout.saveSessionAsRoutine({
    name: 'Push A', session: SESSION, sets, ownerEmail: ME,
  });

  await workout.updateRoutineFromSession({
    routine,
    session: { id: 'empty-session', owner_email: ME },
    sets: await local.all('session_sets'),
    ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  assert.equal(workout.routineExercises(await local.all('routine_exercises'), routine.id).length, 0);
});
