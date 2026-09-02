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
// Bump whenever TABLES changes: onupgradeneeded is the only place object stores
// get created, and it only runs on a version increase.
const DB_VERSION = 4;

/**
 * Synced tables.
 *
 * `members` is deliberately absent: it is keyed by email rather than id and has
 * no `updated_at`, so it fits neither the keyPath nor the sync cursor. It is two
 * rows and auth.js already loads it live.
 */
export const TABLES = [
  'goals',
  'day_templates',
  'foods',
  'food_log',
  'weight_log',
  'meal_combos',
  'exercises',
  'routines',
  'routine_exercises',
  'sessions',
  'session_sets',
  'progress_photos',
];

/** Pending local writes, drained by sync.push(). */
const OUTBOX = '_outbox';
/** Sync cursors and other small key/value state. */
const META = '_meta';
/** Cached image blobs (progress photos), keyed by their storage object path. */
const BLOBS = '_blobs';

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
      if (!idb.objectStoreNames.contains(BLOBS)) {
        idb.createObjectStore(BLOBS, { keyPath: 'path' });
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
 * Strip anything IndexedDB can't structured-clone.
 *
 * Rows read through Alpine come back wrapped in reactive Proxies, and a Proxy
 * cannot be cloned — so `save({...row, changed})` throws "could not be cloned"
 * even though the object looks ordinary. Everything stored here is JSON by
 * construction, so a round-trip is both the cheapest unwrap and the honest
 * description of what a row is.
 */
function plain(row) {
  return JSON.parse(JSON.stringify(row));
}

/**
 * One row's read-modify-writes, in order.
 *
 * Reading a row, merging a change into it and writing it back is only safe if no
 * other write to that row happens in between. Two handlers doing it at once is a
 * lost update, and the browser hands us exactly that: typing in a set's reps
 * fires `change`, tapping the checkmark fires `click`, and the two listeners do
 * not await each other. The click's read landed before the change's write, so it
 * merged the checkmark into the *old* reps and put the prefilled default back.
 *
 * Keyed per row, so unrelated rows still write in parallel.
 */
const chains = new Map();

export function serialise(key, task) {
  const previous = chains.get(key) ?? Promise.resolve();

  // `then(task, task)` so a failed write still lets the next one run.
  const done = previous.then(task, task);

  // What later callers queue behind is a promise that never rejects: one failed
  // write must not poison every subsequent write to the same row.
  const settled = done.then(() => {}, () => {});
  chains.set(key, settled);
  settled.then(() => {
    // Only if nothing else queued behind it in the meantime.
    if (chains.get(key) === settled) chains.delete(key);
  });

  return done;
}

/**
 * Create or update a row: write locally, queue for sync, return immediately.
 *
 * The id is generated here rather than by the server so a row created offline
 * carries its permanent identity from the moment it exists — there is no
 * temporary id to reconcile later.
 */
export async function save(table, fields, ownerEmail) {
  const row = plain({
    id: fields.id ?? crypto.randomUUID(),
    owner_email: fields.owner_email ?? ownerEmail,
    ...fields,
    updated_at: new Date().toISOString(),
  });

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

  const row = plain({
    ...existing,
    deleted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await putLocal(table, row);
  await enqueue(table, row);
  return row;
}

// ---- blob cache --------------------------------------------------------------
//
// Progress photos, downloaded once and kept. Local-only: nothing here syncs —
// the bucket is the source of truth and this is just so browsing doesn't
// redownload and works offline.

export async function getBlob(path) {
  const row = await run(BLOBS, 'readonly', (s) => s.get(path));
  return row?.blob ?? null;
}

export function putBlob(path, blob) {
  return run(BLOBS, 'readwrite', (s) => s.put({ path, blob }));
}

export function deleteBlob(path) {
  return run(BLOBS, 'readwrite', (s) => s.delete(path));
}

/** Drop everything. Used on sign-out so a shared device leaks nothing. */
export async function wipe() {
  const idb = await open();
  const stores = [...TABLES, OUTBOX, META, BLOBS];
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(stores, 'readwrite');
    for (const name of stores) tx.objectStore(name).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
