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

/**
 * Realtime channels whose handlers the test can call, and which record removal.
 * `handler` is the messages table's; `handlers` has every table and broadcast
 * by name, and `sent` what this side broadcast.
 */
function fakeChannel() {
  const channel = { handler: null, handlers: {}, sent: [], removed: false };
  supabase.channel = () => ({
    on(_kind, filter, fn) {
      const name = filter?.table ?? filter?.event;
      channel.handlers[name] = fn;
      if (name === 'messages') channel.handler = fn;
      return this;
    },
    subscribe() { return this; },
    send(message) { channel.sent.push(message); return Promise.resolve('ok'); },
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

// ---- the thread's layout ------------------------------------------------------------

const NOON = new Date(2026, 10, 24, 12, 0);              // local time, so day labels are stable
const local_ = (h, m, dayOffset = 0) => new Date(2026, 10, 24 + dayOffset, h, m).toISOString();
const row = (id, sent_at, owner_email = AANA) => ({ id, owner_email, sent_at, body: id, updated_at: sent_at });

test('a new day gets a marker: Today, Yesterday, or the date', () => {
  const items = messages.layout([
    row('a', local_(9, 0, -3)), row('b', local_(9, 0, -1)), row('c', local_(9, 0)),
  ], NOON);
  const markers = items.filter((i) => i.kind === 'marker').map((i) => i.label);
  assert.equal(markers.length, 3);
  assert.notEqual(markers[0], 'Yesterday');
  assert.deepEqual(markers.slice(1), ['Yesterday', 'Today']);
});

test('a quiet hour on the same day gets the time as its marker', () => {
  const items = messages.layout([row('a', local_(8, 0)), row('b', local_(8, 59)), row('c', local_(10, 0))], NOON);
  const labels = items.map((i) => (i.kind === 'marker' ? `[${i.label}]` : i.m.id));
  assert.deepEqual(labels.slice(0, 3), ['[Today]', 'a', 'b'], 'under an hour: no marker');
  assert.equal(labels[3], `[${messages.clockLabel(local_(10, 0))}]`);
  assert.equal(labels[4], 'c');
});

test('one person\'s messages within five minutes run together; the other person or a gap breaks the run', () => {
  const items = messages.layout([
    row('a1', local_(9, 0)), row('a2', local_(9, 4)), row('a3', local_(9, 8)),   // each within 5 min of the last
    row('m1', local_(9, 9), ME),                                                  // the other person
    row('a4', local_(9, 10)), row('a5', local_(9, 16)),                           // 6 minutes apart
  ], NOON).filter((i) => i.kind === 'msg');
  assert.deepEqual(items.map((i) => [i.m.id, i.place]), [
    ['a1', 'first'], ['a2', 'middle'], ['a3', 'last'],
    ['m1', 'single'],
    ['a4', 'single'], ['a5', 'single'],
  ]);
});

test('a marker always ends a run, even between one person\'s messages', () => {
  const items = messages.layout([row('a', local_(23, 58, -1)), row('b', local_(0, 1))], NOON)
    .filter((i) => i.kind === 'msg');
  assert.deepEqual(items.map((i) => i.place), ['single', 'single'], 'midnight splits them');
});

test('unsent messages leave no gap in a run', () => {
  const items = messages.layout([
    row('a', local_(9, 0)), { ...row('x', local_(9, 1)), deleted_at: local_(9, 2) }, row('b', local_(9, 2)),
  ], NOON).filter((i) => i.kind === 'msg');
  assert.deepEqual(items.map((i) => [i.m.id, i.place]), [['a', 'first'], ['b', 'last']]);
});

// ---- reactions ------------------------------------------------------------------------

const reaction = (id, message_id, owner_email, emoji, updated_at, extra = {}) =>
  ({ id, message_id, owner_email, emoji, updated_at, ...extra });

test('each person shows their newest live reaction, and only on its own message', () => {
  const rows = [
    reaction('r1', 'msg-1', ME, '🔥', '2026-11-24T10:00:00Z'),
    reaction('r2', 'msg-1', ME, '😍', '2026-11-24T10:05:00Z'),            // a second phone, newer
    reaction('r3', 'msg-1', AANA, '😈', '2026-11-24T10:01:00Z'),
    reaction('r4', 'msg-1', AANA, '❤️', '2026-11-24T10:09:00Z', { deleted_at: '2026-11-24T10:09:00Z' }),
    reaction('r5', 'msg-2', ME, '👍', '2026-11-24T10:00:00Z'),
  ];
  const shown = messages.reactionsFor(rows, 'msg-1');
  assert.deepEqual(shown.map((r) => [r.owner_email, r.emoji]), [[AANA, '😈'], [ME, '😍']]);
});

test('reacting writes my own row locally and queues it, with no network needed', async () => {
  const before = (await local.outbox()).length;
  const r = await offline(() => messages.react({ reactions: [], messageId: 'react-1', emoji: '🔥', ownerEmail: ME }));
  assert.equal(r.owner_email, ME);
  assert.equal(r.message_id, 'react-1');
  assert.equal(r.emoji, '🔥');
  assert.ok((await local.outbox()).length > before);
});

test('a different emoji changes my reaction; the same one takes it back', async () => {
  const first = await offline(() => messages.react({ reactions: [], messageId: 'react-2', emoji: '🔥', ownerEmail: ME }));
  const changed = await offline(() => messages.react({ reactions: [first], messageId: 'react-2', emoji: '😈', ownerEmail: ME }));
  assert.equal(changed.id, first.id, 'the same row, changed');
  assert.equal(changed.emoji, '😈');
  const gone = await offline(() => messages.react({ reactions: [changed], messageId: 'react-2', emoji: '😈', ownerEmail: ME }));
  assert.ok(gone.deleted_at, 'taken back');
  assert.deepEqual(messages.reactionsFor(await local.allRaw('message_reactions'), 'react-2'), []);
});

test('taking a reaction back also clears an older duplicate from another phone, and never touches theirs', async () => {
  const old = reaction('dup-old', 'react-3', ME, '🔥', '2026-11-24T09:00:00Z');
  const newer = reaction('dup-new', 'react-3', ME, '😍', '2026-11-24T09:05:00Z');
  const theirs = reaction('dup-theirs', 'react-3', AANA, '😍', '2026-11-24T09:06:00Z');
  await offline(() => messages.react({ reactions: [old, newer, theirs], messageId: 'react-3', emoji: '😍', ownerEmail: ME }));
  assert.ok((await local.get('message_reactions', 'dup-old')).deleted_at);
  assert.ok((await local.get('message_reactions', 'dup-new')).deleted_at);
  assert.equal(await local.get('message_reactions', 'dup-theirs'), undefined, 'their row was never written');
});

test('a reaction arrives live like a message does', async () => {
  const channel = fakeChannel();
  const seen = [];
  const stop = messages.listen((r) => seen.push(r.id));
  await channel.handlers.message_reactions({ new: reaction('live-r', 'm', AANA, '🥵', '2026-11-24T11:00:00Z') });
  assert.equal((await local.get('message_reactions', 'live-r')).emoji, '🥵');
  assert.deepEqual(seen, ['live-r']);
  stop();
});

test('reactions are stored locally, synced, and in a new local database version', async () => {
  assert.ok(local.TABLES.includes('message_reactions'));
  assert.match(await read('../docs/js/sync.js'), /'message_reactions',/);
  assert.match(await read('../docs/js/local.js'), /const DB_VERSION = 9;/);
});

test('only the two people in a message see or add reactions to it, and only as themselves', async () => {
  const sql = await read('../supabase/schema.sql');
  const block = sql.slice(sql.indexOf('-- ---- message reactions'));
  assert.match(block, /create policy message_reactions_read on plates\.message_reactions\s+for select using \(\s*plates\.is_member\(\)\s+and exists \(select 1 from plates\.messages m where m\.id = message_id\)/,
    'the exists() runs under messages_read: sender or recipient only');
  assert.match(block, /for insert with check \(\s*plates\.is_member\(\) and plates\.is_owner\(owner_email\)/);
  assert.match(block, /for update using \(plates\.is_owner\(owner_email\)\)\s+with check \(plates\.is_owner\(owner_email\)\)/);
  assert.doesNotMatch(block, /can_read|using \(true\)|allowed_emails|public\./);
  const code = block.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /unique/i, 'two phones reacting offline must not jam the outbox');
});

// ---- typing -----------------------------------------------------------------------------

test('a typing signal carries a short tag, never an email', async () => {
  const mine = await messages.typingTag(ME);
  assert.match(mine, /^[0-9a-f]{12}$/);
  assert.equal(mine, await messages.typingTag(ME.toUpperCase()), 'case does not matter');
  assert.notEqual(mine, await messages.typingTag(AANA));
});

test('their typing shows, goes after five quiet seconds, and mine or anyone else\'s is ignored', async (t) => {
  const channel = fakeChannel();
  const states = [];
  const typing = messages.typingChannel({ myEmail: ME, partnerEmail: AANA, onChange: (on) => states.push(on) });
  const [meTag, andraTag, aanaTag] = await Promise.all([ME, ANDRA, AANA].map(messages.typingTag));
  await new Promise((r) => setTimeout(r, 0));         // the channel hashes its tags asynchronously
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const fire = channel.handlers.typing;
  fire({ payload: { from: meTag, on: true } });
  fire({ payload: { from: andraTag, on: true } });
  assert.deepEqual(states, [], 'not from them');

  fire({ payload: { from: aanaTag, on: true } });
  assert.deepEqual(states, [true]);
  t.mock.timers.tick(messages.TYPING_MS - 1);
  assert.deepEqual(states, [true]);
  t.mock.timers.tick(1);
  assert.deepEqual(states, [true, false], 'gone quiet');

  fire({ payload: { from: aanaTag, on: true } });
  fire({ payload: { from: aanaTag, on: false } });
  assert.deepEqual(states, [true, false, true, false], 'they sent or cleared the box');
  typing.close();
});

test('my typing is signalled at most every few seconds, stopped once, and nothing names me', async (t) => {
  const channel = fakeChannel();
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const typing = messages.typingChannel({ myEmail: ME, partnerEmail: AANA, onChange() {} });
  // Signals wait on hashing the tags, which can take more than one tick under
  // a full test run: wait for what was sent, then give a straggler a chance.
  const sentUntil = async (n) => {
    for (let i = 0; i < 200 && channel.sent.length < n; i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  typing.typing();
  typing.typing();
  await sentUntil(1);
  assert.equal(channel.sent.length, 1, 'throttled');
  t.mock.timers.tick(3000);
  typing.typing();
  typing.stopped();
  typing.stopped();
  await sentUntil(3);
  assert.deepEqual(channel.sent.map((s) => s.payload.on), [true, true, false]);
  assert.ok(channel.sent.every((s) => s.type === 'broadcast' && s.event === 'typing'));
  assert.doesNotMatch(JSON.stringify(channel.sent), /@/, 'no email on the wire');
  typing.close();
  assert.equal(channel.removed, true);
});

// ---- the screen: gestures -----------------------------------------------------------------

function openChatPage() {
  const channel = fakeChannel();
  const page = statsPage();
  page.photosLocked = false;
  page.openChat();
  return { page, channel };
}

const text = { id: 'g-text', owner_email: AANA, body: 'hey you', sent_at: '2026-11-24T10:00:00Z' };
const photo = { id: 'g-photo', owner_email: AANA, photo_path: 'x.jpg', body: null, sent_at: '2026-11-24T10:00:00Z' };
const at0 = { clientX: 100, clientY: 100 };

test('a tap on a message shows its time; another tap hides it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { page } = openChatPage();
  page.chatPressStart(text, at0, 'text');
  page.chatPressEnd(text);
  assert.equal(page.chatTimeFor, null, 'waits to see if it is a double-tap');
  t.mock.timers.tick(page.doubleTapMs);
  assert.equal(page.chatTimeFor, text.id);

  page.chatPressStart(text, at0, 'text');
  page.chatPressEnd(text);
  t.mock.timers.tick(page.doubleTapMs);
  assert.equal(page.chatTimeFor, null);
  page.closeChat();
});

test('a double-tap hearts the message and does not show the time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { page } = openChatPage();
  page.chatPressStart(text, at0, 'text'); page.chatPressEnd(text);
  t.mock.timers.tick(100);
  page.chatPressStart(text, at0, 'text'); page.chatPressEnd(text);
  t.mock.timers.tick(1000);
  t.mock.timers.reset();
  await new Promise((r) => setImmediate(r));

  assert.equal(page.chatTimeFor, null);
  const mine = messages.reactionsFor(await local.allRaw('message_reactions'), text.id);
  assert.deepEqual(mine.map((r) => [r.owner_email, r.emoji]), [[ME, '❤️']]);
  page.closeChat();
});

test('holding a photo uncovers it only while held, and does not open it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { page } = openChatPage();
  page.chatPressStart(photo, at0, 'photo');
  t.mock.timers.tick(page.revealMs - 1);
  assert.equal(page.chatRevealed, null, 'not on first touch, so a scroll never flashes it');
  assert.ok(page.revealMs >= 100);
  t.mock.timers.tick(1);
  assert.equal(page.chatRevealed, photo.id);
  page.chatPressEnd(photo);
  assert.equal(page.chatRevealed, null, 'covered again on letting go');
  t.mock.timers.tick(1000);
  assert.equal(page.chatViewing, null);
  page.closeChat();
});

test('a tap on a photo opens it full screen, still covered', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { page } = openChatPage();
  page.chatPressStart(photo, at0, 'photo'); page.chatPressEnd(photo);
  t.mock.timers.tick(page.doubleTapMs);
  assert.equal(page.chatViewing?.id, photo.id);
  assert.equal(page.chatRevealed, null);
  page.chatHold('viewer');
  assert.equal(page.chatRevealed, 'viewer');
  page.chatRelease();
  assert.equal(page.chatRevealed, null);
  page.closeChat();
});

test('moving the finger is a scroll: it covers the photo and cancels the tap', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { page } = openChatPage();
  page.chatPressStart(photo, at0, 'photo');
  t.mock.timers.tick(page.revealMs);
  page.chatPressMove({ clientX: 100, clientY: 140 });
  assert.equal(page.chatRevealed, null);
  page.chatPressEnd(photo);
  t.mock.timers.tick(1000);
  assert.equal(page.chatViewing, null);
  page.closeChat();
});

test('holding a text bubble opens the reactions menu; choosing one closes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { page } = openChatPage();
  page.chatPressStart(text, at0, 'text');
  t.mock.timers.tick(page.holdMs);
  assert.equal(page.chatMenu?.id, text.id);
  page.chatPressEnd(text);
  t.mock.timers.tick(1000);
  assert.equal(page.chatTimeFor, null, 'a hold is not a tap');
  t.mock.timers.reset();
  await page.chatReact(text, '🥵');
  assert.equal(page.chatMenu, null);
  page.closeChat();
});

