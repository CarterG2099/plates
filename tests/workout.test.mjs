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
    previous: [],
    ownerEmail: ME,
    existingSets: sets,
  });

  assert.equal(moved.length, 3);
  assert.deepEqual(await cards(), [['Dumbbell Row', 3]]);
  // The swap used to write the heaviest set of the new exercise's last session
  // into every moved row — a real value where a placeholder belongs, and the
  // same flat number on every set. Cleared is what lets the per-position
  // placeholders show, exactly like a planned or freshly added set.
  assert.deepEqual([moved[0].weight_lb, moved[0].reps], [null, null],
    'cleared, so the new exercise\'s own last-session placeholders show through');
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
    previous: [],
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
    previous: [],
    ownerEmail: ME,
    existingSets: sets,
  });

  assert.equal(made.length, 1);
  assert.equal(made[0].exercise_name, 'Dumbbell Row');
  assert.equal(made[0].completed_at, null, 'a new set is not pre-checked');
  assert.deepEqual(await cards(), [['Barbell Row', 1], ['Dumbbell Row', 1]]);
});

test('swapping a finished card opens the new exercise at its last-time size', async () => {
  const sets = await seedSets([{ id: 'row', name: 'Barbell Row', done: 'T1' }]);

  const made = await workout.replaceExercise({
    session: SESSION,
    group: await groupNamed('row'),
    exercise: { id: 'db', name: 'Dumbbell Row' },
    previous: [{ reps: 8 }, { reps: 8 }, { reps: 6 }],
    ownerEmail: ME,
    existingSets: sets,
  });

  assert.equal(made.length, 3, 'as many sets as it took last time — same rule as adding it');
  assert.equal(made.every((s) => s.weight_lb === null && s.reps === null), true,
    'and all empty, so the placeholders carry the numbers');
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

// ---- ordering routines, and the exercises inside one -------------------------
// Both are the same operation as reordering exercise cards, and go through the
// same moveTo; what these pin down is the persistence either side of it.

/** Routines in display order, seeded straight in so a test states its own shape. */
async function seedRoutines(specs, ownerEmail = ME) {
  for (const spec of specs) {
    await local.save('routines', { name: spec.name, notes: null, position: spec.position }, ownerEmail);
  }
  return local.all('routines');
}

const names = (rs) => rs.map((r) => r.name);

test('routines sort by position, and fall back to name rather than to nothing', async () => {
  await seedRoutines([
    { name: 'Legs',   position: 2 },
    { name: 'Push A', position: 0 },
    { name: 'Pull B', position: 1 },
  ]);
  assert.deepEqual(names(workout.routinesFor(await local.all('routines'), ME)),
    ['Push A', 'Pull B', 'Legs']);

  // Everything at 0 is what an importer, or a routine made before this column
  // existed, actually looks like. Alphabetical is the old behaviour, and a
  // stable order beats an arbitrary one.
  await local.wipe();
  await seedRoutines([
    { name: 'Legs',   position: 0 },
    { name: 'Push A', position: 0 },
    { name: 'Pull B', position: 0 },
  ]);
  assert.deepEqual(names(workout.routinesFor(await local.all('routines'), ME)),
    ['Legs', 'Pull B', 'Push A']);
});

test('a routine you do not own is not in your order', async () => {
  await seedRoutines([{ name: 'Mine', position: 0 }]);
  await seedRoutines([{ name: 'Theirs', position: 1 }], 'someone@else');

  assert.deepEqual(names(workout.routinesFor(await local.all('routines'), ME)), ['Mine']);
  assert.equal(workout.nextRoutinePosition(await local.all('routines'), ME), 1,
    'and does not push my next routine down the list');
});

test('dragging a routine to the front renumbers the list behind it', async () => {
  await seedRoutines([
    { name: 'Push A', position: 0 },
    { name: 'Pull B', position: 1 },
    { name: 'Legs',   position: 2 },
  ]);

  // Moved by hand rather than through a helper: what is under test is that
  // reindexRoutines writes the positions, not how the list got rearranged.
  const ordered = workout.routinesFor(await local.all('routines'), ME);
  const moved = [ordered[2], ordered[0], ordered[1]];
  await workout.reindexRoutines(moved);

  const after = workout.routinesFor(await local.all('routines'), ME);
  assert.deepEqual(names(after), ['Legs', 'Push A', 'Pull B']);
  assert.deepEqual(after.map((r) => r.position), [0, 1, 2],
    'positions stay contiguous, or the next reorder drifts');
});

test('reindexRoutines writes only the rows that actually moved', async () => {
  await seedRoutines([
    { name: 'Push A', position: 0 },
    { name: 'Pull B', position: 1 },
    { name: 'Legs',   position: 2 },
  ]);

  const ordered = workout.routinesFor(await local.all('routines'), ME);
  assert.equal((await workout.reindexRoutines(ordered)).length, 0, 'already in order: no writes');

  const swapped = [ordered[1], ordered[0], ordered[2]];
  assert.equal((await workout.reindexRoutines(swapped)).length, 2,
    'the top two swap; the third does not move');
});

test('renaming a routine leaves its place in the list alone', async () => {
  await seedRoutines([
    { name: 'Push A', position: 0 },
    { name: 'Pull B', position: 1 },
  ]);
  const pull = (await local.all('routines')).find((r) => r.name === 'Pull B');

  // local.save writes the object it is handed, so a rename that rebuilt the row
  // from { id, name } alone would drop position back to its default and jump
  // the routine to the top of the list.
  const renamed = await workout.upsertRoutine({ id: pull.id, name: 'Pull A' }, ME);
  assert.equal(renamed.position, 1);
  assert.deepEqual(names(workout.routinesFor(await local.all('routines'), ME)), ['Push A', 'Pull A']);
});

test('a new routine goes to the end of the list, not the top', async () => {
  await seedRoutines([
    { name: 'Push A', position: 0 },
    { name: 'Pull B', position: 1 },
  ]);

  const made = await workout.upsertRoutine(
    { name: 'Legs' }, ME, await local.all('routines'));
  assert.equal(made.position, 2);

  const fromSession = await workout.saveSessionAsRoutine({
    name: 'Arms', session: SESSION, sets: await seedFinishedSession(), ownerEmail: ME,
    routines: await local.all('routines'),
  });
  assert.equal(fromSession.position, 3, 'however it was created');
});

test('reordering the exercises inside a routine renumbers only what moved', async () => {
  const sets = await seedFinishedSession();
  const routine = await workout.saveSessionAsRoutine({
    name: 'Push A', session: SESSION, sets, ownerEmail: ME,
  });

  const plan = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.deepEqual(plan.map((i) => i.notes), ['Bench', 'Barbell Row']);

  assert.equal((await workout.reindexRoutineExercises(plan)).length, 0, 'already in order: no writes');

  const moved = workout.orderRoutineExercises(plan, plan[1].id, 0);
  assert.equal((await workout.reindexRoutineExercises(moved)).length, 2);

  const after = workout.routineExercises(await local.all('routine_exercises'), routine.id);
  assert.deepEqual(after.map((i) => i.notes), ['Barbell Row', 'Bench']);
  assert.deepEqual(after.map((i) => i.position), [0, 1]);
  assert.equal(after[0].target_weight_lb, 95,
    'reordering moves the row, it does not rewrite the plan');
});

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
    previous: [], ownerEmail: ME, existingSets: sets,
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
    previous: [], ownerEmail: ME, existingSets: sets,
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
    previous: [], ownerEmail: ME, existingSets: sets,
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

// ---- cardio as an exercise --------------------------------------------------
// A run is a card in the session like any other; what differs is what a set
// records. distance_m and duration_s are null for lifting and weight_lb/reps are
// null for cardio, so nothing is stored in a column that means something else.

test('category is what marks an exercise as cardio', () => {
  assert.equal(workout.isCardio({ category: 'cardio', name: 'Anything' }), true);
  assert.equal(workout.isCardio({ category: 'pull', name: 'Row (Dumbbell)' }), false);
});

test('a Hevy import with no category is recognised by name', () => {
  // "Cycling" was already in the library with category null.
  assert.equal(workout.isCardio(null, 'Cycling'), true);
  assert.equal(workout.isCardio({ name: 'Running', category: null }), true);
  assert.equal(workout.isCardio(null, 'Rowing (Machine)'), true);
});

test('lifts whose names start with a cardio word are not cardio', () => {
  // A prefix match made this one cardio, and a substring match would have taken
  // every Row and Curl with it.
  assert.equal(workout.isCardio(null, 'Walking Lunge'), false);
  assert.equal(workout.isCardio(null, 'Row (Dumbbell)'), false);
  assert.equal(workout.isCardio(null, 'Runner\'s Stretch'), false);
  assert.equal(workout.isCardio(null, 'Swimmer Press'), false);
});

test('a cardio line reads distance, time and pace, in miles by default', () => {
  // Imperial to match weight_lb; metric is opt-in per call.
  assert.equal(workout.cardioLine({ distance_m: 5200, duration_s: 1560 }),
    '3.23 mi · 26:00 · 8:03 /mi');
  assert.equal(workout.cardioLine({ distance_m: 5200, duration_s: 1560 }, { metric: true }),
    '5.20 km · 26:00 · 5:00 /km');
});

test('the record for a run is the furthest one, not the heaviest', () => {
  // Sessions as historyOf builds them: `best` is picked by weight, so for a run
  // it is arbitrary — the furthest has to come from the sets themselves.
  const history = [
    { best: null, oneRm: null, sets: [{ distance_m: 5200, duration_s: 1560 }] },
    { best: null, oneRm: null, sets: [{ distance_m: 8000, duration_s: 2700 },
                                      { distance_m: 1200, duration_s: 400 }] },
    { best: null, oneRm: null, sets: [{ distance_m: 3000, duration_s: 900 }] },
  ];

  const { furthest, heaviest, bestRm } = workout.personalBests(history);
  assert.equal(furthest.distance_m, 8000, 'across every set of every session');
  assert.equal(workout.distanceLabel(furthest.distance_m), '4.97 mi');
  assert.equal(heaviest, null, 'a run weighs nothing');
  assert.equal(bestRm, null, 'and has no one-rep max to estimate');
});

test('a lift keeps the heaviest set as its record, and nothing is furthest', () => {
  const history = [
    { best: { weight_lb: 225, reps: 5 }, oneRm: 262, sets: [{ weight_lb: 225, reps: 5 }] },
    { best: { weight_lb: 275, reps: 3 }, oneRm: 303, sets: [{ weight_lb: 275, reps: 3 }] },
  ];

  const { heaviest, bestRm, furthest } = workout.personalBests(history);
  assert.equal(heaviest.weight_lb, 275);
  assert.equal(bestRm, 303);
  assert.equal(furthest, null, 'no distance anywhere, so no furthest');
});

test('a distance is one definition, whether it is a chip or a whole line', () => {
  assert.equal(workout.distanceLabel(5200), '3.23 mi');
  assert.equal(workout.distanceLabel(5200, { metric: true }), '5.20 km');
  assert.equal(workout.distanceLabel(0), null, 'nothing run is not "0.00 mi"');
  assert.equal(workout.distanceLabel(null), null);
  // The line still leads with exactly what the chip would show on its own.
  assert.ok(workout.cardioLine({ distance_m: 5200, duration_s: 1560 })
    .startsWith(workout.distanceLabel(5200)));
});

test('a last performance reads as whatever kind of exercise it was', () => {
  const run = { distance_m: 5200, duration_s: 1560 };
  const lift = { weight_lb: 225, reps: 5 };

  // The bug this replaces: a cardio set carries no weight and no reps, so the
  // lifting format rendered every one of them as "— lb × —".
  assert.equal(workout.setSummary(run, { category: 'cardio', name: 'Running' }),
    '3.23 mi · 26:00 · 8:03 /mi');
  assert.equal(workout.setSummary(run, null, 'Running'), '3.23 mi · 26:00 · 8:03 /mi',
    'recognised by name when the exercise row has gone');

  assert.equal(workout.setSummary(lift, { category: 'strength', name: 'Barbell Squat' }),
    '225 lb × 5');
  assert.equal(workout.setSummary({ weight_lb: null, reps: null }, null, 'Barbell Squat'),
    '— lb × —', 'a lift that recorded nothing still says so in lifting terms');

  assert.equal(workout.setSummary(null, null, 'Running'), '');
});

test('an hour-plus session shows hours, not ninety minutes', () => {
  assert.equal(workout.cardioLine({ distance_m: 40000, duration_s: 5400 }),
    '24.85 mi · 1:30:00 · 3:37 /mi');
});

test('a half-entered cardio set says only what it knows', () => {
  assert.equal(workout.cardioLine({ duration_s: 1800 }), '30:00', 'no distance, so no pace');
  assert.equal(workout.cardioLine({ distance_m: 1609.344 }), '1.00 mi');
  assert.equal(workout.cardioLine({}), '');
  assert.equal(workout.cardioLine(null), '');
});

test('pace needs both halves and never divides by zero', () => {
  assert.equal(workout.pacePer({ distance_m: 1609.344, duration_s: 480 }), '8:00 /mi');
  assert.equal(workout.pacePer({ distance_m: 1000, duration_s: 300 }, { metric: true }), '5:00 /km');
  assert.equal(workout.pacePer({ distance_m: 0, duration_s: 300 }), null);
  assert.equal(workout.pacePer({ distance_m: 1609.344, duration_s: 0 }), null);
  assert.equal(workout.pacePer({}), null);
});

test('a mile typed in survives the round trip through stored metres', () => {
  // What the row does: miles -> metres on the way in, metres -> miles on the way
  // out. Rounding must not shave a 3.10 mile run down to 3.09.
  const MILE_M = 1609.344;
  for (const miles of [0.5, 1, 3.1, 6.2, 13.1, 26.2]) {
    const stored = Math.round(miles * MILE_M);
    assert.equal(+(stored / MILE_M).toFixed(2), miles, `${miles} mi`);
  }
});

test('a run contributes no tonnage', async () => {
  const sets = [
    { weight_lb: 100, reps: 10, is_warmup: false, completed_at: 'T' },
    { distance_m: 5000, duration_s: 1500, is_warmup: false, completed_at: 'T' },
  ];
  assert.equal(workout.volume(sets), 1000, 'the lift only');
});

test('cardio sets group, order and reorder like any other', async () => {
  await seedSets([
    { id: 'run', name: 'Running', weight: null, reps: null },
    { id: 'bp', name: 'Bench', weight: 185, reps: 5 },
  ]);
  assert.deepEqual(await cards(), [['Running', 1], ['Bench', 1]]);

  const ordered = workout.orderGroups(workout.groupByExercise(await liveSets()), 'bp', 0);
  await workout.reindexSets(ordered.flatMap((g) => g.sets));
  assert.deepEqual(await cards(), [['Bench', 1], ['Running', 1]]);
});

test('distance and duration persist through a set update', async () => {
  const [set] = await seedSets([{ id: 'run', name: 'Running', weight: null, reps: null }]);

  await workout.updateSet(set, { distance_m: 5200 });
  const withTime = await workout.updateSet(set, { duration_s: 1560 });

  assert.equal(withTime.distance_m, 5200, 'the earlier write is not lost');
  assert.equal(withTime.duration_s, 1560);
  assert.equal(workout.cardioLine(withTime), '3.23 mi · 26:00 · 8:03 /mi');
});

test('a run does not become a personal record on load', () => {
  // estimate1RM has nothing to work with, and a PR flash on a run is nonsense.
  const run = { distance_m: 5000, duration_s: 1500, is_warmup: false, completed_at: 'T' };
  assert.equal(workout.isRecord(run, null), false);
});

// ---- routine categories ----------------------------------------------------

const routine = (name, position, category = null, owner = ME) =>
  ({ id: `r-${name}`, owner_email: owner, name, position, category });

test('routines group into categories, uncategorised last', () => {
  const rows = [
    routine('Pull A', 0, 'Upper'),
    routine('Legs', 1, 'Lower'),
    routine('Odd one', 2),
    routine('Push A', 3, 'Upper'),
  ];
  const groups = workout.groupRoutinesByCategory(rows, ME);

  assert.deepEqual(groups.map((g) => g.category), ['Upper', 'Lower', null]);
  assert.deepEqual(groups[0].routines.map((r) => r.name), ['Pull A', 'Push A']);
  assert.deepEqual(groups[2].routines.map((r) => r.name), ['Odd one']);
});

test('category order follows where the routines sit, not the alphabet', () => {
  // Zebra's routine comes first in the list, so Zebra is the first group.
  const rows = [routine('One', 0, 'Zebra'), routine('Two', 1, 'Apple')];
  assert.deepEqual(
    workout.groupRoutinesByCategory(rows, ME).map((g) => g.category), ['Zebra', 'Apple']);
});

test('grouping keeps other people and deleted routines out', () => {
  const rows = [
    routine('Mine', 0, 'Upper'),
    routine('Hers', 1, 'Upper', AANA),
    { ...routine('Gone', 2, 'Upper'), deleted_at: new Date().toISOString() },
  ];
  const groups = workout.groupRoutinesByCategory(rows, ME);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].routines.map((r) => r.name), ['Mine']);
});

