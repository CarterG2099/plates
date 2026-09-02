import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();

const progress = await import('../docs/js/progress.js');
const local = await import('../docs/js/local.js');
const { supabase } = await import('../docs/js/supabase.js');

const EMAIL = 'carter@example.com';

// ---- the PIN -----------------------------------------------------------------

test('hashPin is deterministic and hex-shaped', async () => {
  const a = await progress.hashPin(EMAIL, '1234');
  const b = await progress.hashPin(EMAIL, '1234');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('hashPin salts with the email, so a shared PIN stores different hashes', async () => {
  const mine = await progress.hashPin('carter@example.com', '1234');
  const hers = await progress.hashPin('aana@example.com', '1234');
  assert.notEqual(mine, hers);
});

test('hashPin treats the email case-insensitively, like auth does', async () => {
  assert.equal(
    await progress.hashPin('Carter@Example.com', '1234'),
    await progress.hashPin('carter@example.com', '1234'),
  );
});

// ---- the rows ------------------------------------------------------------------

test('photosFor sorts newest day first and drops tombstones', () => {
  const rows = [
    { id: 'a', taken_on: '2026-08-01', updated_at: '1', pose: 'front' },
    { id: 'b', taken_on: '2026-09-01', updated_at: '1', pose: 'front' },
    { id: 'c', taken_on: '2026-08-15', updated_at: '1', pose: 'side', deleted_at: 'x' },
    { id: 'd', taken_on: '2026-08-20', updated_at: '1', pose: 'side' },
  ];
  assert.deepEqual(progress.photosFor(rows).map((p) => p.id), ['b', 'd', 'a']);
  assert.deepEqual(progress.photosFor(rows, 'front').map((p) => p.id), ['b', 'a']);
});

test('savePhoto uploads first, then writes the row pointing at the object', async () => {
  const blob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
  const row = await progress.savePhoto({
    blob, takenOn: '2026-09-02', pose: 'front', note: 'week 1', ownerEmail: EMAIL,
  });

  const uploads = supabase.storage._uploads;
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bucket, 'plates-progress');
  assert.equal(row.object_path, uploads[0].path, 'the row must point at the uploaded object');

  const stored = await local.get('progress_photos', row.id);
  assert.equal(stored.taken_on, '2026-09-02');
  assert.equal(stored.owner_email, EMAIL);

  // The blob is cached immediately, so the grid never re-downloads what it
  // just uploaded — and the photo renders offline from the moment it exists.
  const cached = await local.getBlob(row.object_path);
  assert.equal(await cached.text(), 'jpeg-bytes');
});

test('removePhoto tombstones the row and drops the cached blob', async () => {
  const blob = new Blob(['bytes'], { type: 'image/jpeg' });
  const row = await progress.savePhoto({
    blob, takenOn: '2026-09-01', pose: 'side', note: '', ownerEmail: EMAIL,
  });

  await progress.removePhoto(row);

  const stored = await local.get('progress_photos', row.id);
  assert.ok(stored.deleted_at, 'soft delete, so it propagates to the other device');
  assert.equal(await local.getBlob(row.object_path), null);
  assert.ok(supabase.storage._removed.includes(row.object_path));
});

// ---- the weight under each pane ------------------------------------------------

const weigh = (measured_at, weight_lb, owner_email = EMAIL) =>
  ({ measured_at, weight_lb, owner_email });

test('nearestWeight picks the closest weigh-in inside the window', () => {
  const log = [
    weigh('2026-08-25T08:00:00Z', 190),
    weigh('2026-09-01T08:00:00Z', 186),
    weigh('2026-09-05T08:00:00Z', 184),
  ];
  assert.equal(progress.nearestWeight(log, EMAIL, '2026-09-02'), 186);
});

test('nearestWeight returns null rather than a stale number', () => {
  const log = [weigh('2026-08-01T08:00:00Z', 190)];
  assert.equal(progress.nearestWeight(log, EMAIL, '2026-09-02'), null);
});

test('nearestWeight only reads the photo owner\'s weigh-ins', () => {
  const log = [
    weigh('2026-09-02T08:00:00Z', 130, 'aana@example.com'),
    weigh('2026-08-30T08:00:00Z', 186, EMAIL),
  ];
  assert.equal(progress.nearestWeight(log, EMAIL, '2026-09-02'), 186);
});
