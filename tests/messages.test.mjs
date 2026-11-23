/**
 * The private conversation behind the progress-photo PIN.
 *
 * Writes go through the real local.js and the real Stats screen in app.js;
 * only the network is a stand-in (the stub client's bucket, and a Realtime
 * channel that hands its handler to the test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const messages = await import('../docs/js/messages.js');
const local = await import('../docs/js/local.js');
const { supabase } = await import('../docs/js/supabase.js');

const ME = 'cgividen20@gmail.com';
const AANA = 'aanabraithwaite@gmail.com';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

globalThis.createImageBitmap = async () => ({ width: 3000, height: 4000, close() {} });
document.createElement = () => ({
  width: 0, height: 0,
  getContext: () => ({ drawImage() {} }),
  toBlob: (done) => done(new Blob(['jpeg'], { type: 'image/jpeg' })),
});
URL.createObjectURL = () => 'blob:test';
URL.revokeObjectURL = () => {};

/** Offline for the duration, so the outbox is still holding what was written. */
async function offline(fn) {
  navigator.onLine = false;
  try { return await fn(); } finally { navigator.onLine = true; }
}

/** A Realtime channel whose handler the test can call, and which records removal. */
function fakeChannel() {
  const channel = { handler: null, removed: false };
  supabase.channel = () => ({
    on(_kind, _filter, fn) { channel.handler = fn; return this; },
    subscribe() { return this; },
  });
  supabase.removeChannel = () => { channel.removed = true; };
  return channel;
}

function statsPage() {
  Alpine.store('auth').session = { user: { email: ME } };
  Alpine.store('auth').members = [{ email: ME, sharing: true }, { email: AANA, sharing: true, display_name: 'Aana' }];
  const page = Alpine.reactive(components.statsPage());
  page.$refs = {};
  page.$nextTick = async () => {};
  return page;
}

const msg = (id, sent_at, owner_email = AANA, extra = {}) =>
  ({ id, owner_email, recipient_email: owner_email === ME ? AANA : ME, body: id, sent_at, updated_at: sent_at, ...extra });

// ---- reading the thread ---------------------------------------------------------

test('the thread reads oldest first and leaves out unsent messages', () => {
  const rows = [
    msg('b', '2026-11-20T10:05:00.000Z'),
    msg('a', '2026-11-20T10:00:00.000Z', ME),
    msg('x', '2026-11-20T10:02:00.000Z', ME, { deleted_at: '2026-11-20T10:03:00.000Z' }),
  ];
  assert.deepEqual(messages.thread(rows).map((m) => m.id), ['a', 'b']);
});

// The server stamps `+00:00` with microseconds, this phone writes `Z` with
// milliseconds. As strings, .500Z sorts after .500900+00:00 ('Z' > '9'), so a
// reply in the same millisecond would jump above the message it answers.
test('the thread orders server and phone stamps by time, not by text', () => {
  const rows = [
    msg('later', '2026-11-20T10:00:00.500900+00:00'),
    msg('earlier', '2026-11-20T10:00:00.500Z', ME),
  ];
  assert.deepEqual(messages.thread(rows).map((m) => m.id), ['earlier', 'later']);
});

test('unread counts only their messages, after the last look', () => {
  const rows = [
    msg('old', '2026-11-20T09:00:00.000Z'),
    msg('new', '2026-11-20T11:00:00.000Z'),
    msg('mine', '2026-11-20T12:00:00.000Z', ME),
    msg('gone', '2026-11-20T12:30:00.000Z', AANA, { deleted_at: '2026-11-20T12:31:00.000Z' }),
  ];
  assert.equal(messages.unreadCount(rows, ME, null), 2);
  assert.equal(messages.unreadCount(rows, ME, '2026-11-20T10:00:00.000Z'), 1);
  assert.equal(messages.unreadCount(rows, ME.toUpperCase(), '2026-11-20T10:00:00.000Z'), 1,
    'my own message never counts, whatever the case of the email');
});

test('marking read moves forward and never back', async () => {
  const first = await messages.markRead([msg('a', '2026-11-20T10:00:00.000Z')]);
  assert.equal(first, '2026-11-20T10:00:00.000Z');
  const again = await messages.markRead([msg('b', '2026-11-19T10:00:00.000Z')]);
  assert.equal(again, '2026-11-20T10:00:00.000Z');
});

// ---- sending --------------------------------------------------------------------

test('a text message is written locally and queued, with no network needed', async () => {
  await offline(async () => {
    const row = await messages.sendText({ text: '  hi you  ', ownerEmail: ME, recipientEmail: AANA });
    assert.match(row.id, /^[0-9a-f-]{36}$/, 'the id is made on the phone');

    const stored = await local.get('messages', row.id);
    assert.equal(stored.body, 'hi you');
    assert.equal(stored.owner_email, ME);
    assert.equal(stored.recipient_email, AANA);
    assert.ok(stored.sent_at);

    const queued = (await local.outbox()).filter((e) => e.table === 'messages' && e.row.id === row.id);
    assert.equal(queued.length, 1, 'it waits in the outbox until there is signal');
  });
});

