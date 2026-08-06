/**
 * import-hevy.js — one-time import of a Hevy CSV export.
 *
 * Runs entirely in the browser and writes through the ordinary local-first path,
 * so an import is just a very large batch of normal writes: straight into
 * IndexedDB, drained to Supabase by sync.js afterwards.
 *
 * Two years of history is worth more than the routines alone — it's what makes
 * "Last: 205 lb × 8" correct on the very first workout instead of after a month
 * of using the app.
 */

import * as local from './local.js';
import * as sync from './sync.js';
import { DEFAULT_REST_SECONDS } from './workout.js';

/** Titles seen this many times are a real routine rather than a one-off. */
const ROUTINE_THRESHOLD = 5;

// ---- CSV -------------------------------------------------------------------

/**
 * Minimal RFC-4180 parser. Hevy quotes fields and exercise names contain commas
 * and parentheses, so splitting on commas would quietly corrupt the data.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Hevy stamps times like "6 Aug 2026, 07:04", in local time. */
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
                 Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export function parseHevyDate(value) {
  const m = /^(\d{1,2}) (\w{3}) (\d{4}), (\d{2}):(\d{2})$/.exec((value ?? '').trim());
  if (!m) return null;
  const [, d, mon, y, hh, mm] = m;
  if (!(mon in MONTHS)) return null;
  return new Date(Number(y), MONTHS[mon], Number(d), Number(hh), Number(mm));
}

const normalise = (s) => (s ?? '')
  .toLowerCase()
  .replace(/\([^)]*\)/g, '')    // "Lat Pulldown (Cable)" and "Lat Pulldown" are one exercise
  .replace(/[^a-z0-9]/g, '');

const num = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) ? null : n;
};

// ---- import ----------------------------------------------------------------

/**
 * @param {string} text  raw CSV
 * @param {object} ctx   { ownerEmail, existingExercises }
 * @param {function} onProgress
 */
export async function importHevy(text, { ownerEmail, existingExercises }, onProgress = () => {}) {
  onProgress({ phase: 'parsing' });
  const rows = parseCsv(text).filter((r) => r.exercise_title && r.start_time);
  if (!rows.length) throw new Error('No workout rows found — is this a Hevy CSV export?');

  // ---- exercises -----------------------------------------------------------
  // Reuse anything already in the library so the import doesn't create a second
  // "Lat Pulldown" alongside the seeded one.
  const byKey = new Map();
  for (const e of existingExercises) {
    if (!e.deleted_at) byKey.set(normalise(e.name), e);
  }

  const names = [...new Set(rows.map((r) => r.exercise_title))];
  let created = 0;

  for (const name of names) {
    const key = normalise(name);
    if (byKey.has(key)) continue;

    // owner_email null: exercise definitions are shared, so both of us benefit
    // and the image import covers them too.
    const exercise = await local.save('exercises', { name, owner_email: null }, null);
    byKey.set(key, exercise);
    created++;
  }
  onProgress({ phase: 'exercises', created, total: names.length });

  // ---- sessions and sets ---------------------------------------------------
  const bySession = new Map();
  for (const row of rows) {
    const key = `${row.title}@@${row.start_time}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(row);
  }

  const sessions = [...bySession.entries()]
    .map(([key, setRows]) => ({ key, setRows, started: parseHevyDate(setRows[0].start_time) }))
    .filter((s) => s.started)
    .sort((a, b) => a.started - b.started);

  let sessionCount = 0;
  let setCount = 0;
  const latestByTitle = new Map();

  for (const { setRows, started } of sessions) {
    const title = setRows[0].title;
    const ended = parseHevyDate(setRows[0].end_time) ?? started;

    const session = await local.save('sessions', {
      name: title,
      routine_id: null,
      started_at: started.toISOString(),
      ended_at: ended.toISOString(),
      notes: setRows[0].description || null,
    }, ownerEmail);

    for (const [index, row] of setRows.entries()) {
      const exercise = byKey.get(normalise(row.exercise_title));

      await local.save('session_sets', {
        session_id: session.id,
        exercise_id: exercise?.id ?? null,
        exercise_name: row.exercise_title,
        set_index: index,
        weight_lb: num(row.weight_lbs),
        reps: num(row.reps),
        rpe: num(row.rpe),
        is_warmup: row.set_type === 'warmup',
        // These sets were performed. Without this they'd never count toward
        // volume or show up as "last time".
        completed_at: started.toISOString(),
      }, ownerEmail);
      setCount++;
    }

    sessionCount++;
    latestByTitle.set(title, { setRows, sessionId: session.id });
    onProgress({ phase: 'sessions', done: sessionCount, total: sessions.length, sets: setCount });
  }

  // ---- routines ------------------------------------------------------------
  // Built from the most recent instance of each frequently repeated title —
  // the last time you did it is the best description of what it is now.
  const counts = new Map();
  for (const { setRows } of sessions) {
    const t = setRows[0].title;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  let routineCount = 0;
  for (const [title, count] of counts) {
    if (count < ROUTINE_THRESHOLD) continue;

    const { setRows } = latestByTitle.get(title);
    const routine = await local.save('routines', { name: title, notes: null }, ownerEmail);

    // Exercises in the order performed, with the heaviest working set as target.
    const order = [];
    const stats = new Map();
    for (const row of setRows) {
      const key = normalise(row.exercise_title);
      if (!stats.has(key)) {
        stats.set(key, { name: row.exercise_title, sets: 0, best: null });
        order.push(key);
      }
      const s = stats.get(key);
      s.sets++;
      const w = num(row.weight_lbs);
      if (w != null && (s.best == null || w > s.best.weight)) s.best = { weight: w, reps: num(row.reps) };
    }

    for (const [position, key] of order.entries()) {
      const s = stats.get(key);
      await local.save('routine_exercises', {
        routine_id: routine.id,
        exercise_id: byKey.get(key)?.id ?? null,
        position,
        target_sets: s.sets,
        target_reps: s.best?.reps != null ? String(s.best.reps) : null,
        target_weight_lb: s.best?.weight ?? null,
        rest_seconds: DEFAULT_REST_SECONDS,
        notes: s.name,
      }, ownerEmail);
    }
    routineCount++;
  }

  sync.nudge();

  const summary = {
    phase: 'done',
    exercises: created,
    sessions: sessionCount,
    sets: setCount,
    routines: routineCount,
  };
  onProgress(summary);
  return summary;
}
