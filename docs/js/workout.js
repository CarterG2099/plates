/**
 * workout.js — training domain logic.
 *
 * Same rules as food.js: works off arrays already in IndexedDB, never touches
 * the network. A gym is the worst signal environment either of us will be in,
 * so a set must land the instant the check is tapped.
 */

import * as local from './local.js';
import * as sync from './sync.js';

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

export async function finishSession(session) {
  const saved = await local.save('sessions', {
    ...session,
    ended_at: new Date().toISOString(),
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

export async function updateSet(set, fields) {
  const saved = await local.save('session_sets', { ...set, ...fields }, set.owner_email);
  sync.nudge();
  return saved;
}

export async function removeSet(id) {
  const row = await local.remove('session_sets', id);
  sync.nudge();
  return row;
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

// ---- numbers ---------------------------------------------------------------

/** Total load moved. Warm-ups excluded — they aren't working volume. */
export function volume(sets) {
  return sets
    .filter((s) => !s.deleted_at && !s.is_warmup && s.completed_at)
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

export function routinesFor(routines, ownerEmail) {
  return routines
    .filter((r) => r.owner_email === ownerEmail && !r.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Save a finished session's shape as a reusable routine — cheaper than a
 * separate builder, and the workout you just did is the best description of
 * what you meant to do.
 */
export async function saveSessionAsRoutine({ name, session, sets, ownerEmail }) {
  const routine = await local.save('routines', { name, notes: null }, ownerEmail);

  const groups = groupByExercise(setsForSession(sets, session.id));
  let position = 0;

  for (const group of groups) {
    const working = group.sets.filter((s) => !s.is_warmup);
    const heaviest = working.reduce((b, s) => (!b || (s.weight_lb ?? 0) > (b.weight_lb ?? 0) ? s : b), null);

    await local.save('routine_exercises', {
      routine_id: routine.id,
      exercise_id: group.exerciseId ?? null,
      position: position++,
      target_sets: working.length || group.sets.length,
      target_reps: heaviest?.reps ? String(heaviest.reps) : null,
      target_weight_lb: heaviest?.weight_lb ?? null,
      rest_seconds: DEFAULT_REST_SECONDS,
      notes: group.name,      // keeps the name if the exercise row disappears
    }, ownerEmail);
  }

  sync.nudge();
  return routine;
}

/** Create or rename a routine. Used by the builder; saving from a session uses
 *  saveSessionAsRoutine above. */
export async function upsertRoutine({ id, name, notes }, ownerEmail) {
  const routine = await local.save('routines', {
    ...(id ? { id } : {}),
    name,
    notes: notes ?? null,
  }, ownerEmail);
  sync.nudge();
  return routine;
}

export async function addRoutineExercise({ routineId, exercise, position, ownerEmail }) {
  const item = await local.save('routine_exercises', {
    routine_id: routineId,
    exercise_id: exercise.id ?? null,
    position,
    target_sets: 3,
    target_reps: '8',
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

export async function createExercise(fields, ownerEmail) {
  const exercise = await local.save('exercises', fields, ownerEmail);
  sync.nudge();
  return exercise;
}

// ---- demonstration images --------------------------------------------------
//
// From the Free Exercise DB (yuhonas/free-exercise-db, public domain), served
// via jsdelivr. Only the URLs are stored; the images themselves are fetched
// lazily by the browser when a card scrolls into view, so this costs nothing
// until something is actually looked at.

const EXERCISE_DB = 'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/dist/exercises.json';
const IMAGE_BASE = 'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/';

const normalise = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Match the library against the Free Exercise DB by name and store image URLs.
 *
 * Runs once, in the background, and the result syncs to both of us — so nobody
 * has to run it twice. Matching is deliberately conservative: an exact
 * normalised name, or theirs starting with ours ("Barbell Bench Press" matching
 * "Barbell Bench Press - Medium Grip"). A wrong demonstration image is worse
 * than none.
 */
export async function importExerciseImages(exercises, ownerEmail, onProgress = () => {}) {
  onProgress({ status: 'fetching', matched: 0, total: 0 });

  const response = await fetch(EXERCISE_DB);
  if (!response.ok) throw new Error(`Exercise database returned ${response.status}.`);
  const catalogue = await response.json();

  const byName = new Map();
  for (const entry of catalogue) {
    const key = normalise(entry.name);
    if (!byName.has(key)) byName.set(key, entry);
  }

  const targets = exercises.filter((e) => !e.deleted_at && !(e.image_urls ?? []).length);
  let matched = 0;

  for (const [index, exercise] of targets.entries()) {
    const key = normalise(exercise.name);
    const hit = byName.get(key)
      ?? catalogue.find((e) => normalise(e.name).startsWith(key) && key.length > 6);

    if (hit?.images?.length) {
      await local.save('exercises', {
        ...exercise,
        image_urls: hit.images.map((path) => IMAGE_BASE + path),
        external_id: hit.id ?? null,
        primary_muscle: exercise.primary_muscle ?? hit.primaryMuscles?.[0] ?? null,
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

export function imageFor(exercise) {
  return (exercise?.image_urls ?? [])[0] ?? null;
}