test('an empty message or one with no recipient is refused', async () => {
  await assert.rejects(messages.sendText({ text: '   ', ownerEmail: ME, recipientEmail: AANA }), /Nothing to send/);
  await assert.rejects(messages.sendText({ text: 'hi', ownerEmail: ME, recipientEmail: undefined }), /No one/);
});

test('a photo is uploaded to the messages bucket before the row points at it', async () => {
  const before = supabase.storage._uploads.length;
  const blob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
  const row = await messages.savePhotoMessage({ blob, text: 'look', ownerEmail: ME, recipientEmail: AANA });

  const upload = supabase.storage._uploads[before];
  assert.equal(upload.bucket, 'plates-messages', 'never the progress bucket');
  assert.equal(row.photo_path, upload.path);
  assert.equal(row.body, 'look');
  assert.equal(await (await local.getBlob(row.photo_path)).text(), 'jpeg-bytes', 'cached, so it shows offline');
});

test('a photo with no caption stores no text', async () => {
  const row = await messages.savePhotoMessage({ blob: new Blob(['x']), text: '  ', ownerEmail: ME, recipientEmail: AANA });
  assert.equal(row.body, null);
});

test('sending a photo offline says so and uploads nothing', async () => {
  const before = supabase.storage._uploads.length;
  await offline(() => assert.rejects(
    messages.sendPhoto({ file: new Blob(['x']), text: '', ownerEmail: ME, recipientEmail: AANA }),
    /needs a connection/));
  assert.equal(supabase.storage._uploads.length, before);
});

// ---- unsending ------------------------------------------------------------------

test('unsend tombstones the row, clears the text, and removes the photo', async () => {
  const row = await messages.savePhotoMessage({ blob: new Blob(['x']), text: 'secret', ownerEmail: ME, recipientEmail: AANA });

  await offline(async () => {
    await messages.unsend(row);

    const stored = await local.get('messages', row.id);
    assert.ok(stored.deleted_at, 'soft, so it reaches the other phone');
    assert.equal(stored.body, null, 'the text does not stay on the server');

    const queued = (await local.outbox()).filter((e) => e.table === 'messages' && e.row.id === row.id).at(-1);
    assert.ok(queued.row.deleted_at);
    assert.equal(queued.row.body, null, 'the queued copy is the cleared one');
  });

  assert.equal(await local.getBlob(row.photo_path), null);
  assert.ok(supabase.storage._removed.includes(row.photo_path));
});

test('a photo the other person unsent is dropped from this phone', async () => {
  const theirs = msg('their-photo', '2026-11-20T10:00:00.000Z', AANA,
    { photo_path: 'their.jpg', deleted_at: '2026-11-20T10:01:00.000Z' });
  await local.putLocal('messages', theirs);
  await local.putBlob('their.jpg', new Blob(['x']));
  await local.putBlob('kept.jpg', new Blob(['y']));
  await local.putLocal('messages', msg('kept', '2026-11-20T10:00:00.000Z', AANA, { photo_path: 'kept.jpg' }));

  await messages.purgeUnsent();
  assert.equal(await local.getBlob('their.jpg'), null);
  assert.ok(await local.getBlob('kept.jpg'), 'a live message keeps its photo');
});

// ---- live delivery --------------------------------------------------------------

test('a live row lands locally, and an older copy never overwrites a newer one', async () => {
  const channel = fakeChannel();
  const seen = [];
  const stop = messages.listen((row) => seen.push(row.id));

  const fresh = msg('live-1', '2026-11-20T10:00:00.000Z', AANA, { updated_at: '2026-11-20T10:05:00.000Z' });
  await channel.handler({ new: fresh });
  assert.equal((await local.get('messages', 'live-1')).body, 'live-1');
  assert.deepEqual(seen, ['live-1']);

  await channel.handler({ new: { ...fresh, body: 'stale', updated_at: '2026-11-20T10:01:00.000Z' } });
  assert.equal((await local.get('messages', 'live-1')).body, 'live-1');
  assert.deepEqual(seen, ['live-1'], 'nothing to redraw for a stale copy');

  stop();
  assert.equal(channel.removed, true);
});

// ---- who gets a conversation ------------------------------------------------------

const ANDRA = 'andragividen@gmail.com';
const TEST = 'carterhustle20@gmail.com';

// As loadMembership leaves it: sharing is true only for members whose grant
// reaches this account. Andra and the test account share with no one.
const household = (viewer) => [ME, AANA, ANDRA, TEST].map((email) => ({
  email,
  sharing: (viewer === ME && email === AANA) || (viewer === AANA && email === ME),
}));

