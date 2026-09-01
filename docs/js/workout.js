/**
 * workout.js — training domain logic.
 *
 * Same rules as food.js: works off arrays already in IndexedDB, never touches
 * the network. A gym is the worst signal environment either of us will be in,
 * so a set must land the instant the check is tapped.
 */

import * as local from './local.js';
import * as sync from './sync.js';
import { muscleFor, movementFor } from './muscle-map.js';

export const DEFAULT_REST_SECONDS = 120;

// ---- sessions --------------------------------------------------------------

/** The workout in progress, if any. Only one can be open at a time. */
export function activeSession(sessions, ownerEmail) {
  return sessions
    .filter((s) => s.owner_email === ownerEmail && !s.deleted_at && !s.ended_at)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0] ?? null;
}

export function recentSessions(sessions, ownerEmail, limit = 10) {
  return sessions
    .filter((s) => s.owner_email === ownerEmail && !s.deleted_at && s.ended_at)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
    .slice(0, limit);
}

export async function startSession({ name, routineId, ownerEmail }) {
  const session = await local.save('sessions', {
    name: name || null,
    routine_id: routineId ?? null,
    started_at: new Date().toISOString(),
    ended_at: null,
  }, ownerEmail);

  sync.nudge();
  return session;
}

/**
 * When this workout last actually did anything: the newest checked set.
 *
 * The truth the finish sheet offers when a session was left running — the same
 * definition the idle-workout push uses server-side, because "when you stopped"
 * and "when you remembered the app" are different times, often by hours.
 */
export function lastActivityAt(sets) {
  let newest = null;
  for (const s of sets) {
    if (s.deleted_at || !s.completed_at) continue;
    if (!newest || s.completed_at > newest) newest = s.completed_at;
  }
  return newest;
}

/**
 * The end a stated duration produces, for the finish sheet.
 *
 * "It was about an hour" is how Carter actually remembers a workout, and unlike
 * a wall-clock time it carries no date ambiguity — start plus an hour is one
 * moment whatever day it is, which is why this replaced a resolver that had to
 * guess which day "18:42" meant.
 *
 * Clamped into [started_at, now]: a workout cannot end before it began or after
 * the present. The sheet shows the duration the clamp produces, so entering
 * more time than has elapsed visibly falls back to "so far" rather than
 * silently storing the future.
 */
export function endFromDuration(startedAt, minutes, now = new Date()) {
  const start = new Date(startedAt);
  const wanted = Number(minutes);

  if (!Number.isFinite(wanted) || wanted <= 0) return start;

  const end = new Date(start.getTime() + Math.round(wanted) * 60_000);
  if (end > now) return now < start ? start : now;
  return end;
}

/** @param endedAt  optional — for workouts finished later than they ended. */
export async function finishSession(session, endedAt = null) {
  const started = new Date(session.started_at);
  const wanted = endedAt ? new Date(endedAt) : new Date();

  const saved = await local.save('sessions', {
    ...session,
    ended_at: (wanted < started ? started : wanted).toISOString(),
  }, session.owner_email);

  sync.nudge();
  return saved;
}

export async function discardSession(session, sets) {
  for (const set of setsForSession(sets, session.id)) {
    await local.remove('session_sets', set.id);
  }
  await local.remove('sessions', session.id);
  sync.nudge();
}

// ---- sets ------------------------------------------------------------------

export function setsForSession(sets, sessionId) {
  return sets
    .filter((s) => s.session_id === sessionId && !s.deleted_at)
    .sort((a, b) => a.set_index - b.set_index);
}

/**
 * Sets grouped by exercise, in the order the exercises were first added — so
 * the screen matches the order you actually worked through them.
 */
export function groupByExercise(sets) {
  const groups = new Map();

  for (const set of sets) {
    const key = set.exercise_id ?? set.exercise_name;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        exerciseId: set.exercise_id,
        name: set.exercise_name,
        sets: [],
      });
    }
    groups.get(key).sets.push(set);
  }

  return [...groups.values()];
}

/**
 * How many sets to open an exercise with when you add it mid-workout.
 *
 * As many as you did last time it appeared, and never fewer than one. Adding an
 * exercise used to give a single blank row, so a four-set exercise meant three
 * taps of "add set" before you could start — while the same exercise arriving
 * from a routine opened with its planned count.
 *
 * The rows stay empty on purpose, exactly like the planned ones: last time's
 * numbers show as placeholders per position, and checking a set without typing
 * adopts them. Writing the values in instead would mean clearing a box to change
 * one, which is the thing the placeholder convention exists to avoid.
 */
export function openingSets(previous) {
  return Math.max(1, (previous ?? []).length);
}

export async function addSet({ session, exercise, weight, reps, isWarmup, ownerEmail, existingSets }) {
  const forExercise = existingSets.filter((s) => (s.exercise_id ?? s.exercise_name) === (exercise.id ?? exercise.name));
  const nextIndex = existingSets.length;

  const set = await local.save('session_sets', {
    session_id: session.id,
    exercise_id: exercise.id ?? null,
    // Snapshotted for the same reason food_log snapshots macros: renaming or
    // deleting an exercise must not corrupt training history.
    exercise_name: exercise.name,
    set_index: nextIndex,
    weight_lb: weight == null ? null : Number(weight),
    reps: reps == null ? null : Number(reps),
    is_warmup: Boolean(isWarmup),
    completed_at: null,
  }, ownerEmail);

  sync.nudge();
  return { set, positionWithinExercise: forExercise.length + 1 };
}

/**
 * Change one field of a set.
 *
 * Two things are needed to stop the checkmark reverting reps you just typed, and
 * only having the first was why it kept coming back:
 *
 *  1. Re-read the stored row instead of trusting the caller's copy. Handlers
 *     close over the set as it was when the row rendered, which is a revision
 *     behind by the time `click` runs.
 *  2. Serialise per row. Re-reading makes this a read-modify-write, and `change`
 *     and `click` are separate listeners that do not await each other — so the
 *     click's read could land before the change's write and merge the checkmark
 *     into the old reps, putting the prefilled default back.
 */