test('grouping an empty list is an empty list, not one null group', () => {
  assert.deepEqual(workout.groupRoutinesByCategory([], ME), []);
});

test('uncategorised alone does not get a heading it cannot use', () => {
  const groups = workout.groupRoutinesByCategory([routine('Solo', 0)], ME);
  assert.deepEqual(groups.map((g) => g.category), [null]);
});

test('routineCategories offers each spelling once, alphabetically', () => {
  const rows = [
    routine('a', 0, 'Upper'), routine('b', 1, 'Lower'),
    routine('c', 2, 'Upper'), routine('d', 3), routine('e', 4, 'Cardio'),
  ];
  assert.deepEqual(workout.routineCategories(rows, ME), ['Cardio', 'Lower', 'Upper']);
});

test('a blank category is stored as uncategorised, not as whitespace', async () => {
  const saved = await workout.upsertRoutine({ name: 'Push A', category: '   ' }, ME, []);
  assert.equal(saved.category, null);

  const named = await workout.upsertRoutine({ name: 'Pull A', category: '  Upper ' }, ME, []);
  assert.equal(named.category, 'Upper', 'trimmed');
});

test('renaming a routine does not erase the category it already had', async () => {
  const first = await workout.upsertRoutine({ name: 'Legs', category: 'Lower' }, ME, []);
  // The builder saves name and notes; category is simply absent from the call.
  const renamed = await workout.upsertRoutine({ id: first.id, name: 'Leg day' }, ME, []);

  assert.equal(renamed.name, 'Leg day');
  assert.equal(renamed.category, 'Lower', 'absent must mean unchanged, not cleared');
});

