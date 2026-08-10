/**
 * local.js — the local-first primitives everything else is built on.
 *
 * These are the guarantees DESIGN.md calls non-negotiable: ids are generated on
 * the client, deletes are soft, and every write is queued for sync. If one of
 * these breaks, data loss follows quietly.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();

// Offline for this file only. Every write nudges sync, and against the stub
// client a push "succeeds" and dequeues — which would empty the outbox out from
// under the assertions below, intermittently and only sometimes.
navigator.onLine = false;

const local = await import('../docs/js/local.js');

beforeEach(() => local.wipe());

test('a saved row gets a client-generated uuid', async () => {
  const row = await local.save('foods', { name: 'Oats' }, 'c@x');
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('an id supplied by the caller is kept, so a save is an upsert', async () => {
  const first = await local.save('foods', { name: 'Oats' }, 'c@x');
  const second = await local.save('foods', { id: first.id, name: 'Rolled Oats' }, 'c@x');

  assert.equal(second.id, first.id);
  assert.equal((await local.all('foods')).length, 1, 'updating must not leave a duplicate');
  assert.equal((await local.get('foods', first.id)).name, 'Rolled Oats');
});

test('owner_email falls back to the signed-in user but never overwrites one', async () => {
  const mine = await local.save('foods', { name: 'Oats' }, 'c@x');
  assert.equal(mine.owner_email, 'c@x');

  // Barcode-cache rows are deliberately owner-less and shared between users.
  // `save` spreads fields last precisely so this null survives.
  const shared = await local.save('foods', { name: 'Fresca', owner_email: null }, 'c@x');
  assert.equal(shared.owner_email, null, 'a cache row must not be claimed by the editor');
});

test('every save stamps updated_at, which sync orders by', async () => {
  const row = await local.save('foods', { name: 'Oats' }, 'c@x');
  assert.ok(Date.parse(row.updated_at) > 0);
});

test('deletes are soft, and tombstones are hidden from reads but kept on disk', async () => {
  const row = await local.save('foods', { name: 'Oats' }, 'c@x');
  const removed = await local.remove('foods', row.id);

  assert.ok(removed.deleted_at, 'a delete must tombstone rather than drop');
  assert.equal((await local.all('foods')).length, 0, 'reads hide tombstones');
  assert.equal((await local.allRaw('foods')).length, 1, 'sync still needs to see it');
});

test('removing a row that is not there is a no-op rather than a throw', async () => {
  assert.equal(await local.remove('foods', 'nope'), null);
});

test('writes queue for sync, in order, tagged with their table', async () => {
  await local.save('foods', { name: 'A' }, 'c@x');
  await local.save('food_log', { description: 'B', quantity: 1, unit: 'g' }, 'c@x');

  const queued = await local.outbox();
  assert.deepEqual(queued.map((e) => e.table), ['foods', 'food_log']);
  assert.equal(await local.pendingCount(), 2);
});

test('a soft delete is queued too, or it never reaches the other device', async () => {
  const row = await local.save('foods', { name: 'Oats' }, 'c@x');
  await local.remove('foods', row.id);

  const queued = await local.outbox();
  assert.equal(queued.length, 2);
  assert.ok(queued[1].row.deleted_at);
});

test('dequeue drops only what was sent', async () => {
  await local.save('foods', { name: 'A' }, 'c@x');
  await local.save('foods', { name: 'B' }, 'c@x');

  const queued = await local.outbox();
  await local.dequeue([queued[0].seq]);

  const left = await local.outbox();
  assert.equal(left.length, 1);
  assert.equal(left[0].row.name, 'B');
});

test('a stored row is a copy, so later mutation of the caller object cannot reach it', async () => {
  const fields = { name: 'Oats', nested: { a: 1 } };
  const row = await local.save('foods', fields, 'c@x');
  fields.nested.a = 999;

  assert.equal((await local.get('foods', row.id)).nested.a, 1);
});

test('meta round-trips, with a fallback when unset', async () => {
  assert.equal(await local.getMeta('cursor:foods', 'none'), 'none');
  await local.setMeta('cursor:foods', '2026-01-01');
  assert.equal(await local.getMeta('cursor:foods'), '2026-01-01');
});

test('wipe clears rows, outbox and meta together', async () => {
  await local.save('foods', { name: 'Oats' }, 'c@x');
  await local.setMeta('cursor:foods', 'x');
  await local.wipe();

  assert.equal((await local.allRaw('foods')).length, 0);
  assert.equal(await local.pendingCount(), 0);
  assert.equal(await local.getMeta('cursor:foods', 'gone'), 'gone');
});