export async function updateSet(set, fields) {
  const saved = await local.serialise(`session_sets:${set.id}`, async () => {
    const current = (await local.get('session_sets', set.id)) ?? set;
    return local.save('session_sets', { ...current, ...fields }, set.owner_email);
  });

  sync.nudge();
  return saved;
}

export async function removeSet(id) {
  const row = await local.remove('session_sets', id);
  sync.nudge();
  return row;
}

/**
 * Write a session's sets back in the order given, renumbering as it goes.
 *
 * `set_index` is what every reader orders by — the set rows, and the exercise
 * cards through groupByExercise's first-appearance rule — so moving an exercise
 * or slotting a warm-up in front of its working sets is entirely a matter of
 * renumbering. Rows whose index already matches are skipped, so a reorder writes
 * only what actually moved.
 */
export async function reindexSets(ordered) {
  const written = [];

  for (const [index, set] of ordered.entries()) {
    if (set.set_index === index) continue;
    written.push(await updateSet(set, { set_index: index }));
  }

  return written;
}

/**
 * Move one item to an index, leaving the input alone.
 *
 * Exercise cards, routines and a routine's exercises all mean the same thing by
 * "reorder" and differ only in how an item is identified, so they share this
 * rather than each carrying their own copy of the splice.
 */
function moveTo(list, matches, toIndex) {
  const from = list.findIndex(matches);
  if (from === -1) return list;

  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);
  return next;
}

/** Exercise cards in display order, which is what a reorder rearranges. */
export function orderGroups(groups, fromKey, toIndex) {
  return moveTo(groups, (g) => g.key === fromKey, toIndex);
}

/**
 * Add a warm-up to an exercise, ahead of its working sets.
 *
 * Warm-ups come first or they are not warm-ups. addSet can only append to the
 * session, so the set is created and then the whole session is renumbered with
 * it slotted into the front of its own group.
 */
export async function addWarmupSet({ session, group, exercise, weight, ownerEmail, existingSets }) {
  const { set } = await addSet({
    session, exercise, weight, reps: null, isWarmup: true, ownerEmail, existingSets,
  });

  const keyOf = (s) => s.exercise_id ?? s.exercise_name;
  const ordered = [];
  let placed = false;

  for (const s of existingSets) {
    // In front of the first set of this exercise that is not itself a warm-up.
    if (!placed && keyOf(s) === group.key && !s.is_warmup) {
      ordered.push(set);
      placed = true;
    }
    ordered.push(s);
  }
  if (!placed) ordered.push(set);

  await reindexSets(ordered);
  return set;
}

/**
 * Another round of the same exercise: as many more sets as it already has,
 * carrying its current loads.
 *
 * They land in the same card rather than a second one, because a card *is* an
 * exercise here — groupByExercise keys on the exercise, and giving one exercise
 * two independent cards would need an instance column the schema does not have.
 */
export async function duplicateExercise({ session, group, ownerEmail, existingSets }) {
  const exercise = { id: group.exerciseId, name: group.name };
  const source = group.sets.filter((s) => !s.is_warmup);
  const template = source.length ? source : group.sets;

  let existing = existingSets;
  const made = [];

  for (const set of template) {
    const { set: created } = await addSet({
      session,
      exercise,
      weight: set.weight_lb,
      reps: set.reps,
      isWarmup: set.is_warmup,
      ownerEmail,
      existingSets: existing,
    });
    existing = [...existing, created];
    made.push(created);
  }

  return made;
}

/** Take a whole exercise out of the workout. Soft, like every other delete. */
export async function removeExercise(group) {
  for (const set of group.sets) await local.remove('session_sets', set.id);
  sync.nudge();
  return group.sets.length;
}

/**
 * Swap an exercise mid-workout — the rack is taken, the machine is broken.
 *
 * Sets already checked off stay put, under the exercise they were actually done
 * on; only the unchecked ones move across, prefilled from the new exercise's own
 * history. So swapping before you start moves the whole card, and swapping
 * halfway through splits it in two — which is the honest record either way.
 *
 * Set indices are left alone, so the new card lands where the old one was in the
 * workout rather than jumping to the end.
 */
export async function replaceExercise({ session, group, exercise, previous, ownerEmail, existingSets }) {
  const pending = group.sets.filter((s) => !s.completed_at);
  const kept = group.sets.filter((s) => s.completed_at);

  // Stamp what stays behind as an exercise you moved on from. It still counts
  // for volume, history and records — you lifted it — but a replace means "I am
  // switching to this", so rebuilding the routine afterwards should not plan the
  // thing you were switching away from.
  const replacedAt = new Date().toISOString();
  for (const set of kept) await updateSet(set, { replaced_at: replacedAt });

  // Nothing left to move. The card is finished, so the swap means "now do this
  // one instead" — fresh sets, as many as the new exercise took last time,
  // exactly as if it had been added from the picker.
  if (!pending.length) {
    const made = [];
    let existing = existingSets;
    for (let n = 0; n < openingSets(previous); n++) {
      const { set } = await addSet({
        session, exercise, weight: null, reps: null,
        isWarmup: false, ownerEmail, existingSets: existing,
      });
      made.push(set);
      existing = [...existing, set];
    }
    return made;
  }

  const moved = [];
  for (const set of pending) {
    moved.push(await updateSet(set, {
      exercise_id: exercise.id ?? null,
      exercise_name: exercise.name,
      // Cleared, not carried. This used to write the heaviest set of the new
      // exercise's last session into every row — the same flat number repeated,
      // sitting as a real value where a placeholder should be. Null is what
      // lets the per-position placeholders (that exercise's actual last
      // session, set by set) show through, and the checkmark adopts them.
      weight_lb: null,
      reps: null,
    }));
  }
  return moved;
}

// ---- history ---------------------------------------------------------------