test('a category can be cleared on purpose', async () => {
  const first = await workout.upsertRoutine({ name: 'Legs', category: 'Lower' }, ME, []);
  const cleared = await workout.upsertRoutine({ id: first.id, name: 'Legs', category: '' }, ME, []);
  assert.equal(cleared.category, null);
});

/**
 * Adding an exercise mid-workout opens it at the size you last did it.
 *
 * It used to open with a single blank row regardless, so a four-set exercise
 * took three taps of "add set" before you could start — while the same exercise
 * arriving from a routine already opened with its planned count.
 */
test('openingSets matches the number of working sets you did last time', () => {
  assert.equal(workout.openingSets([{ reps: 8 }, { reps: 8 }, { reps: 6 }]), 3);
  assert.equal(workout.openingSets([{ reps: 5 }]), 1);
});

test('openingSets falls back to one when there is no history', () => {
  assert.equal(workout.openingSets([]), 1, 'a first-time exercise still opens with a row');
  assert.equal(workout.openingSets(undefined), 1, 'and so does one with no prior entry at all');
  assert.equal(workout.openingSets(null), 1);
});

/**
 * The count comes from priorForm's `previous`, which is the most recent session
 * only — not a best-of, and not every session merged. Warm-ups and unchecked
 * sets are already excluded there, so they cannot inflate the opening size.
 */
