import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const sync = await import('../docs/js/sync.js');
const local = await import('../docs/js/local.js');

const ME = 'me@example.com';

/**
 * Replace the module's Supabase client for one call.
 *
 * sync.js talks to the network through `db(table)`, which comes from
 * supabase.js. There is no seam to inject through, so the tests here cover the
 * parts that are reachable without one — the outbox, the defaults applied at the
 * push boundary, and the observable state machine.
 */

test('a status subscriber is called immediately with the current state', () => {
  let seen = null;
  const off = sync.subscribe((s) => { seen = s; });
  assert.ok(seen, 'subscribe should push the current state, not wait for a change');
  assert.equal(typeof seen.status, 'string');
  assert.equal(typeof seen.online, 'boolean');
  off?.();
});

test('sync reports offline rather than throwing when there is no network', async () => {
  const states = [];
  const off = sync.subscribe((s) => states.push({ ...s }));

  navigator.onLine = false;
  await sync.sync();

  assert.equal(states.at(-1).online, false);
  assert.equal(states.at(-1).status, 'offline');
  off?.();
});

test('a queued write survives being offline', async () => {
  navigator.onLine = false;

  const row = await local.save('foods', {
    name: 'Queued Food', brand: null, serving_qty: 1, serving_unit: 'serving',
    calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1, fiber_g: null, sodium_mg: null,
    source: 'manual',
  }, ME);

  const outbox = await local.outbox();
  assert.ok(outbox.some((e) => e.row?.id === row.id), 'the write should be waiting in the outbox');

  // And it is readable locally straight away — the whole point of local-first.
  const stored = await local.get('foods', row.id);
  assert.equal(stored.name, 'Queued Food');
});

test('a soft delete tombstones rather than removing the row', async () => {
  const row = await local.save('foods', {
    name: 'To Delete', serving_qty: 1, serving_unit: 'serving', calories: 1, source: 'manual',
  }, ME);

  await local.remove('foods', row.id);

  const stored = await local.get('foods', row.id);
  assert.ok(stored, 'the row must still exist');
  assert.ok(stored.deleted_at, 'and carry a deleted_at');

  // all() hides it; allRaw() still sees it, because sync needs the tombstone.
  const visible = await local.all('foods');
  const raw = await local.allRaw('foods');
  assert.equal(visible.some((f) => f.id === row.id), false);
  assert.equal(raw.some((f) => f.id === row.id), true);
});

test('removing something that does not exist is a no-op, not a throw', async () => {
  assert.equal(await local.remove('foods', 'no-such-id'), null);
});

test('ids are generated on the client, never left to the server', async () => {
  const row = await local.save('foods', {
    name: 'Client Id', serving_qty: 1, serving_unit: 'serving', calories: 1, source: 'manual',
  }, ME);
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('saving with an existing id updates in place instead of duplicating', async () => {
  const first = await local.save('foods', {
    name: 'Original', serving_qty: 1, serving_unit: 'serving', calories: 1, source: 'manual',
  }, ME);

  await local.save('foods', { id: first.id, name: 'Renamed', serving_qty: 1, serving_unit: 'serving', calories: 1, source: 'manual' }, ME);

  const all = await local.allRaw('foods');
  assert.equal(all.filter((f) => f.id === first.id).length, 1);
  assert.equal((await local.get('foods', first.id)).name, 'Renamed');
});

test('every write stamps updated_at, which is what last-write-wins compares', async () => {
  const row = await local.save('foods', {
    name: 'Stamped', serving_qty: 1, serving_unit: 'serving', calories: 1, source: 'manual',
  }, ME);
  assert.ok(Date.parse(row.updated_at) > 0);
});

test('meta round-trips and reports a default for an unset key', async () => {
  assert.equal(await local.getMeta('cursor:nothing', 'fallback'), 'fallback');
  await local.setMeta('cursor:foods', '2026-08-10T00:00:00.000Z');
  assert.equal(await local.getMeta('cursor:foods', 'fallback'), '2026-08-10T00:00:00.000Z');
});

test('an Alpine proxy can be written without a clone error', async () => {
  // Reactive proxies cannot be structured-cloned, which is what IndexedDB does.
  // local.save() round-trips through JSON to strip them.
  const reactive = new Proxy(
    { name: 'Proxied', serving_qty: 1, serving_unit: 'serving', calories: 1, source: 'manual' },
    { get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; return true; } },
  );
  const row = await local.save('foods', reactive, ME);
  assert.equal((await local.get('foods', row.id)).name, 'Proxied');
});