test('Carter and Aana each get the other, and only the other', () => {
  assert.equal(messages.partnerFor(household(ME), ME)?.email, AANA);
  assert.equal(messages.partnerFor(household(AANA), AANA)?.email, ME);
});

test('Andra and the test account get no one to message', () => {
  assert.equal(messages.partnerFor(household(ANDRA), ANDRA), undefined);
  assert.equal(messages.partnerFor(household(TEST), TEST), undefined);
});

// partnerOf() reads an unknown `sharing` as "any other member". A failed
// grants query, or a membership cached before the flag, must not turn that
// into a conversation.
test('a membership without confirmed sharing gives no one to message', () => {
  const unknown = [ME, AANA, ANDRA].map((email) => ({ email }));
  assert.equal(messages.partnerFor(unknown, ANDRA), undefined);
  assert.equal(messages.partnerFor(unknown, ME), undefined);
});

test('for Andra there is no Messages button and the conversation will not open', () => {
  fakeChannel();
  Alpine.store('auth').session = { user: { email: ANDRA } };
  Alpine.store('auth').members = household(ANDRA);
  const page = Alpine.reactive(components.statsPage());
  page.$refs = {};
  page.photosLocked = false;

  assert.equal(page.chatPartner, undefined, 'the button is shown on chatPartner');
  page.openChat();
  assert.equal(page.chatOpen, false);
});

test('the Messages button is shown only when there is someone to message', async () => {
  const html = await read('../docs/index.html');
  assert.match(html, /<button class="btn" x-show="chatPartner" @click="openChat\(\)"/);
});

// ---- the screen -----------------------------------------------------------------

test('the conversation will not open while the photos are locked', () => {
  fakeChannel();
  const page = statsPage();
  page.openChat();
  assert.equal(page.chatOpen, false);
});

test('locking closes the conversation and stops listening', () => {
  const channel = fakeChannel();
  const page = statsPage();
  page.photosLocked = false;
  page.openChat();
  page.chatText = 'half typed';
  assert.equal(page.chatOpen, true);

  page.relockPhotos();
  assert.equal(page.chatOpen, false);
  assert.equal(page.chatText, '', 'a half-typed message does not survive the lock');
  assert.equal(channel.removed, true);
});

test('Send writes to the other person and clears the box', async () => {
  fakeChannel();
  const page = statsPage();
  page.photosLocked = false;
  page.openChat();
  page.chatText = 'see you at 6';

  await offline(() => page.sendChat());
  assert.equal(page.chatText, '');
  const sent = (await local.all('messages')).find((m) => m.body === 'see you at 6');
  assert.equal(sent.owner_email, ME);
  assert.equal(sent.recipient_email, AANA);
  page.closeChat();
});

// ---- wiring ---------------------------------------------------------------------

test('messages are stored locally, synced, and the module is precached', async () => {
  assert.ok(local.TABLES.includes('messages'));
  assert.match(await read('../docs/js/sync.js'), /'messages',/);
  assert.match(await read('../docs/sw.js'), /'\/js\/messages\.js',/);
});

test('the photo picker sits outside the lock, the conversation inside it', async () => {
  const html = await read('../docs/index.html');
  const input = html.indexOf('id="pm-photo"');
  const lockGate = html.indexOf('x-if="photosLocked"');
  assert.ok(input !== -1 && input < lockGate, 'a relock must not destroy the input mid-pick');
  assert.match(html, /<template x-if="chatOpen && !photosLocked">/);
  assert.match(html, /<template x-if="chatViewing && chatOpen && !photosLocked">/);
});

test('only the sender and the recipient can read a message', async () => {
  const sql = await read('../supabase/schema.sql');
  const start = sql.indexOf('-- ---- private messages');
  const block = sql.slice(start);
  assert.ok(start !== -1);

  assert.match(block, /create policy messages_read on plates\.messages\s+for select using \(plates\.is_member\(\) and \(plates\.is_owner\(owner_email\) or plates\.is_owner\(recipient_email\)\)\)/);
  // can_read() follows share_grants; reading a message must not.
  assert.doesNotMatch(block.match(/create policy messages_read[^;]+;/)[0], /can_read/);
  assert.doesNotMatch(block, /using \(true\)|allowed_emails|public\./);
  assert.match(block, /bucket_id = 'plates-messages'\s+and exists \([\s\S]+?m\.deleted_at is null/,
    'an unsent photo is unreadable even if its object is still there');
  assert.match(block, /alter publication supabase_realtime add table plates\.messages/);
  assert.match(block, /after insert on plates\.messages/, 'a retried upsert lands as an update and must not push twice');
});

test('the push says there is a message and nothing about it', async () => {
  const fn = await read('../supabase/functions/notify-message/index.ts');
  const payload = fn.match(/const payload = JSON\.stringify\((\{[^}]+\})\)/)[1];
  assert.doesNotMatch(payload, /body:\s*message|photo|owner_email|display_name/);
  assert.match(fn, /x-cron-secret/);
});