test('the opening size follows the most recent session, not the biggest one', () => {
  const sessions = [
    { id: 'old', owner_email: ME, started_at: '2026-01-01T10:00:00Z' },
    { id: 'recent', owner_email: ME, started_at: '2026-02-01T10:00:00Z' },
  ];
  const sets = [
    ...[1, 2, 3, 4].map((n) => ({
      id: `o${n}`, session_id: 'old', exercise_id: 'bp', set_index: n,
      weight_lb: 100, reps: 8, completed_at: 'x',
    })),
    { id: 'r1', session_id: 'recent', exercise_id: 'bp', set_index: 0, weight_lb: 110, reps: 5, completed_at: 'x' },
    { id: 'r2', session_id: 'recent', exercise_id: 'bp', set_index: 1, weight_lb: 110, reps: 5, completed_at: 'x' },
    { id: 'rw', session_id: 'recent', exercise_id: 'bp', set_index: 2, weight_lb: 45, reps: 10, completed_at: 'x', is_warmup: true },
  ];

  const prior = workout.priorForm(workout.buildIndex(sets, sessions, ME), null);
  assert.equal(workout.openingSets(prior.get('bp').previous), 2,
    'two working sets last time, not the four from the older session and not the warm-up');
});

// ---- dragging a routine into a category ------------------------------------