/**
 * What you did for this exercise last time, so the set rows can prefill instead
 * of making you remember. This is the single most useful number on the screen.
 */
export function lastPerformance(sets, sessions, ownerEmail, exerciseId, exerciseName, excludeSessionId) {
  const finished = new Map(
    sessions
      .filter((s) => s.owner_email === ownerEmail && !s.deleted_at && s.id !== excludeSessionId)
      .map((s) => [s.id, s]),
  );

  const matching = sets
    .filter((s) => !s.deleted_at && finished.has(s.session_id))
    .filter((s) => (exerciseId ? s.exercise_id === exerciseId : s.exercise_name === exerciseName))
    .filter((s) => !s.is_warmup && s.completed_at);

  if (!matching.length) return null;

  // Most recent session that included this exercise.
  const newest = matching.reduce((best, s) => {
    const a = finished.get(s.session_id).started_at;
    return !best || a > finished.get(best.session_id).started_at ? s : best;
  }, null);

  const sessionId = newest.session_id;
  const sessionSets = matching
    .filter((s) => s.session_id === sessionId)
    .sort((a, b) => a.set_index - b.set_index);

  return {
    date: finished.get(sessionId).started_at,
    sets: sessionSets,
    best: sessionSets.reduce((b, s) => (!b || (s.weight_lb ?? 0) > (b.weight_lb ?? 0) ? s : b), null),
  };
}

/**
 * Every session that included this exercise, newest first, with its sets.
 *
 * Two years of imported history makes this the most informative screen in the
 * app — it answers "am I actually getting stronger" without a chart.
 */
