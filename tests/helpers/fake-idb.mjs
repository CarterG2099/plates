/**
 * An in-memory IndexedDB, just wide enough for local.js.
 *
 * The point of this file is that local.js runs *unmodified* under test — the
 * outbox, the tombstones, the client-generated ids and the id-preserving upsert
 * are the local-first guarantees the whole app rests on, and stubbing the module
 * out would test none of them.
 *
 * Only the surface local.js actually touches is implemented. It is a closed set:
 * open/onupgradeneeded, createObjectStore, createIndex, objectStoreNames,
 * transaction, objectStore, getAll, get, put, add, delete, count, clear. Anything
 * outside that throws loudly rather than quietly returning undefined, so a new
 * call in local.js fails the suite instead of silently passing.
 */

class FakeRequest {
  constructor(result) {
    this.result = result;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
  }
}

class FakeStore {
  constructor(name, { keyPath, autoIncrement = false }) {
    this.name = name;
    this.keyPath = keyPath;
    this.autoIncrement = autoIncrement;
    this.rows = new Map();
    this.indexes = new Set();
    this.seq = 0;
  }

  createIndex(name) { this.indexes.add(name); }
}

/** The handle a transaction hands out. Writes land immediately; see `run`. */
class StoreHandle {
  constructor(store, mode, tx) {
    this.store = store;
    this.mode = mode;
    this.tx = tx;
  }

  #write() {
    if (this.mode !== 'readwrite') {
      throw new Error(`write attempted in a ${this.mode} transaction on ${this.store.name}`);
    }
  }

  // Structured-clone semantics: what goes in is a copy, so a caller mutating
  // its object afterwards cannot reach back into the store. Real IndexedDB
  // behaves this way and code that accidentally relies on shared references
  // would otherwise pass here and fail in a browser.
  put(row) {
    this.#write();
    const copy = structuredClone(row);
    this.store.rows.set(copy[this.store.keyPath], copy);
    return new FakeRequest(copy[this.store.keyPath]);
  }

  add(row) {
    this.#write();
    const copy = structuredClone(row);
    if (this.store.autoIncrement && copy[this.store.keyPath] == null) {
      copy[this.store.keyPath] = ++this.store.seq;
    }
    if (this.store.rows.has(copy[this.store.keyPath])) {
      throw new Error(`add() on an existing key in ${this.store.name}`);
    }
    this.store.rows.set(copy[this.store.keyPath], copy);
    return new FakeRequest(copy[this.store.keyPath]);
  }

  get(key) { return new FakeRequest(structuredClone(this.store.rows.get(key))); }

  getAll() { return new FakeRequest([...this.store.rows.values()].map((r) => structuredClone(r))); }

  count() { return new FakeRequest(this.store.rows.size); }

  delete(key) {
    this.#write();
    this.store.rows.delete(key);
    return new FakeRequest(undefined);
  }

  clear() {
    this.#write();
    this.store.rows.clear();
    return new FakeRequest(undefined);
  }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;

    for (const name of names) {
      if (!db.stores.has(name)) throw new Error(`no such object store: ${name}`);
    }
    this.names = names;

    // local.js assigns tx.oncomplete *after* running its work, so completion has
    // to be deferred past the current synchronous block or the handler is never
    // called. A microtask is the tightest thing that still gets there.
    queueMicrotask(() => {
      if (this.error) this.onerror?.();
      else this.oncomplete?.();
    });
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`${name} is not in this transaction`);
    return new StoreHandle(this.db.stores.get(name), this.mode, this);
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
  }

  get objectStoreNames() {
    const names = [...this.stores.keys()];
    return { contains: (n) => names.includes(n), length: names.length };
  }

  createObjectStore(name, options = {}) {
    const store = new FakeStore(name, options);
    this.stores.set(name, store);
    return store;
  }

  transaction(nameOrNames, mode = 'readonly') {
    const names = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
    return new FakeTransaction(this, names, mode);
  }
}

/** Databases survive across `open()` calls within a process, as a real one would. */
const databases = new Map();

export function install() {
  globalThis.IDBRequest = FakeRequest;
  globalThis.indexedDB = {
    open(name, version) {
      const request = new FakeRequest(null);
      const existing = databases.get(name);
      const db = existing ?? new FakeDatabase(name, version);
      const isUpgrade = !existing || version > existing.version;
      db.version = version;
      databases.set(name, db);
      request.result = db;

      // Deferred for the same reason as transaction completion: the caller has
      // not attached its handlers yet.
      queueMicrotask(() => {
        if (isUpgrade) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

/** Forget every database, so a suite can start from nothing. */
export function reset() {
  databases.clear();
}