const catRows = [
  routine('Push A', 0, 'Upper'),
  routine('Pull A', 1, 'Upper'),
  routine('Legs', 2, 'Lower'),
  routine('Odd one', 3, null),
];

test('reorderRows interleaves a header before each group', () => {
  const rows = workout.reorderRows(catRows, ME);
  assert.deepEqual(rows.map((r) => r.kind === 'header' ? `#${r.category}` : r.routine.name),
    ['#Upper', 'Push A', 'Pull A', '#Lower', 'Legs', '#null', 'Odd one']);
});

test('reorderRows adds no header when nothing is categorised', () => {
  const rows = workout.reorderRows([routine('A', 0), routine('B', 1)], ME);
  assert.deepEqual(rows.map((r) => r.kind), ['routine', 'routine']);
});

test('a routine dropped under another header takes that category', () => {
  const rows = workout.reorderRows(catRows, ME);
  // Push A (index 1) dropped to index 4, which is just under the Lower header.
  const result = workout.dropRoutineInto(rows, 'r-Push A', 4);

  assert.equal(result.category, 'Lower');
  assert.deepEqual(result.routines.map((r) => r.name), ['Pull A', 'Legs', 'Push A', 'Odd one']);
});

test('dropping into the uncategorised block clears the category', () => {
  const rows = workout.reorderRows(catRows, ME);
  const result = workout.dropRoutineInto(rows, 'r-Push A', 6);
  assert.equal(result.category, null);
});

