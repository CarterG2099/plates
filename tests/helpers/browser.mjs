/**
 * Enough browser to import docs/js modules under `node --test`.
 *
 * The app's modules are written for the page, so importing one pulls in
 * supabase.js (which calls `window.supabase.createClient` at module scope) and
 * sync.js (which registers listeners). None of that is under test here; it just
 * has to not throw on import.
 *
 * Deliberately no npm packages — the repo has no build step and no node_modules,
 * and a test suite is not a good reason to acquire either.
 *
 * An in-memory IndexedDB comes with it, so local.js runs unmodified and the
 * writes go through the real thing. The outbox, the tombstones and the
 * client-generated ids are the local-first guarantees the app rests on; stubbing
 * the module out would test none of them.
 */

import { install as installIdb } from './fake-idb.mjs';

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

let installed = false;

/** Idempotent: every test file calls this, only the first does anything. */
export function installBrowser() {
  if (installed) return;
  installed = true;

  installIdb();

  define('addEventListener', () => {});
  define('removeEventListener', () => {});

  // Online, because lookup.js checks this before it will fetch anything. A test
  // that asserts on the outbox should set it false first: every local write
  // nudges sync, and against the stub client that push "succeeds" and dequeues.
  define('navigator', {
    onLine: true,
    serviceWorker: { addEventListener() {}, getRegistrations: async () => [] },
    vibrate: () => {},
  });

  define('localStorage', {
    _v: new Map(),
    getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
    setItem(k, v) { this._v.set(k, String(v)); },
    removeItem(k) { this._v.delete(k); },
  });

  define('window', {
    isSecureContext: true,
    addEventListener() {},
    removeEventListener() {},
    supabase: {
      createClient: () => ({
        auth: {
          onAuthStateChange() {},
          getSession: async () => ({ data: { session: null } }),
        },
        from: () => stubQuery(),
        schema: () => ({ from: () => stubQuery(), rpc: async () => ({ data: null }) }),
        functions: { invoke: async () => ({ data: null, error: null }) },
        channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      }),
    },
  });

  define('document', {
    visibilityState: 'visible',
    addEventListener() {},
    head: { appendChild() {} },
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => 'data:image/jpeg;base64,AAAA',
    }),
    querySelectorAll: () => [],
  });
}

/** A PostgREST builder that resolves to nothing, whatever you chain onto it. */
function stubQuery() {
  const q = {
    select() { return q; },
    gte() { return q; },
    order() { return q; },
    range() { return q; },
    upsert() { return q; },
    eq() { return q; },
    then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
  };
  return q;
}

/** Fixed clock, so "3 weeks ago" means the same thing on every run. */
export const NOW = new Date('2026-08-10T12:00:00.000Z');

export function daysAgo(n, from = NOW) {
  return new Date(from.getTime() - n * 86_400_000).toISOString();
}

/**
 * Freeze Date.now() for the duration of a callback.
 *
 * rankFoods and the frecency decay read the wall clock directly, so without
 * this their assertions drift by a few thousandths between runs and eventually
 * flake.
 */
export async function atTime(instant, fn) {
  const realNow = Date.now;
  Date.now = () => instant.getTime();
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}