test('typing in the box tells them; sending, clearing or closing stops it', async () => {
  const { page, channel } = openChatPage();
  const aanaTag = await messages.typingTag(AANA);
  await new Promise((r) => setTimeout(r, 0));
  page.chatText = 'on my';
  page.chatInput({ target: null });
  page.chatText = '';
  page.chatInput({ target: null });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(channel.sent.map((s) => s.payload.on), [true, false]);

  channel.handlers.typing({ payload: { from: aanaTag, on: true } });
  assert.equal(page.chatTheyType, true);
  page.closeChat();
  assert.equal(page.chatTheyType, false);
  assert.equal(channel.removed, true);
});

test('locking mid-hold covers the photo and drops the menu', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { page } = openChatPage();
  page.chatPressStart(photo, at0, 'photo');
  t.mock.timers.tick(page.revealMs);
  page.chatMenu = text;
  page.relockPhotos();
  assert.equal(page.chatRevealed, null);
  assert.equal(page.chatMenu, null);
});

// ---- the screen: markup and styles ----------------------------------------------------------

test('every photo surface is blurred unless held, in the thread, the box, and full screen', async () => {
  const css = await read('../docs/css/components.css');
  const covered = css.match(/\.chat-photo img, \.chat-viewer-photo img, \.chat-pending img,\s*\.chat-photo video, \.chat-viewer-photo video, \.chat-pending video \{[^}]+\}/)?.[0] ?? '';
  assert.match(covered, /filter: blur\(\d+px\)/, 'photos and clips alike');
  assert.match(css, /\.chat-photo\.is-revealed img, \.chat-viewer-photo\.is-revealed img, \.chat-pending\.is-revealed img,\s*\.chat-photo\.is-revealed video, \.chat-viewer-photo\.is-revealed video, \.chat-pending\.is-revealed video \{\s*filter: none;/);

  const html = await read('../docs/index.html');
  assert.match(html, /class="chat-photo" :class="chatRevealed === item\.m\.id && 'is-revealed'"/);
  assert.match(html, /class="chat-pending" :class="chatRevealed === 'pending' && 'is-revealed'"/);
  assert.match(html, /class="chat-viewer-photo" :class="chatRevealed === 'viewer' && 'is-revealed'"/);
});