test('dropping above the first header also clears it', () => {
  const rows = workout.reorderRows(catRows, ME);
  const result = workout.dropRoutineInto(rows, 'r-Legs', 0);
  assert.equal(result.category, null, 'there is no header above it to belong to');
  assert.equal(result.routines[0].name, 'Legs');
});

test('moving within a group keeps the category and only reorders', () => {
  const rows = workout.reorderRows(catRows, ME);
  // Pull A (index 2) up to index 1: still inside Upper.
  const result = workout.dropRoutineInto(rows, 'r-Pull A', 1);
  assert.equal(result.category, 'Upper');
  assert.deepEqual(result.routines.map((r) => r.name), ['Pull A', 'Push A', 'Legs', 'Odd one']);
});

test('dropRoutineInto returns every routine exactly once', () => {
  const rows = workout.reorderRows(catRows, ME);
  for (const to of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const result = workout.dropRoutineInto(rows, 'r-Legs', to);
    const names = result.routines.map((r) => r.name);
    assert.equal(names.length, 4, `to=${to}`);
    assert.equal(new Set(names).size, 4, `to=${to} lost or duplicated a routine`);
  }
});

test('dropRoutineInto refuses an id that is not in the list', () => {
  const rows = workout.reorderRows(catRows, ME);
  assert.equal(workout.dropRoutineInto(rows, 'r-nope', 2), null);
});

test('dropRoutineInto clamps an index past the end', () => {
  const rows = workout.reorderRows(catRows, ME);
  const result = workout.dropRoutineInto(rows, 'r-Push A', 999);
  assert.equal(result.category, null, 'the last block is uncategorised');
  assert.equal(result.routines[result.routines.length - 1].name, 'Push A');
});

// ---- fixing the end time of a forgotten workout -----------------------------

test('lastActivityAt is the newest checked set, not the newest row', () => {
  const sets = [
    { completed_at: '2026-09-01T18:05:00.000Z' },
    { completed_at: '2026-09-01T18:42:00.000Z' },
    { completed_at: null },                                        // never done
    { completed_at: '2026-09-01T19:30:00.000Z', deleted_at: '2026-09-01T19:31:00.000Z' },
  ];
  assert.equal(workout.lastActivityAt(sets), '2026-09-01T18:42:00.000Z');
  assert.equal(workout.lastActivityAt([{ completed_at: null }]), null);
  assert.equal(workout.lastActivityAt([]), null);
});

test('a stated duration lands the end that far after the start', () => {
  const start = new Date('2026-09-01T17:00:00');
  const now = new Date('2026-09-01T21:30:00');
  const end = workout.endFromDuration(start, 75, now);
  assert.equal(end.getTime(), new Date('2026-09-01T18:15:00').getTime());
});

test('a duration crossing midnight needs no date guessing', () => {
  // The whole reason duration replaced a wall-clock time: 100 minutes after
  // 11pm is one moment, whatever day the clock face would have implied.
  const start = new Date('2026-08-31T23:00:00');
  const now = new Date('2026-09-01T09:00:00');
  const end = workout.endFromDuration(start, 100, now);
  assert.equal(end.getTime(), new Date('2026-09-01T00:40:00').getTime());
});

test('more time than has elapsed clamps to now, not the future', () => {
  const start = new Date('2026-09-01T17:00:00');
  const now = new Date('2026-09-01T17:50:00');
  assert.equal(workout.endFromDuration(start, 120, now).getTime(), now.getTime());
});

