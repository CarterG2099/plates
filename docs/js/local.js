/**
 * local.js — IndexedDB, the app's actual source of truth.
 *
 * Reads never touch the network and writes never await it. The UI talks only to
 * this module; sync.js reconciles with Supabase in the background. That is what
 * makes logging feel instant on bad gym signal.
 *
 * No wrapper library: a build step is off the table and the surface we need is
 * small.
 */

const DB_NAME = 'plates';
const DB_VERSION = 1;

/**
 * Synced tables.
 *
 * `members` is deliberately absent: it is keyed by email rather than id and has
 * no `updated_at`, so it fits neither the keyPath nor the sync cursor. It is two
 * rows and auth.js already loads it live.
 */
export const TABLES = [
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

/** Pending local writes, drained by sync.push(). */
const OUTBOX = '_outbox';
/** Sync cursors and other small key/value state. */
const META = '_meta';

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const idb = req.result;

      for (const table of TABLES) {
        if (idb.objectStoreNames.contains(table)) continue;
        const store = idb.createObjectStore(table, { keyPath: 'id' });
        store.createIndex('updated_at', 'updated_at');
        store.createIndex('owner_email', 'owner_email');
      }

      if (!idb.objectStoreNames.contains(OUTBOX)) {
        idb.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true });
      }
      if (!idb.objectStoreNames.contains(META)) {
        idb.createObjectStore(META, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((idb) => new Promise((resolve, reject) => {
    const tx = idb.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

// ---- reads -----------------------------------------------------------------

/** Live rows only — tombstones are kept locally so deletes can propagate. */
export async function all(table) {
  const rows = await run(table, 'readonly', (s) => s.getAll());
  return rows.filter((r) => !r.deleted_at);
}

export function get(table, id) {
  return run(table, 'readonly', (s) => s.get(id));
}

/** Everything including tombstones. Sync needs these; the UI does not. */
export function allRaw(table) {
  return run(table, 'readonly', (s) => s.getAll());
}

// ---- writes ----------------------------------------------------------------

/** Write locally without queueing — used when applying rows pulled from the server. */
export function putLocal(table, row) {
  return run(table, 'readwrite', (s) => s.put(row));
}

export async function putManyLocal(table, rows) {
  if (!rows.length) return;
  await run(table, 'readwrite', (s) => { for (const row of rows) s.put(row); });
}

// ---- outbox ----------------------------------------------------------------

export function enqueue(table, row) {
  return run(OUTBOX, 'readwrite', (s) => s.add({
    table,
    row,
    queued_at: new Date().toISOString(),
  }));
}

export function outbox() {
  return run(OUTBOX, 'readonly', (s) => s.getAll());
}

export async function dequeue(seqs) {
  if (!seqs.length) return;
  await run(OUTBOX, 'readwrite', (s) => { for (const seq of seqs) s.delete(seq); });
}

export async function pendingCount() {
  return run(OUTBOX, 'readonly', (s) => s.count());
}

// ---- meta ------------------------------------------------------------------

export async function getMeta(key, fallback = null) {
  const row = await run(META, 'readonly', (s) => s.get(key));
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  return run(META, 'readwrite', (s) => s.put({ key, value }));
}

// ---- the write path the UI uses --------------------------------------------

/**
 * Create or update a row: write locally, queue for sync, return immediately.
 *
 * The id is generated here rather than by the server so a row created offline
 * carries its permanent identity from the moment it exists — there is no
 * temporary id to reconcile later.
 */
export async function save(table, fields, ownerEmail) {
  const row = {
    id: fields.id ?? crypto.randomUUID(),
    owner_email: fields.owner_email ?? ownerEmail,
    ...fields,
    updated_at: new Date().toISOString(),
  };

  await putLocal(table, row);
  await enqueue(table, row);
  return row;
}

/**
 * Soft delete. A hard delete cannot propagate to a device that was offline when
 * it happened, so rows are tombstoned and filtered out on read.
 */
export async function remove(table, id) {
  const existing = await get(table, id);
  if (!existing) return null;

  const row = { ...existing, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await putLocal(table, row);
  await enqueue(table, row);
  return row;
}

/** Drop everything. Used on sign-out so a shared device leaks nothing. */
export async function wipe() {
  const idb = await open();
  const stores = [...TABLES, OUTBOX, META];
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(stores, 'readwrite');
    for (const name of stores) tx.objectStore(name).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