export function exerciseHistory(sets, sessions, ownerEmail, exerciseId, exerciseName, limit = 40) {
  const owned = new Map(
    sessions
      .filter((s) => s.owner_email === ownerEmail && !s.deleted_at)
      .map((s) => [s.id, s]),
  );

  const matching = sets
    .filter((s) => !s.deleted_at && owned.has(s.session_id))
    .filter((s) => (exerciseId ? s.exercise_id === exerciseId : s.exercise_name === exerciseName));

  const grouped = new Map();
  for (const set of matching) {
    if (!grouped.has(set.session_id)) grouped.set(set.session_id, []);
    grouped.get(set.session_id).push(set);
  }

  return [...grouped.entries()]
    .map(([sessionId, entrySets]) => {
      const ordered = entrySets.sort((a, b) => a.set_index - b.set_index);
      const working = ordered.filter((s) => !s.is_warmup);
      const best = working.reduce((b, s) => (!b || (s.weight_lb ?? 0) > (b.weight_lb ?? 0) ? s : b), null);

      return {
        session: owned.get(sessionId),
        date: owned.get(sessionId).started_at,
        sets: ordered,
        best,
        volume: volume(ordered),
        oneRm: best ? estimate1RM(best.weight_lb, best.reps) : null,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limit);
}

/** Heaviest set ever, and the best estimated 1RM, across all history. */
export function personalBests(history) {
  let heaviest = null;
  let bestRm = null;
  let furthest = null;

  for (const entry of history) {
    if (entry.best && (!heaviest || (entry.best.weight_lb ?? 0) > (heaviest.weight_lb ?? 0))) {
      heaviest = entry.best;
    }
    if (entry.oneRm && (!bestRm || entry.oneRm > bestRm)) bestRm = entry.oneRm;

    // Every set, not just entry.best: a session's best set is picked by weight,
    // which says nothing at all about how far anybody ran.
    for (const set of entry.sets ?? []) {
      if ((Number(set?.distance_m) || 0) > (Number(furthest?.distance_m) || 0)) furthest = set;
    }
  }
  return { heaviest, bestRm, furthest };
}

// ---- numbers ---------------------------------------------------------------

/** Total load moved. Warm-ups excluded — they aren't working volume. */
export function volume(sets) {
  return sets
    .filter((s) => !s.deleted_at && !s.is_warmup && s.completed_at)
    // A run contributes no tonnage. It already would not, since weight_lb is
    // null, but saying so stops anyone "fixing" that into distance later.
    .filter((s) => s.distance_m == null && s.duration_s == null)
    .reduce((total, s) => total + (Number(s.weight_lb) || 0) * (Number(s.reps) || 0), 0);
}

/** Epley. An estimate, and labelled as one wherever it's shown. */
export function estimate1RM(weightLb, reps) {
  const w = Number(weightLb) || 0;
  const r = Number(reps) || 0;
  if (!w || !r) return null;
  if (r === 1) return w;
  return Math.round(w * (1 + r / 30));
}

export function elapsed(startedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatClock(seconds) {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const s = Math.max(0, seconds) % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---- routines --------------------------------------------------------------

/**
 * Routines in display order: where you put them, then alphabetically.
 *
 * The name is the tiebreak rather than the sort because `position` defaults to
 * 0 — a routine created offline, or by an importer that never thought about
 * order, still lands somewhere predictable instead of moving between reads.
 */
export function routinesFor(routines, ownerEmail) {
  return routines
    .filter((r) => r.owner_email === ownerEmail && !r.deleted_at)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
}

/**
 * Routines grouped into their categories, in display order.
 *
 * Category order is the order the categories first appear in the flat list, so
 * dragging a routine also decides where its category sits — there is no separate
 * ordering to keep in step, and no second reorder UI to build. Uncategorised
 * always goes last: it is the leftovers, not a category anyone chose.
 *
 * Matching is exact rather than case-insensitive. "Push" and "push" being two
 * groups is confusing, but silently folding them means a rename you did not ask
 * for, and the category picker offers the existing spellings precisely so the
 * question does not come up.
 */
export function groupRoutinesByCategory(routines, ownerEmail) {
  const groups = new Map();

  for (const routine of routinesFor(routines, ownerEmail)) {
    const key = routine.category ?? null;
    if (!groups.has(key)) groups.set(key, { category: key, routines: [] });
    groups.get(key).routines.push(routine);
  }

  const out = [...groups.values()];
  const loose = out.findIndex((g) => g.category === null);
  if (loose !== -1) out.push(out.splice(loose, 1)[0]);
  return out;
}

/** The categories in use, for offering rather than retyping. */
export function routineCategories(routines, ownerEmail) {
  return [...new Set(
    routinesFor(routines, ownerEmail).map((r) => r.category).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

/** Where a newly created routine goes: the end of the list, not the top. */
export function nextRoutinePosition(routines, ownerEmail) {
  return routines
    .filter((r) => r.owner_email === ownerEmail && !r.deleted_at)
    .reduce((next, r) => Math.max(next, (r.position ?? 0) + 1), 0);
}

/**
 * The grouped reorder list: a category header followed by its routines.
 *
 * Headers are rows in the same array as the routines rather than wrappers around
 * them, because $dragCard works on one flat list of equal-height cards and hands
 * back an index into it. Interleaving them is what lets a single drag express
 * both "third in the list" and "and now it is a Lower routine".
 *
 * No headers at all when nothing is categorised: there is only one group, and a
 * lone heading is a row that cannot be dropped anywhere useful.
 */
export function reorderRows(routines, ownerEmail) {
  const groups = groupRoutinesByCategory(routines, ownerEmail);
  if (groups.length < 2 && groups[0]?.category == null) {
    return (groups[0]?.routines ?? []).map((routine) => ({ kind: 'routine', routine }));
  }

  return groups.flatMap((group) => [
    { kind: 'header', category: group.category },
    ...group.routines.map((routine) => ({ kind: 'routine', routine })),
  ]);
}

/**
 * Where a routine ends up when it is dragged in that list.
 *
 * Its category is whichever header it came to rest after — so moving it into
 * another group and moving it within its own group are the same gesture, and
 * dropping it in the uncategorised block clears it. Above the first header it
 * keeps nothing, which is the same thing.
 *
 * Pure: hands back the category and the new routine order, and writes neither.
 */
export function dropRoutineInto(rows, fromId, toIndex) {
  const from = rows.findIndex((r) => r.kind === 'routine' && r.routine.id === fromId);
  if (from === -1) return null;

  const next = rows.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved);

  const landed = next.indexOf(moved);
  let category = null;
  for (let i = landed - 1; i >= 0; i--) {
    if (next[i].kind === 'header') { category = next[i].category; break; }
  }

  return {
    category,
    routines: next.filter((r) => r.kind === 'routine').map((r) => r.routine),
  };
}

/**
 * Persist a routine order, writing only the rows that actually moved.
 *
 * Dragging one routine one place shifts two rows, not the whole list, which
 * keeps the outbox — and therefore the next sync — proportional to the edit.
 */
export async function reindexRoutines(ordered) {
  const written = [];

  for (const [index, routine] of ordered.entries()) {
    if (routine.position === index) continue;
    written.push(await local.save('routines', { ...routine, position: index }, routine.owner_email));
  }

  sync.nudge();
  return written;
}

/**
 * Save a finished session's shape as a reusable routine — cheaper than a
 * separate builder, and the workout you just did is the best description of
 * what you meant to do.
 */
export async function saveSessionAsRoutine({ name, session, sets, ownerEmail, routines = [] }) {
  const routine = await local.save('routines', {
    name,
    notes: null,
    position: nextRoutinePosition(routines, ownerEmail),
  }, ownerEmail);
  await writePlan({ routineId: routine.id, session, sets, ownerEmail });

  sync.nudge();
  return routine;
}

/**
 * Rewrite a routine's plan from the session that was just finished.
 *
 * For when the routine was the plan and the workout was the correction: you
 * swapped an exercise, added a set, went up in weight, and want next week to
 * start from what you actually did. The routine row itself survives, so its
 * name and its id — and therefore its history — carry on.
 *
 * The old plan is tombstoned rather than edited in place. Matching up old rows
 * to new ones has no answer once exercises have been swapped or reordered, and
 * a soft delete is what the sync layer expects anyway.
 */
export async function updateRoutineFromSession({ routine, session, sets, ownerEmail, allRoutineExercises }) {
  for (const item of routineExercises(allRoutineExercises, routine.id)) {
    await local.remove('routine_exercises', item.id);
  }
  const written = await writePlan({ routineId: routine.id, session, sets, ownerEmail });

  sync.nudge();
  return written;
}

/**
 * One exercise per card, in the order they were worked, with what was lifted.
 *
 * Every card in the session goes in, however it got there — planned, added
 * halfway through, or swapped in over something else. The old plan is not
 * consulted at all, so the result is a description of the session rather than
 * a merge with what you meant to do.
 *
 * "Lifted" means checked off. Counting unchecked sets meant a set left sitting
 * at its prefilled weight could set the target: drop from 185 to 155, do two,
 * leave the third untouched, and the routine recorded 185×3 — a weight nobody
 * lifted. Completed sets win; an exercise with none falls back to all of them,
 * so one you skipped entirely stays in the plan at its planned shape instead of
 * silently disappearing.
 */
async function writePlan({ routineId, session, sets, ownerEmail }) {
  const groups = groupByExercise(setsForSession(sets, session.id));
  const written = [];
  let position = 0;

  for (const group of groups) {
    // A card you replaced away from is history, not plan. Its sets stay in the
    // session; they just do not describe what you intend to do next time.
    if (group.sets.every((s) => s.replaced_at)) continue;

    const working = group.sets.filter((s) => !s.is_warmup);
    const done = working.filter((s) => s.completed_at);
    const counted = done.length ? done : working;
    const heaviest = counted.reduce((b, s) => (!b || (s.weight_lb ?? 0) > (b.weight_lb ?? 0) ? s : b), null);

    written.push(await local.save('routine_exercises', {
      routine_id: routineId,
      exercise_id: group.exerciseId ?? null,
      position: position++,
      target_sets: counted.length || group.sets.length,
      target_reps: heaviest?.reps ? String(heaviest.reps) : null,
      target_weight_lb: heaviest?.weight_lb ?? null,
      rest_seconds: DEFAULT_REST_SECONDS,
      notes: group.name,      // keeps the name if the exercise row disappears
    }, ownerEmail));
  }

  return written;
}

/** Create or rename a routine. Used by the builder; saving from a session uses
 *  saveSessionAsRoutine above. */
export async function upsertRoutine({ id, name, notes, category }, ownerEmail, routines = []) {
  // Renaming has to start from the row on disk. local.save writes exactly what
  // it is handed, so a column left out of the object is a column erased — which
  // is how a rename would drop the routine's place in the list.
  const existing = id ? await local.get('routines', id) : null;

  const routine = await local.save('routines', {
    ...(existing ?? {}),
    ...(id ? { id } : {}),
    name,
    notes: notes ?? existing?.notes ?? null,
    // Trimmed, and blank becomes null: "  " and "" and absent all have to mean
    // uncategorised, or the list grows a group whose heading is whitespace.
    category: category === undefined
      ? (existing?.category ?? null)
      : (String(category).trim() || null),
    position: existing?.position ?? nextRoutinePosition(routines, ownerEmail),
  }, ownerEmail);
  sync.nudge();
  return routine;
}

export async function addRoutineExercise({ routineId, exercise, position, ownerEmail }) {
  const item = await local.save('routine_exercises', {
    routine_id: routineId,
    exercise_id: exercise.id ?? null,
    position,
    // A routine is just an ordered list of exercises. Weights and rep ranges
    // live in history, which is more honest than a target that goes stale.
    target_sets: null,
    target_reps: null,
    target_weight_lb: null,
    rest_seconds: DEFAULT_REST_SECONDS,
    // Keeps the name readable even if the exercise row is later deleted.
    notes: exercise.name,
  }, ownerEmail);
  sync.nudge();
  return item;
}

export async function updateRoutineExercise(item, fields) {
  const saved = await local.save('routine_exercises', { ...item, ...fields }, item.owner_email);
  sync.nudge();
  return saved;
}

export async function removeRoutineExercise(id) {
  const row = await local.remove('routine_exercises', id);
  sync.nudge();
  return row;
}

/** A routine's exercises in display order, which is what a reorder rearranges. */
export function orderRoutineExercises(items, fromId, toIndex) {
  return moveTo(items, (r) => r.id === fromId, toIndex);
}

/** Persist a routine's exercise order, writing only the rows that moved. */
export async function reindexRoutineExercises(ordered) {
  const written = [];

  for (const [index, item] of ordered.entries()) {
    if (item.position === index) continue;
    written.push(await updateRoutineExercise(item, { position: index }));
  }

  return written;
}

export function routineExercises(routineExercises, routineId) {
  return routineExercises
    .filter((r) => r.routine_id === routineId && !r.deleted_at)
    .sort((a, b) => a.position - b.position);
}

export async function deleteRoutine(routine, allRoutineExercises) {
  for (const re of routineExercises(allRoutineExercises, routine.id)) {
    await local.remove('routine_exercises', re.id);
  }
  await local.remove('routines', routine.id);
  sync.nudge();
}

// ---- exercise library ------------------------------------------------------

export function libraryFor(exercises, ownerEmail) {
  return exercises
    .filter((e) => !e.deleted_at && (e.owner_email === null || e.owner_email === ownerEmail))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function searchExercises(library, term) {
  const q = term.trim().toLowerCase();
  if (!q) return library;
  return library.filter((e) =>
    e.name.toLowerCase().includes(q)
    || (e.primary_muscle ?? '').toLowerCase().includes(q)
    || (e.equipment ?? '').toLowerCase().includes(q));
}

/**
 * The muscle families the filter chips offer, over muscle-map's specific keys.
 *
 * Both levels exist because both questions get asked: "something for arms" and
 * "something for triceps" are different sizes of the same request, and folding
 * them into one list means either six chips too vague or thirteen too many.
 */
export const MUSCLE_GROUPS = {
  chest: ['chest'],
  shoulders: ['shoulders'],
  back: ['lats', 'traps', 'lowerBack'],
  arms: ['biceps', 'triceps', 'forearms'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves'],
  core: ['core'],
};

/** muscle-map's key for an exercise, from its data or failing that its name. */
export function muscleKeyOf(exercise) {
  return muscleFor(exercise, exercise?.name ?? '');
}

export function groupOf(muscleKey) {
  for (const [group, keys] of Object.entries(MUSCLE_GROUPS)) {
    if (keys.includes(muscleKey)) return group;
  }
  return null;
}

/**
 * What an exercise is done with, normalised.
 *
 * The name's trailing parenthetical wins over the equipment field, checked
 * against the data rather than assumed: "Triceps Extension (Dumbbell)" arrived
 * from the import with equipment "cable", and it was passing the cable filter
 * while saying Dumbbell on its row. The parenthetical is this library's own
 * naming convention and the thing the user actually reads; the field is
 * whatever the source database thought.
 *
 * Only the parenthetical is read from the name: scanning all of it would make
 * "Cable Crossover" cable by accident and "Barbell Row" barbell by accident —
 * right answers by a rule that also makes wrong ones, which is worse than null.
 * The field remains the fallback for rows with no parenthetical at all.
 */
export function equipmentOf(exercise) {
  const tail = /\(([^)]*)\)\s*$/.exec(exercise?.name ?? '')?.[1]?.toLowerCase() ?? '';
  if (/barbell|smith/.test(tail)) return 'barbell';
  if (/dumbbell/.test(tail)) return 'dumbbell';
  if (/rope|cable/.test(tail)) return 'cable';
  if (/machine|plates/.test(tail)) return 'machine';
  if (/band/.test(tail)) return 'bands';
  if (/weighted|bodyweight/.test(tail)) return 'bodyweight';

  const field = (exercise?.equipment ?? '').trim().toLowerCase();
  if (!field || field === 'none') return null;
  if (field === 'body only') return 'bodyweight';
  return field;
}

/**
 * Narrow a library by muscle and equipment.
 *
 * A specific muscle beats its group when both are set, because the specific chip
 * is only reachable through the group chip — asking for "arms, and of arms,
 * triceps" means triceps.
 */
export function filterExercises(library, { group = null, muscle = null, equipment = null } = {}) {
  return library.filter((e) => {
    if (equipment && equipmentOf(e) !== equipment) return false;
    if (muscle || group) {
      const key = muscleKeyOf(e);
      if (muscle) return key === muscle;
      return groupOf(key) === group;
    }
    return true;
  });
}

/**
 * The library reordered by likeness to one exercise, for the replace picker.
 *
 * What "similar" means here, in the order it matters: the same specific muscle,
 * then the same movement shape, then the same family, then the same implement.
 * Weighted so one same-muscle hit beats any pile of weaker matches — replacing
 * a triceps pushdown with another triceps exercise on a different machine is
 * the normal case; replacing it with anything else cable-driven is not.
 *
 * The exercise being replaced is excluded: it is not a replacement for itself.
 */
export function rankSimilar(library, reference) {
  const refMuscle = muscleKeyOf(reference);
  const refGroup = groupOf(refMuscle);
  const refMove = movementFor(reference, reference?.name ?? '');
  const refEquip = equipmentOf(reference);
  const refName = (reference?.name ?? '').toLowerCase();

  const score = (e) => {
    let s = 0;
    const key = muscleKeyOf(e);
    if (refMuscle && key === refMuscle) s += 6;
    else if (refGroup && groupOf(key) === refGroup) s += 3;
    if (refMove && movementFor(e, e.name) === refMove) s += 4;
    if (refEquip && equipmentOf(e) === refEquip) s += 1;
    return s;
  };

  return library
    .filter((e) => (e.name ?? '').toLowerCase() !== refName)
    .map((e) => ({ e, s: score(e) }))
    .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
    .map((x) => x.e);
}

export async function createExercise(fields, ownerEmail) {
  const exercise = await local.save('exercises', fields, ownerEmail);
  sync.nudge();
  return exercise;
}

// ---- exercise metadata -----------------------------------------------------
//
// Photographed demonstrations were tried and dropped — see muscle-map.js. This
// still pulls *metadata* from the Free Exercise DB, because primary_muscle is
// what the drawn figure keys off, and exercises imported from Hevy arrive
// without it.

const EXERCISE_DB = 'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/dist/exercises.json';

/**
 * Strips the bracketed equipment Hevy appends, so "Iso-Lateral Row (Machine)"
 * and "Iso-Lateral Row" are the same movement.
 */
const normalise = (s) => (s ?? '')
  .toLowerCase()
  .replace(/\([^)]*\)/g, '')
  .replace(/[^a-z0-9]/g, '');

/** Words that describe kit rather than the movement, and shouldn't block a match. */
const NOISE = /(machine|cable|barbell|dumbbell|smith|bodyweight|weighted|assisted|isolateral|seated|standing|lying)/g;
const loose = (s) => normalise(s).replace(NOISE, '');

export async function importExerciseMetadata(exercises, ownerEmail, onProgress = () => {}) {
  onProgress({ status: 'fetching', matched: 0, total: 0 });

  const response = await fetch(EXERCISE_DB);
  if (!response.ok) throw new Error(`Exercise database returned ${response.status}.`);
  const catalogue = await response.json();

  const byName = new Map();
  const byLoose = new Map();
  for (const entry of catalogue) {
    const key = normalise(entry.name);
    if (!byName.has(key)) byName.set(key, entry);
    const l = loose(entry.name);
    if (l.length > 4 && !byLoose.has(l)) byLoose.set(l, entry);
  }

  const targets = exercises.filter((e) => !e.deleted_at && !e.primary_muscle);
  let matched = 0;

  for (const [index, exercise] of targets.entries()) {
    const key = normalise(exercise.name);
    const l = loose(exercise.name);

    const hit = byName.get(key)
      ?? (key.length > 5 && catalogue.find((e) => normalise(e.name).startsWith(key)))
      ?? (l.length > 4 && byLoose.get(l))
      ?? null;

    if (hit) {
      await local.save('exercises', {
        ...exercise,
        primary_muscle: hit.primaryMuscles?.[0] ?? null,
        secondary_muscles: hit.secondaryMuscles ?? [],
        equipment: exercise.equipment ?? hit.equipment ?? null,
        instructions: exercise.instructions?.length ? exercise.instructions : (hit.instructions ?? []),
      }, exercise.owner_email ?? ownerEmail);
      matched++;
    }
    onProgress({ status: 'matching', matched, total: targets.length, done: index + 1 });
  }

  sync.nudge();
  onProgress({ status: 'done', matched, total: targets.length });
  return { matched, total: targets.length };
}

// ---- plate maths -----------------------------------------------------------

/** Standard US gym plates, heaviest first. */
const PLATE_SIZES = [45, 35, 25, 10, 5, 2.5];
export const DEFAULT_BAR_LB = 45;

/**
 * What to load on each side of the bar.
 *
 * Everyone does this between sets and occasionally gets it wrong. Returns null
 * when it wouldn't mean anything — a dumbbell press or a weight under the bar.
 */
export function plateMath(totalLb, barLb = DEFAULT_BAR_LB) {
  const total = Number(totalLb);
  if (!Number.isFinite(total) || total <= barLb) return null;

  let remaining = (total - barLb) / 2;
  const plates = [];

  for (const size of PLATE_SIZES) {
    while (remaining >= size - 1e-9) {
      plates.push(size);
      remaining -= size;
    }
  }
  if (!plates.length) return null;

  return { perSide: (total - barLb) / 2, plates, leftover: Math.round(remaining * 100) / 100 };
}

/** Only barbell movements — plate maths on a machine row is noise. */
export function usesBarbell(exercise, name = '') {
  const haystack = `${exercise?.equipment ?? ''} ${exercise?.name ?? ''} ${name}`.toLowerCase();
  if (/dumbbell|machine|cable|smith|bodyweight|band/.test(haystack)) return false;
  return /barbell|bench press|squat|deadlift|overhead press|row|curl|hip thrust/.test(haystack);
}

/**
 * Whether this exercise is measured in distance and time rather than load.
 *
 * `category` is the authority — set to 'cardio' on the shared exercise rows. The
 * name check is a fallback for anything imported from Hevy, which arrives with
 * no category at all; "Cycling" was already sitting in the library like that.
 */
const CARDIO_NAMES = new Set([
  'running', 'treadmill running', 'cycling', 'indoor cycling', 'outdoor cycling',
  'walking', 'swimming', 'hiking', 'elliptical', 'rowing (machine)',
  'stair machine (steps)', 'stair machine',
]);

/**
 * One set as a line of text: a distance and a time for cardio, a weight and a
 * rep count for everything else.
 *
 * A cardio set carries neither weight_lb nor reps, so the lifting format printed
 * it as "— lb × —" everywhere a last performance was shown.
 */
export function setSummary(set, exercise, name = '') {
  if (!set) return '';
  if (isCardio(exercise, name)) return cardioLine(set);
  return `${set.weight_lb ?? '—'} lb × ${set.reps ?? '—'}`;
}

export function isCardio(exercise, name = '') {
  if (exercise?.category === 'cardio') return true;

  // Whole names, not a pattern. A prefix match made "Walking Lunge" cardio,
  // and a substring match would take every Row and Curl with it.
  const candidates = [exercise?.name, name]
    .filter(Boolean)
    .map((n) => n.trim().toLowerCase());
  return candidates.some((n) => CARDIO_NAMES.has(n));
}

/** h:mm:ss once there is an hour to show, m:ss below that. */
function clock(totalSeconds) {
  const t = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * "3.23 mi · 26:00 · 8:03 /mi" — a cardio set in one line.
 *
 * Imperial by default, to match weight_lb everywhere else. The flag stays
 * because plates.members.weight_unit already exists, so a per-person metric
 * preference has somewhere to plug in without touching call sites.
 */
export function distanceLabel(metres, { metric = false } = {}) {
  const m = Number(metres) || 0;
  if (!m) return null;
  return metric ? `${(m / 1000).toFixed(2)} km` : `${(m / 1609.344).toFixed(2)} mi`;
}

export function cardioLine(set, { metric = false } = {}) {
  const parts = [];
  const seconds = Number(set?.duration_s) || 0;

  const distance = distanceLabel(set?.distance_m, { metric });
  if (distance) parts.push(distance);
  if (seconds) parts.push(clock(seconds));

  const pace = pacePer(set, { metric });
  if (pace) parts.push(pace);
  return parts.join(' · ');
}

/** Pace, which is the number anyone actually compares runs by. */
export function pacePer(set, { metric = false } = {}) {
  const metres = Number(set?.distance_m) || 0;
  const seconds = Number(set?.duration_s) || 0;
  if (!metres || !seconds) return null;

  const per = metric ? seconds / (metres / 1000) : seconds / (metres / 1609.344);
  if (!Number.isFinite(per) || per <= 0) return null;
  // Pace is always minutes per unit, so m:ss even for a slow walk.
  return `${clock(per)} /${metric ? 'km' : 'mi'}`;
}

/** Plate face colours, so the loadout reads as plates rather than as a sum. */
export const PLATE_COLOURS = {
  45: '#2D68C4',   // blue
  35: '#F2C230',   // yellow
  25: '#2FA84F',   // green
  10: '#F2EDE4',   // white
  5:  '#E0362A',   // red
  2.5: '#AEB8C6',
};

// ---- personal records ------------------------------------------------------

/**
 * The best estimated 1RM for an exercise before this session.
 *
 * Excluding the current session is the whole point: otherwise the first set you
 * complete becomes its own record and nothing ever beats it.
 */
export function bestBefore(sets, sessions, ownerEmail, exerciseId, exerciseName, currentSessionId) {
  const history = exerciseHistory(
    sets, sessions, ownerEmail, exerciseId, exerciseName, 1000,
  ).filter((entry) => entry.session.id !== currentSessionId);

  return personalBests(history).bestRm;
}

/** A completed set beats everything that came before it. */
export function isRecord(set, bestRmBefore) {
  if (!set.completed_at || set.is_warmup) return false;
  const rm = estimate1RM(set.weight_lb, set.reps);
  return Boolean(rm && (bestRmBefore == null || rm > bestRmBefore));
}

// ---- routine cards ---------------------------------------------------------

/** Muscle families, for the coverage bar. */
const FAMILY = {
  chest: 'push', shoulders: 'push', traps: 'push',
  biceps: 'pull', triceps: 'pull', forearms: 'pull', lats: 'pull', lowerBack: 'pull',
  core: 'core',
  quads: 'legs', hamstrings: 'legs', glutes: 'legs', calves: 'legs',
};

const FAMILY_COLOUR = { push: '#E0362A', pull: '#2D68C4', core: '#F2C230', legs: '#2FA84F' };
const FAMILY_LABEL  = { push: 'Push', pull: 'Pull', core: 'Core', legs: 'Legs' };

/**
 * What a routine actually works, as a share of its exercises.
 *
 * Derived rather than stored — the routine already knows its exercises and the
 * muscle map already knows what each one hits, so nothing new needs recording.
 */
export function coverage(routine, allRoutineExercises, exercises) {
  const items = routineExercises(allRoutineExercises, routine.id);
  if (!items.length) return { bars: [], label: null };

  const counts = new Map();
  for (const item of items) {
    const exercise = exercises.find((e) => e.id === item.exercise_id) ?? null;
    const key = muscleFor(exercise, item.notes ?? '');
    const family = FAMILY[key] ?? null;
    if (family) counts.set(family, (counts.get(family) ?? 0) + 1);
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) return { bars: [], label: null };

  const bars = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([family, n]) => ({
      family,
      colour: FAMILY_COLOUR[family],
      width: Math.round((n / total) * 100),
    }));

  return { bars, label: FAMILY_LABEL[bars[0].family] };
}

/** Times done, when it was last done, and what it typically costs. */
export function routineStats(routine, index) {
  // index.owned is pre-filtered and pre-sorted; volumes are precomputed.
  const mine = index.owned.filter((s) =>
    s.ended_at && (s.routine_id === routine.id || s.name === routine.name));
  if (!mine.length) return { count: 0, last: null, avgVolume: null, avgMinutes: null };

  const last = mine[0].started_at;   // owned is newest-first

  const volumes = mine.map((s) => index.volumeBySession.get(s.id) ?? 0).filter((v) => v > 0);
  const minutes = mine
    .map((s) => (new Date(s.ended_at) - new Date(s.started_at)) / 60000)
    .filter((m) => m > 0 && m < 300);   // ignore sessions left running overnight

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    count: mine.length,
    last,
    avgVolume: volumes.length ? Math.round(mean(volumes)) : null,
    avgMinutes: minutes.length ? Math.round(mean(minutes)) : null,
  };
}

/** "today", "yesterday", "last Thu", "12 days ago" — what tells you it's overdue. */
export function relativeDay(iso, now = new Date()) {
  if (!iso) return null;
  const startOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const days = Math.round((startOf(now) - startOf(iso)) / 86_400_000);

  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `last ${new Date(iso).toLocaleDateString(undefined, { weekday: 'short' })}`;
  if (days < 14) return 'last week';
  return `${days} days ago`;
}

// ---- indexing --------------------------------------------------------------

/**
 * Group the log once, instead of scanning it per lookup.
 *
 * With two years imported, `sets` is thousands of rows. Filtering it inside a
 * template getter meant a single render of the Train tab did millions of row
 * comparisons — and Alpine re-runs getters on every reactive change, so every
 * tap paid it again. This is built once per data refresh; lookups are O(1).
 */
export function buildIndex(sets, sessions, ownerEmail) {
  const bySession = new Map();
  const byExercise = new Map();

  for (const s of sets) {
    if (s.deleted_at) continue;

    let bucket = bySession.get(s.session_id);
    if (!bucket) bySession.set(s.session_id, bucket = []);
    bucket.push(s);

    const key = s.exercise_id ?? s.exercise_name;
    if (!key) continue;
    let ex = byExercise.get(key);
    if (!ex) byExercise.set(key, ex = []);
    ex.push(s);
  }

  for (const bucket of bySession.values()) bucket.sort((a, b) => a.set_index - b.set_index);

  const sessionById = new Map();
  const owned = [];
  for (const session of sessions) {
    if (session.deleted_at || session.owner_email !== ownerEmail) continue;
    sessionById.set(session.id, session);
    owned.push(session);
  }
  owned.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));

  // Volume per session, computed once — the routine cards and the weekly chart
  // both want it, and both used to recompute it from scratch.
  const volumeBySession = new Map();
  for (const [id, bucket] of bySession) volumeBySession.set(id, volume(bucket));

  // The workout in progress, resolved once here rather than re-derived on every
  // property read. `session` is reached by a dozen getters and every set row's
  // bindings, and each call used to filter and sort the whole session list —
  // hundreds of rows, tens of times per render.
  const active = owned.find((s) => !s.ended_at) ?? null;

  return { bySession, byExercise, sessionById, owned, volumeBySession, active };
}

export const setsOf = (index, sessionId) => index.bySession.get(sessionId) ?? [];

/** Sessions containing an exercise, newest first — the history screen's source. */
export function historyOf(index, exerciseId, exerciseName, limit = 40) {
  const matches = index.byExercise.get(exerciseId ?? exerciseName) ?? [];

  const grouped = new Map();
  for (const set of matches) {
    if (!index.sessionById.has(set.session_id)) continue;
    let bucket = grouped.get(set.session_id);
    if (!bucket) grouped.set(set.session_id, bucket = []);
    bucket.push(set);
  }

  return [...grouped.entries()]
    .map(([sessionId, entrySets]) => {
      const ordered = entrySets.slice().sort((a, b) => a.set_index - b.set_index);
      const working = ordered.filter((s) => !s.is_warmup);
      const best = working.reduce((b, s) => (!b || (s.weight_lb ?? 0) > (b.weight_lb ?? 0) ? s : b), null);

      return {
        session: index.sessionById.get(sessionId),
        date: index.sessionById.get(sessionId).started_at,
        sets: ordered,
        best,
        volume: volume(ordered),
        oneRm: best ? estimate1RM(best.weight_lb, best.reps) : null,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limit);
}

/** Best previous set and best prior 1RM per exercise, precomputed for the session screen. */
export function priorForm(index, excludeSessionId) {
  const out = new Map();

  for (const [key, sets] of index.byExercise) {
    let best = null;
    let bestRm = null;
    let latest = null;

    let latestSession = null;

    for (const set of sets) {
      if (set.session_id === excludeSessionId) continue;
      const session = index.sessionById.get(set.session_id);
      if (!session || set.is_warmup || !set.completed_at) continue;

      const rm = estimate1RM(set.weight_lb, set.reps);
      if (rm && (bestRm == null || rm > bestRm)) bestRm = rm;

      if (!latest || session.started_at > latest) {
        latest = session.started_at;
        best = set;
        latestSession = session.id;
      } else if (latest === session.started_at && (set.weight_lb ?? 0) > (best?.weight_lb ?? 0)) {
        best = set;
      }
    }

    // That session's working sets, in order. The set rows show these in the
    // PREVIOUS column and use them as placeholders, so a set you are repeating
    // can be checked off without typing anything.
    const previous = latestSession
      ? sets
        .filter((s) => s.session_id === latestSession && !s.is_warmup && s.completed_at)
        .sort((a, b) => a.set_index - b.set_index)
      : [];

    out.set(key, { best, bestRm, previous });
  }
  return out;
}