test('zero or nonsense means the start, where the 0m readout shows it', () => {
  const start = new Date('2026-09-01T17:00:00');
  const now = new Date('2026-09-01T18:00:00');
  assert.equal(workout.endFromDuration(start, 0, now).getTime(), start.getTime());
  assert.equal(workout.endFromDuration(start, -5, now).getTime(), start.getTime());
  assert.equal(workout.endFromDuration(start, NaN, now).getTime(), start.getTime());
});

test('finishSession stores the chosen end, not the moment the button was pressed', async () => {
  const session = await workout.startSession({ name: 'Forgotten', ownerEmail: ME });
  const endedAt = new Date(Date.parse(session.started_at) + 45 * 60_000);

  const saved = await workout.finishSession(session, endedAt);
  assert.equal(saved.ended_at, endedAt.toISOString());
});

test('finishSession refuses an end before the start', async () => {
  const session = await workout.startSession({ name: 'Clamped', ownerEmail: ME });
  const saved = await workout.finishSession(session, new Date(Date.parse(session.started_at) - 60_000));
  assert.equal(saved.ended_at, session.started_at, 'clamped, not time-travelled');
});

test('finishSession without an override still means now', async () => {
  const session = await workout.startSession({ name: 'Normal', ownerEmail: ME });
  const before = Date.now();
  const saved = await workout.finishSession(session);
  assert.ok(Date.parse(saved.ended_at) >= before, 'the default is unchanged');
});

// ---- filtering the exercise library ------------------------------------------

const ex = (name, over = {}) => ({ id: name, owner_email: ME, name, ...over });

test('equipmentOf trusts the name over the field, because the field lies', () => {
  // Real row: the import stamped "cable" on a dumbbell exercise, and it was
  // passing the cable filter while saying Dumbbell to the reader.
  assert.equal(workout.equipmentOf(ex('Triceps Extension (Dumbbell)', { equipment: 'cable' })),
    'dumbbell');
  // The field still serves rows whose names carry nothing.
  assert.equal(workout.equipmentOf(ex('Triceps Pushdown', { equipment: 'cable' })), 'cable');
  assert.equal(workout.equipmentOf(ex('X', { equipment: 'body only' })), 'bodyweight');
  assert.equal(workout.equipmentOf(ex('X', { equipment: 'Bodyweight ' })), 'bodyweight');
});

test('equipmentOf falls back to the trailing parenthetical only', () => {
  assert.equal(workout.equipmentOf(ex('Bench Press (Barbell)')), 'barbell');
  assert.equal(workout.equipmentOf(ex('Triceps Pushdown (Rope)')), 'cable');
  assert.equal(workout.equipmentOf(ex('Shoulder Press (Machine Plates)')), 'machine');
  assert.equal(workout.equipmentOf(ex('Triceps Dip (Weighted)')), 'bodyweight');
  // The word barbell mid-name is not a parenthetical and must not classify:
  // a rule that scans the whole name gets Cable Crossover wrong the same way.
  assert.equal(workout.equipmentOf(ex('Barbell Row')), null);
  assert.equal(workout.equipmentOf(ex('Plain Squat')), null);
});

test('groupOf places every specific muscle in exactly one family', () => {
  const seen = new Set();
  for (const [group, keys] of Object.entries(workout.MUSCLE_GROUPS)) {
    for (const key of keys) {
      assert.equal(workout.groupOf(key), group);
      assert.ok(!seen.has(key), `${key} appears twice`);
      seen.add(key);
    }
  }
  assert.equal(workout.groupOf('nonsense'), null);
});

test('filterExercises narrows by group, muscle and equipment together', () => {
  const library = [
    ex('Bench Press (Barbell)', { primary_muscle: 'chest' }),
    ex('Bicep Curl (Dumbbell)', { primary_muscle: 'biceps' }),
    ex('Skullcrusher', { primary_muscle: 'triceps' }),
    ex('Triceps Pushdown (Rope)', { primary_muscle: 'triceps' }),
    ex('Squat (Barbell)', { primary_muscle: 'quads' }),
  ];

  assert.deepEqual(
    workout.filterExercises(library, { group: 'arms' }).map((e) => e.name),
    ['Bicep Curl (Dumbbell)', 'Skullcrusher', 'Triceps Pushdown (Rope)']);

  // The specific muscle wins over its group: "arms, and of arms, triceps".
  assert.deepEqual(
    workout.filterExercises(library, { group: 'arms', muscle: 'triceps' }).map((e) => e.name),
    ['Skullcrusher', 'Triceps Pushdown (Rope)']);

  assert.deepEqual(
    workout.filterExercises(library, { group: 'arms', muscle: 'triceps', equipment: 'cable' })
      .map((e) => e.name),
    ['Triceps Pushdown (Rope)']);

  assert.equal(workout.filterExercises(library, {}).length, library.length, 'no filters, no change');
});

