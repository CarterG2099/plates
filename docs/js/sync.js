/**
 * sync.js — reconciles IndexedDB with Supabase in the background.
 *
 * Never called from the UI's critical path. Writes land locally and this drains
 * them whenever the network happens to be available.
 *
 * Conflict resolution is last-write-wins on `updated_at`. Every row has exactly
 * one owner and is almost always edited on one device, so anything more
 * elaborate would be wasted effort.
 */

import { db, supabase } from './supabase.js';
import * as local from './local.js';

/** Pulled in this order so the screens you open first fill first. */
const PULL_ORDER = [
  'goals',
  'foods',
  'food_log',
  'weight_log',
  'meal_combos',
  'exercises',
  'routines',
  'routine_exercises',
  'sessions',
  'session_sets',
];

const PAGE_SIZE = 1000;
const POLL_MS = 60_000;

const listeners = new Set();
let running = false;
let timer = null;

export const state = {
  online: navigator.onLine,
  status: 'idle',        // idle | syncing | offline | error
  pending: 0,
  lastSyncedAt: null,
  error: null,
};

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function emit(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

async function refreshPending() {
  emit({ pending: await local.pendingCount() });
}

// ---- push ------------------------------------------------------------------

/**
 * Drain the outbox. Entries are grouped per table and upserted in one call each,
 * which matters when a whole workout's sets sync at once after leaving the gym.
 */
async function push() {
  const queued = await local.outbox();
  if (!queued.length) return;

  const byTable = new Map();
  for (const entry of queued) {
    if (!byTable.has(entry.table)) byTable.set(entry.table, []);
    byTable.get(entry.table).push(entry);
  }

  for (const [table, entries] of byTable) {
    // Later writes to the same row supersede earlier ones; send one row each.
    const latest = new Map();
    for (const entry of entries) latest.set(entry.row.id, entry.row);

    const { error } = await db(table).upsert([...latest.values()], { onConflict: 'id' });

    if (error) {
      // Leave the entries queued and try again on the next pass. A failure here
      // is usually just absent signal.
      throw error;
    }
    await local.dequeue(entries.map((e) => e.seq));
  }
}

// ---- pull ------------------------------------------------------------------

/**
 * Fetch everything changed since the last cursor for a table.
 *
 * The cursor is inclusive (`gte`) so a row written in the same millisecond as
 * the boundary cannot be skipped; re-applying a row we already have is harmless
 * because the local write is an idempotent put.
 */
async function pullTable(table) {
  const cursorKey = `cursor:${table}`;
  const cursor = await local.getMeta(cursorKey, '1970-01-01T00:00:00.000Z');

  let newest = cursor;
  let from = 0;

  // One read of local timestamps up front, rather than a transaction per row.
  // The first pull of the ~800-exercise library would otherwise crawl.
  const localStamps = new Map(
    (await local.allRaw(table)).map((r) => [r.id, r.updated_at]),
  );

  for (;;) {
    let query = db(table)
      .select('*')
      .gte('updated_at', cursor)
      .order('updated_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) throw error;
    if (!data.length) break;

    // Last-write-wins: a pulled row loses to a newer unsynced local edit.
    const winners = [];
    for (const remote of data) {
      const localStamp = localStamps.get(remote.id);
      if (localStamp && localStamp > remote.updated_at) continue;
      winners.push(remote);
      localStamps.set(remote.id, remote.updated_at);
      if (remote.updated_at > newest) newest = remote.updated_at;
    }
    await local.putManyLocal(table, winners);

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (newest !== cursor) await local.setMeta(cursorKey, newest);
}

// ---- the loop --------------------------------------------------------------

/** Push then pull. Safe to call often; overlapping calls collapse into one. */
export async function sync() {
  if (running) return;
  if (!navigator.onLine) {
    emit({ online: false, status: 'offline' });
    await refreshPending();
    return;
  }

  running = true;
  emit({ online: true, status: 'syncing', error: null });

  try {
    await push();
    for (const table of PULL_ORDER) await pullTable(table);

    emit({ status: 'idle', lastSyncedAt: new Date().toISOString(), error: null });
  } catch (error) {
    // Queued writes are still on disk, so this is a retry-later, not data loss.
    emit({ status: 'error', error: error.message ?? String(error) });
  } finally {
    running = false;
    await refreshPending();
  }
}

/** Called after a local write: try to sync, but never make the UI wait. */
export function nudge() {
  refreshPending();
  sync();
}

export function start() {
  window.addEventListener('online',  () => { emit({ online: true }); sync(); });
  window.addEventListener('offline', () => emit({ online: false, status: 'offline' }));

  // Coming back to the app is the most likely moment for the network to have
  // returned — more reliable than any interval.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });

  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') sync();
  }, POLL_MS);

  sync();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Forget cursors so the next sync refetches everything. Used after sign-in. */
export async function resetCursors() {
  for (const table of PULL_ORDER) await local.setMeta(`cursor:${table}`, '1970-01-01T00:00:00.000Z');
}

// Keep the session fresh; a stale JWT would fail every push.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') sync();
});
