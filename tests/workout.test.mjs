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
      // `in`, not ??, so a test can seed a genuinely empty set — `null ?? 100`
      // silently handed back 100 and made "untouched set" untestable.
      weight_lb: 'weight' in spec ? spec.weight : 100,
      reps: 'reps' in spec ? spec.reps : 5,
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

// ---- what "update the routine" actually captures ---------------------------
// Every card in the session goes in, however it got there, and the numbers come
// from sets that were checked off.

test('the new plan is the session, whatever the old plan said', async () => {
  await seedSets([
    { id: 'bp', name: 'Bench', weight: 185, reps: 5, done: 'T' },     // went up
    { id: 'row', name: 'Barbell Row', weight: 135, reps: 10, done: 'T' },
    { id: 'db', name: 'Dumbbell Row', weight: 60, reps: 12, done: 'T' },  // swapped in
    { id: 'curl', name: 'Curl', weight: 30, reps: 12, done: 'T' },        // added halfway
  ]);
  const routine = await local.save('routines', { name: 'Push A' }, ME);

  await workout.updateRoutineFromSession({
    routine, session: SESSION, sets: await local.all('session_sets'), ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  const plan = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.deepEqual(plan.map((p) => p.notes),
    ['Bench', 'Barbell Row', 'Dumbbell Row', 'Curl'],
    'an exercise added mid-workout or swapped in is in the plan like any other');
  assert.equal(plan[0].target_weight_lb, 185, 'and carries the weight actually used');
});

test('a set left at its prefill does not set the target', async () => {
  // The bug this replaced: drop 185 -> 155, do two, never touch the third, and
  // the routine recorded 185x3 — a weight nobody lifted.
  await seedSets([
    { id: 'bp', name: 'Bench', weight: 155, reps: 5, done: 'T1' },
    { id: 'bp', name: 'Bench', weight: 155, reps: 5, done: 'T2' },
    { id: 'bp', name: 'Bench', weight: 185, reps: 5 },
  ]);
  const routine = await local.save('routines', { name: 'Push A' }, ME);

  await workout.updateRoutineFromSession({
    routine, session: SESSION, sets: await local.all('session_sets'), ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  const [plan] = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.equal(plan.target_weight_lb, 155, 'the heaviest set you finished');
  assert.equal(plan.target_sets, 2, 'and only the sets you finished');
});

test('an exercise you skipped stays in the plan at its planned shape', async () => {
  // Nothing checked, so there is no "what I did" to record — but dropping it
  // would quietly delete an exercise from the routine for running out of time.
  await seedSets([
    { id: 'bp', name: 'Bench', weight: 185, reps: 5, done: 'T' },
    { id: 'sq', name: 'Squat', weight: 225, reps: 5 },
    { id: 'sq', name: 'Squat', weight: 225, reps: 5 },
  ]);
  const routine = await local.save('routines', { name: 'Push A' }, ME);

  await workout.updateRoutineFromSession({
    routine, session: SESSION, sets: await local.all('session_sets'), ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  const plan = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  const squat = plan.find((p) => p.notes === 'Squat');
  assert.ok(squat, 'still there');
  assert.equal(squat.target_sets, 2, 'at the shape it was planned to be');
});

test('warm-ups never count towards the plan', async () => {
  await seedSets([
    { id: 'bp', name: 'Bench', warmup: true, weight: 45, reps: 10, done: 'T' },
    { id: 'bp', name: 'Bench', warmup: true, weight: 95, reps: 5, done: 'T' },
    { id: 'bp', name: 'Bench', weight: 185, reps: 5, done: 'T' },
  ]);
  const routine = await local.save('routines', { name: 'Push A' }, ME);

  await workout.updateRoutineFromSession({
    routine, session: SESSION, sets: await local.all('session_sets'), ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  const [plan] = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.equal(plan.target_sets, 1);
  assert.equal(plan.target_weight_lb, 185, 'a heavy warm-up cannot become the target');
});

// ---- replacing away, and what the routine inherits --------------------------

test('replacing marks what stays behind without disturbing it', async () => {
  const sets = await seedSets([
    { id: 'row', name: 'Barbell Row', weight: 135, reps: 10, done: 'T1' },
    { id: 'row', name: 'Barbell Row', weight: null, reps: null },
  ]);

  await workout.replaceExercise({
    session: SESSION, group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    prefill: { weight_lb: 60, reps: 12 }, ownerEmail: ME, existingSets: sets,
  });

  const left = (await liveSets()).filter((s) => s.exercise_name === 'Barbell Row');
  assert.equal(left.length, 1);
  assert.ok(left[0].replaced_at, 'stamped as an exercise you moved on from');
  assert.equal(left[0].completed_at, 'T1', 'still checked');
  assert.equal(left[0].weight_lb, 135, 'and still what you actually lifted');

  const moved = (await liveSets()).filter((s) => s.exercise_name === 'Dumbbell Row');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].replaced_at, undefined, 'the exercise you switched to is not stamped');
});

test('a replaced-away exercise still counts towards the session', async () => {
  // The stamp is about intent, not about undoing work.
  const sets = await seedSets([
    { id: 'row', name: 'Barbell Row', weight: 100, reps: 10, done: 'T1' },
    { id: 'row', name: 'Barbell Row', weight: null, reps: null },
  ]);
  await workout.replaceExercise({
    session: SESSION, group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    prefill: null, ownerEmail: ME, existingSets: sets,
  });

  assert.equal(workout.volume(await liveSets()), 1000, 'the work still counts');
  assert.deepEqual((await cards()).map(([n]) => n), ['Barbell Row', 'Dumbbell Row'],
    'and both cards are still on screen');
});

test('updating the routine leaves out the exercise you replaced away from', async () => {
  const sets = await seedSets([
    { id: 'bp', name: 'Bench', weight: 185, reps: 5, done: 'T' },
    { id: 'row', name: 'Barbell Row', weight: 135, reps: 10, done: 'T1' },
    { id: 'row', name: 'Barbell Row', weight: null, reps: null },
  ]);
  await workout.replaceExercise({
    session: SESSION, group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    prefill: { weight_lb: 60, reps: 12 }, ownerEmail: ME, existingSets: sets,
  });

  // Finish the exercise you switched to, so it has something to record.
  const swapped = (await liveSets()).find((s) => s.exercise_name === 'Dumbbell Row');
  await workout.updateSet(swapped, { completed_at: 'T2' });

  const routine = await local.save('routines', { name: 'Pull A' }, ME);
  await workout.updateRoutineFromSession({
    routine, session: SESSION, sets: await local.all('session_sets'), ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  const plan = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.deepEqual(plan.map((p) => p.notes), ['Bench', 'Dumbbell Row'],
    'Barbell Row is history, not plan');
  assert.deepEqual(plan.map((p) => p.position), [0, 1], 'positions stay contiguous');
});

test('replacing a finished card still drops it from the plan', async () => {
  const sets = await seedSets([{ id: 'row', name: 'Barbell Row', weight: 135, reps: 10, done: 'T1' }]);
  await workout.replaceExercise({
    session: SESSION, group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    prefill: { weight_lb: 60, reps: 12 }, ownerEmail: ME, existingSets: sets,
  });

  const routine = await local.save('routines', { name: 'Pull A' }, ME);
  await workout.updateRoutineFromSession({
    routine, session: SESSION, sets: await local.all('session_sets'), ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  assert.deepEqual(
    workout.routineExercises(await local.all('routine_exercises'), routine.id).map((p) => p.notes),
    ['Dumbbell Row'],
  );
});

test('going back to an exercise you replaced away from puts it back in the plan', async () => {
  const sets = await seedSets([
    { id: 'row', name: 'Barbell Row', weight: 135, reps: 10, done: 'T1' },
    { id: 'row', name: 'Barbell Row', weight: null, reps: null },
  ]);
  await workout.replaceExercise({
    session: SESSION, group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    prefill: null, ownerEmail: ME, existingSets: sets,
  });

  // The rack freed up. Adding it back is a fresh, unstamped set, so the card is
  // no longer wholly "moved on from".
  await workout.addSet({
    session: SESSION, exercise: { id: 'row', name: 'Barbell Row' },
    weight: 145, reps: 10, isWarmup: false, ownerEmail: ME, existingSets: await liveSets(),
  });
  const back = (await liveSets()).find((s) => s.exercise_name === 'Barbell Row' && !s.replaced_at);
  await workout.updateSet(back, { completed_at: 'T3' });

  const routine = await local.save('routines', { name: 'Pull A' }, ME);
  await workout.updateRoutineFromSession({
    routine, session: SESSION, sets: await local.all('session_sets'), ownerEmail: ME,
    allRoutineExercises: await local.all('routine_exercises'),
  });

  const plan = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  const row = plan.find((p) => p.notes === 'Barbell Row');
  assert.ok(row, 'back in the plan');
  assert.equal(row.target_weight_lb, 145, 'at the weight you came back with');
});

// ---- looking at somebody else's training ------------------------------------
// RLS already allows this both ways (can_read honours share_grants), so the
// other person's sessions are in IndexedDB alongside yours. Everything that
// reads them has to stay owner-scoped on purpose.

const AANA = 'aana@example.com';

test('recentSessions returns one person at a time', async () => {
  const sessions = [
    { id: 'a1', owner_email: ME, started_at: '2026-08-09T10:00:00Z', ended_at: '2026-08-09T11:00:00Z' },
    { id: 'a2', owner_email: ME, started_at: '2026-08-10T10:00:00Z', ended_at: '2026-08-10T11:00:00Z' },
    { id: 'b1', owner_email: AANA, started_at: '2026-08-10T12:00:00Z', ended_at: '2026-08-10T13:00:00Z' },
  ];

  assert.deepEqual(workout.recentSessions(sessions, ME).map((s) => s.id), ['a2', 'a1'],
    'newest first, mine only');
  assert.deepEqual(workout.recentSessions(sessions, AANA).map((s) => s.id), ['b1']);
});

test('an unfinished session is nobody\'s history', async () => {
  const sessions = [
    { id: 'open', owner_email: AANA, started_at: '2026-08-10T12:00:00Z', ended_at: null },
    { id: 'gone', owner_email: AANA, started_at: '2026-08-09T12:00:00Z', ended_at: '2026-08-09T13:00:00Z', deleted_at: 'x' },
  ];
  assert.deepEqual(workout.recentSessions(sessions, AANA), []);
});

test('the set index reads another owner\'s session, but priors stay mine', async () => {
  // bySession is deliberately not owner-filtered, so her session can be opened
  // and summarised. sessionById is, so her lifts never reach my prefill or PRs.
  const sets = [
    { id: 'm1', owner_email: ME, session_id: 'mine', set_index: 0, exercise_id: 'bp',
      exercise_name: 'Bench', weight_lb: 185, reps: 5, is_warmup: false, completed_at: 'T' },
    { id: 'h1', owner_email: AANA, session_id: 'hers', set_index: 0, exercise_id: 'bp',
      exercise_name: 'Bench', weight_lb: 95, reps: 8, is_warmup: false, completed_at: 'T' },
  ];
  const sessions = [
    { id: 'mine', owner_email: ME, started_at: '2026-08-01T10:00:00Z', ended_at: '2026-08-01T11:00:00Z' },
    { id: 'hers', owner_email: AANA, started_at: '2026-08-02T10:00:00Z', ended_at: '2026-08-02T11:00:00Z' },
  ];

  const index = workout.buildIndex(sets, sessions, ME);

  assert.equal(workout.setsOf(index, 'hers').length, 1, 'her session can still be read back');
  assert.equal(index.volumeBySession.get('hers'), 760, 'and summarised');

  assert.deepEqual(index.owned.map((s) => s.id), ['mine'], 'owned is me only');

  const prior = workout.priorForm(index, null);
  assert.equal(prior.get('bp').best.weight_lb, 185,
    'her 95 lb bench must not become my last-performance prefill');
});

// ---- concurrent writes to one set ------------------------------------------
// These fire without awaiting between them, because that is what the DOM does:
// typing in a box fires `change`, tapping the check fires `click`, and the two
// listeners are independent. Awaiting between them — which the first version of
// this suite did — is the one ordering that cannot fail, which is exactly why
// the bug kept coming back.

test('reps typed just before the check survive it, concurrently', async () => {
  const [set] = await seedSets([{ id: 'bp', name: 'Bench', weight: 205, reps: 8 }]);

  await Promise.all([
    workout.updateSet(set, { reps: 7 }),              // change
    workout.updateSet(set, { completed_at: 'T' }),    // click, same tick
  ]);

  const stored = await local.get('session_sets', set.id);
  assert.equal(stored.reps, 7, 'the default must not come back');
  assert.equal(stored.completed_at, 'T', 'and the check still lands');
});

test('the last write wins for the same field, not an earlier read', async () => {
  const [set] = await seedSets([{ id: 'bp', name: 'Bench', reps: 8 }]);

  await Promise.all([
    workout.updateSet(set, { reps: 9 }),
    workout.updateSet(set, { reps: 10 }),
    workout.updateSet(set, { reps: 11 }),
  ]);

  assert.equal((await local.get('session_sets', set.id)).reps, 11);
});

test('concurrent edits to different fields all land', async () => {
  const [set] = await seedSets([{ id: 'bp', name: 'Bench', weight: 205, reps: 8 }]);

  await Promise.all([
    workout.updateSet(set, { weight_lb: 185 }),
    workout.updateSet(set, { reps: 6 }),
    workout.updateSet(set, { completed_at: 'T' }),
  ]);

  const stored = await local.get('session_sets', set.id);
  assert.deepEqual([stored.weight_lb, stored.reps, stored.completed_at], [185, 6, 'T']);
});

test('writes to different sets are not serialised behind each other', async () => {
  const sets = await seedSets([
    { id: 'bp', name: 'Bench', reps: 8 },
    { id: 'bp', name: 'Bench', reps: 8 },
  ]);

  await Promise.all([
    workout.updateSet(sets[0], { reps: 5 }),
    workout.updateSet(sets[1], { reps: 6 }),
  ]);

  assert.equal((await local.get('session_sets', sets[0].id)).reps, 5);
  assert.equal((await local.get('session_sets', sets[1].id)).reps, 6);
});

// ---- what "previous" is, and what a placeholder adopts ----------------------

test('priorForm carries the last session\'s working sets, in order', () => {
  const sets = [
    { id: 'o1', session_id: 'old', set_index: 0, exercise_id: 'bp', exercise_name: 'Bench',
      weight_lb: 205, reps: 8, is_warmup: false, completed_at: 'T' },
    { id: 'o2', session_id: 'old', set_index: 1, exercise_id: 'bp', exercise_name: 'Bench',
      weight_lb: 205, reps: 6, is_warmup: false, completed_at: 'T' },
    { id: 'ow', session_id: 'old', set_index: 2, exercise_id: 'bp', exercise_name: 'Bench',
      weight_lb: 45, reps: 10, is_warmup: true, completed_at: 'T' },
    { id: 'older', session_id: 'ancient', set_index: 0, exercise_id: 'bp', exercise_name: 'Bench',
      weight_lb: 135, reps: 5, is_warmup: false, completed_at: 'T' },
  ];
  const sessions = [
    { id: 'old', owner_email: ME, started_at: '2026-08-10T10:00:00Z' },
    { id: 'ancient', owner_email: ME, started_at: '2026-01-01T10:00:00Z' },
  ];

  const prior = workout.priorForm(workout.buildIndex(sets, sessions, ME), null);
  const previous = prior.get('bp').previous;

  assert.deepEqual(previous.map((s) => s.reps), [8, 6], 'most recent session only, in set order');
  assert.equal(previous.some((s) => s.is_warmup), false, 'warm-ups are not a set to repeat');
});

test('the running session is excluded from previous', () => {
  const sets = [
    { id: 'old', session_id: 'last', set_index: 0, exercise_id: 'bp', exercise_name: 'Bench',
      weight_lb: 205, reps: 8, is_warmup: false, completed_at: 'T' },
    { id: 'now', session_id: 'today', set_index: 0, exercise_id: 'bp', exercise_name: 'Bench',
      weight_lb: 225, reps: 3, is_warmup: false, completed_at: 'T' },
  ];
  const sessions = [
    { id: 'last', owner_email: ME, started_at: '2026-08-10T10:00:00Z' },
    { id: 'today', owner_email: ME, started_at: '2026-08-24T10:00:00Z' },
  ];
  const index = workout.buildIndex(sets, sessions, ME);

  // Without excluding it, "previous" would be the set you just finished.
  assert.deepEqual(workout.priorForm(index, 'today').get('bp').previous.map((s) => s.reps), [8]);
  assert.deepEqual(workout.priorForm(index, null).get('bp').previous.map((s) => s.reps), [3]);
});

test('an exercise with no history has no previous, rather than throwing', () => {
  const index = workout.buildIndex([], [], ME);
  assert.equal(workout.priorForm(index, null).size, 0);
});

test('a later-resolving write can carry an older row', async () => {
  // Why app.js renders from its optimistic patches and throws these results
  // away. The change's write merges reps into a row whose completed_at is still
  // null, so patching its result in after the click's optimistic patch flicked
  // the tick off and straight back on again — visible as a glitch.
  const [set] = await seedSets([{ id: 'bp', name: 'Bench', reps: null }]);

  const [fromChange, fromClick] = await Promise.all([
    workout.updateSet(set, { reps: 7 }),
    workout.updateSet(set, { completed_at: 'T' }),
  ]);

  assert.equal(fromChange.reps, 7);
  assert.equal(fromChange.completed_at, null, 'older than what the UI already showed');
  assert.equal(fromClick.completed_at, 'T');

  // Storage still converges, which is what lets the UI ignore both of them.
  const stored = await local.get('session_sets', set.id);
  assert.deepEqual([stored.reps, stored.completed_at], [7, 'T']);
});

test('checking an untouched set adopts the placeholder it was showing', async () => {
  // The row renders empty with last session's numbers greyed in. Checking it
  // without typing means "yes, that again", so those become the value.
  const [set] = await seedSets([{ id: 'bp', name: 'Bench', weight: null, reps: null }]);

  const saved = await workout.updateSet(set, {
    completed_at: 'T', weight_lb: 205, reps: 8,
  });

  assert.deepEqual([saved.weight_lb, saved.reps], [205, 8]);
});

test('a set you did type into is not overwritten by its placeholder', async () => {
  const [set] = await seedSets([{ id: 'bp', name: 'Bench', weight: null, reps: null }]);
  await workout.updateSet(set, { reps: 5 });

  // toggleDone only fills what is still null, so the 5 stands and only the
  // weight is adopted.
  const current = await local.get('session_sets', set.id);
  const fill = {};
  if (current.weight_lb == null) fill.weight_lb = 205;
  if (current.reps == null) fill.reps = 8;

  const saved = await workout.updateSet(set, { ...fill, completed_at: 'T' });
  assert.equal(saved.reps, 5, 'what you typed wins');
  assert.equal(saved.weight_lb, 205, 'what you left blank is adopted');
});