test('an exercise with no muscle data is classified by its name', () => {
  const library = [ex('Hammer Curl'), ex('Leg Press')];
  assert.deepEqual(workout.filterExercises(library, { group: 'arms' }).map((e) => e.name),
    ['Hammer Curl']);
});

// ---- ranking replacements ----------------------------------------------------

test('rankSimilar puts the same muscle first and never offers the exercise itself', () => {
  const library = [
    ex('Squat (Barbell)', { primary_muscle: 'quads' }),
    ex('Skullcrusher', { primary_muscle: 'triceps' }),
    ex('Triceps Pushdown (Rope)', { primary_muscle: 'triceps' }),
    ex('Bicep Curl (Dumbbell)', { primary_muscle: 'biceps' }),
    ex('Triceps Extension (Cable)', { primary_muscle: 'triceps' }),
  ];
  const outgoing = ex('Triceps Pushdown (Rope)', { primary_muscle: 'triceps' });
  const ranked = workout.rankSimilar(library, outgoing).map((e) => e.name);

  assert.ok(!ranked.includes('Triceps Pushdown (Rope)'), 'not a replacement for itself');
  assert.deepEqual(ranked.slice(0, 2).sort(), ['Skullcrusher', 'Triceps Extension (Cable)'],
    'triceps before anything else');
  assert.equal(ranked[ranked.length - 1], 'Squat (Barbell)', 'legs last for an arm swap');
});

test('the same movement shape counts even across implements', () => {
  const library = [
    ex('Shoulder Press (Machine Plates)', { primary_muscle: 'shoulders' }),
    ex('Lateral Raise', { primary_muscle: 'shoulders' }),
  ];
  const outgoing = ex('Overhead Press (Barbell)', { primary_muscle: 'shoulders' });
  const ranked = workout.rankSimilar(library, outgoing).map((e) => e.name);

  assert.equal(ranked[0], 'Shoulder Press (Machine Plates)',
    'a press replaces a press before a raise does');
});

test('equipment breaks ties between equals', () => {
  const library = [
    ex('Incline Bench Press (Dumbbell)', { primary_muscle: 'chest' }),
    ex('Incline Bench Press (Barbell)', { primary_muscle: 'chest' }),
  ];
  const outgoing = ex('Bench Press (Barbell)', { primary_muscle: 'chest' });
  const ranked = workout.rankSimilar(library, outgoing).map((e) => e.name);
  assert.equal(ranked[0], 'Incline Bench Press (Barbell)');
});

// ---- plates before the set is checked ---------------------------------------

test('effectiveWeight uses the typed value when there is one', () => {
  assert.deepEqual(workout.effectiveWeight({ weight_lb: 185 }, { weight_lb: 155 }),
    { lb: 185, ghost: false });
});

test('an empty set borrows the placeholder, marked as tentative', () => {
  // This is the fix: the plate calculator must answer before the set is
  // checked, which is the only time anyone needs it.
  assert.deepEqual(workout.effectiveWeight({ weight_lb: null }, { weight_lb: 155 }),
    { lb: 155, ghost: true });
});

test('no value anywhere means no plates, not zero plates', () => {
  assert.equal(workout.effectiveWeight({ weight_lb: null }, null), null);
  assert.equal(workout.effectiveWeight({ weight_lb: '' }, { weight_lb: null }), null);
});

test('a typed zero is a value, not a gap', () => {
  assert.deepEqual(workout.effectiveWeight({ weight_lb: 0 }, { weight_lb: 155 }),
    { lb: 0, ghost: false });
});

// ---- exercise notes ----------------------------------------------------------

test('a note on a shared exercise does not claim the row', async () => {
  const shared = { id: 'ex-shared', owner_email: null, name: 'Bench Press (Barbell)' };
  const saved = await workout.setExerciseNotes(shared, 'seat at 4, thumbless grip', ME);

  assert.equal(saved.notes, 'seat at 4, thumbless grip');
  assert.equal(saved.owner_email, null,
    'owner_email must stay null or the other member loses the row');
});

test('a blank note clears rather than storing whitespace', async () => {
  const shared = { id: 'ex-blank', owner_email: null, name: 'Squat (Barbell)', notes: 'old' };
  const saved = await workout.setExerciseNotes(shared, '   ', ME);
  assert.equal(saved.notes, null);
});