test('the conversation has its own dark colours and Send is an icon', async () => {
  const css = await read('../docs/css/components.css');
  assert.match(css, /\.chat, \.chat-scrim, \.chat-viewer \{\s*--chat-ground: #0c0a0f;/);
  assert.match(css, /color-scheme: dark;/);
  const html = await read('../docs/index.html');
  assert.match(html, /<button class="chat-icon chat-send" type="submit" aria-label="Send"/);
  assert.match(html, /<textarea class="chat-box" x-ref="chatBox"/);
});

test('the thread draws markers and runs from layout, and reactions under each bubble', async () => {
  const html = await read('../docs/index.html');
  assert.match(html, /<template x-for="item in chatItems" :key="item\.key">/);
  assert.match(html, /<div class="chat-marker" x-text="item\.label"><\/div>/);
  assert.match(html, /`is-\$\{item\.place\}`/);
  assert.match(html, /<template x-for="r in chatReactions\(item\.m\)" :key="r\.id">/);
  assert.match(html, /<template x-for="e in chatReactionBar" :key="e">/);
});

// ---- a photo that won't load -----------------------------------------------------------
//
// It used to vanish: the error was dropped and the empty box had no height.

/** The bucket's download, answering from `answer` and counting calls. */
function fakeDownload(answer) {
  const calls = [];
  const real = supabase.storage.from;
  supabase.storage.from = function (bucket) {
    return { ...real.call(this, bucket), download: async (path) => { calls.push(path); return answer(path); } };
  };
  return { calls, restore() { supabase.storage.from = real; } };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a photo that won\'t load says why, and is not retried on every redraw', async () => {
  const dl = fakeDownload(() => ({ data: null, error: { message: 'Object not found' } }));
  try {
    const { page } = openChatPage();
    const m = { id: 'nf-1', owner_email: ME, photo_path: 'never-cached.jpg', body: 'caption', sent_at: '2026-11-24T22:05:00Z' };
    assert.equal(page.chatPhotoUrl(m), '');
    assert.equal(page.chatPhotoState(m), 'loading');
    await settle(); await settle();
    assert.equal(page.chatPhotoState(m), 'failed');
    assert.match(page.chatUrlFailed[m.id], /Object not found/);

    page.chatPhotoUrl(m); page.chatPhotoUrl(m);
    await settle();
    assert.equal(dl.calls.length, 1, 'no retry loop');
    page.closeChat();
    assert.deepEqual(page.chatUrlFailed, {}, 'closing forgets it');
  } finally {
    dl.restore();
  }
});

test('tapping a photo that failed tries again instead of opening it', async (t) => {
  let ok = false;
  const dl = fakeDownload(() => (ok
    ? { data: new Blob(['jpeg'], { type: 'image/jpeg' }), error: null }
    : { data: null, error: { message: 'Failed to fetch' } }));
  try {
    const { page } = openChatPage();
    const m = { id: 'nf-2', owner_email: ME, photo_path: 'flaky.jpg', body: null, sent_at: '2026-11-24T22:05:00Z' };
    page.chatPhotoUrl(m);
    await settle(); await settle();
    assert.equal(page.chatPhotoState(m), 'failed');

    ok = true;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    page.chatPressStart(m, { clientX: 0, clientY: 0 }, 'photo');
    page.chatPressEnd(m);
    t.mock.timers.tick(page.doubleTapMs);
    t.mock.timers.reset();
    await settle(); await settle();

    assert.equal(page.chatViewing, null, 'a retry, not the viewer');
    assert.equal(dl.calls.length, 2);
    assert.equal(page.chatPhotoState(m), 'ready');
    assert.equal(page.chatUrlFailed[m.id], undefined);
    page.closeChat();
  } finally {
    dl.restore();
  }
});

test('the photo box keeps its size and says what is happening before the photo arrives', async () => {
  const css = await read('../docs/css/components.css');
  assert.match(css, /\.chat-photo \{ width: 220px; max-width: 100%; min-height: 160px;/);
  const html = await read('../docs/index.html');
  assert.match(html, /chatPhotoState\(item\.m\) === 'failed' \? 'Couldn’t load · tap to try again'/);
  assert.match(html, /<span class="chat-photo-error" x-show="chatUrlFailed\[item\.m\.id\]" x-text="chatUrlFailed\[item\.m\.id\]"><\/span>/);
});
