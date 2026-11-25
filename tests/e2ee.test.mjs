/**
 * End-to-end encryption for Messages (docs/js/e2ee.js and the chat screen).
 *
 * The crypto is Node's real WebCrypto, the same API the phones use. The key
 * tables are an in-memory stand-in (helpers/e2ee.mjs); "the other phone" is a
 * second identity made the way her phone would make it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const e2ee = await import('../docs/js/e2ee.js');
const local = await import('../docs/js/local.js');
const { supabase } = await import('../docs/js/supabase.js');
const { fakeKeyServer, readyChat } = await import('./helpers/e2ee.mjs');
const server = fakeKeyServer(supabase);

const ME = 'cgividen20@gmail.com';
const AANA = 'aanabraithwaite@gmail.com';
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

supabase.channel = () => ({ on() { return this; }, subscribe() { return this; }, send() { return Promise.resolve(); } });
supabase.removeChannel = () => {};

function statsPage() {
  Alpine.store('auth').session = { user: { email: ME } };
  Alpine.store('auth').members = [{ email: ME, sharing: true }, { email: AANA, sharing: true, display_name: 'Aana' }];
  const page = Alpine.reactive(components.statsPage());
  page.$refs = {};
  page.$nextTick = async () => {};
  page.photosLocked = false;
  return page;
}

/** A fresh start: no keys on the server, none on this phone. */
async function reset() {
  server.tables.chat_keys.clear();
  server.tables.chat_key_vault.clear();
  await e2ee.forgetIdentity();
  await local.setMeta('e2ee:partner', null);
  await local.setMeta('e2ee:partner-keys', {});
}

/** Two people's keys, the way each phone would make them. */
async function twoPeople() {
  const a = await e2ee.createIdentity(e2ee.newChatKey());
  const b = await e2ee.createIdentity(e2ee.newChatKey());
  return { a, b, ab: await e2ee.pairKey(a.privateKey, b.publicKey), ba: await e2ee.pairKey(b.privateKey, a.publicKey) };
}

// ---- the crypto ---------------------------------------------------------------------

test('a chat key is 32 random bytes in 43 characters a password manager will keep whole', () => {
  const k = e2ee.newChatKey();
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(e2ee.unb64url(k).length, 32);
  assert.notEqual(k, e2ee.newChatKey());
});

test('the private key opens with its chat key, and refuses a wrong or cut-off one', async () => {
  const chatKey = e2ee.newChatKey();
  const id = await e2ee.createIdentity(chatKey);
  const opened = await e2ee.unlockIdentity(id, chatKey);
  assert.equal(opened.type, 'private');
  await assert.rejects(e2ee.unlockIdentity(id, e2ee.newChatKey()), /doesn’t match/);
  await assert.rejects(e2ee.unlockIdentity(id, chatKey.slice(0, 30)), /doesn’t match/, 'a cut-off key is a different key');
  await assert.rejects(e2ee.unlockIdentity(id, chatKey.slice(0, 10)), /isn’t a whole Plates chat key/, 'too short to be any saved key');
});

test('an iCloud Keychain Strong Password works as the chat key, as it did on the iPhone', async () => {
  // Safari puts its own 20-character password in the new-password field in
  // place of ours; that is what iCloud saves and fills back in. Tested on
  // Aana's iPhone 16 on 2026-11-24, after "15 bytes, not 32" under the old rule.
  const saved = 'xyzAbc-defGhi-jklMn4';
  const id = await e2ee.createIdentity(saved);
  const opened = await e2ee.unlockIdentity(id, ` ${saved}\n`);
  assert.equal(opened.type, 'private', 'surrounding whitespace from a fill does not matter');
  await assert.rejects(e2ee.unlockIdentity(id, 'xyzAbc-defGhi-jklMn5'), /doesn’t match/);
});

test('an unlocked private key can be used but never read back out', async () => {
  const chatKey = e2ee.newChatKey();
  const id = await e2ee.createIdentity(chatKey);
  assert.equal(id.privateKey.extractable, false);
  assert.equal((await e2ee.unlockIdentity(id, chatKey)).extractable, false);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', id.privateKey));
});

test('what the server keeps of a private key is ciphertext, and says nothing of the chat key', async () => {
  const chatKey = e2ee.newChatKey();
  const id = await e2ee.createIdentity(chatKey);
  assert.doesNotMatch(id.wrapped, new RegExp(chatKey.slice(0, 12)));
  assert.equal(e2ee.unb64(id.iv).length, 12);
});

test('either of you can open what the other sealed; a third key cannot', async () => {
  const { a, b, ab, ba } = await twoPeople();
  const ids = { from: a.keyId, to: b.keyId };
  const photo = new Blob(['jpeg bytes'], { type: 'image/jpeg' });
  const sealed = await e2ee.seal(ab, { text: 'tonight?', file: photo }, ids);
  const row = { body: sealed.body, enc: sealed.enc };

  assert.deepEqual(await e2ee.open(ba, row), { text: 'tonight?', media: 'image/jpeg' });
  assert.deepEqual(await e2ee.open(ab, row), { text: 'tonight?', media: 'image/jpeg' }, 'the sender can read their own');
  const file = await e2ee.openFile(ba, row, sealed.file, 'image/jpeg');
  assert.equal(await file.text(), 'jpeg bytes');
  assert.equal(file.type, 'image/jpeg');

  const c = await e2ee.createIdentity(e2ee.newChatKey());
  const ca = await e2ee.pairKey(c.privateKey, a.publicKey);
  await assert.rejects(e2ee.open(ca, row));
});

test('nothing readable survives sealing: not the text, not the file, not what kind of file', async () => {
  const { a, b, ab } = await twoPeople();
  const clip = new Blob(['VIDEO-BYTES-HERE'], { type: 'video/mp4' });
  const sealed = await e2ee.seal(ab, { text: 'watch this', file: clip }, { from: a.keyId, to: b.keyId });
  const stored = JSON.stringify({ body: sealed.body, enc: sealed.enc });
  assert.doesNotMatch(stored, /watch this|video|mp4/i);
  assert.equal(sealed.file.type, 'application/octet-stream');
  assert.doesNotMatch(await sealed.file.text(), /VIDEO-BYTES-HERE/);
  assert.deepEqual(Object.keys(sealed.enc).sort(), ['fiv', 'from', 'iv', 'k', 'kiv', 'to', 'v']);
});

test('the same words sealed twice look nothing alike', async () => {
  const { a, b, ab } = await twoPeople();
  const ids = { from: a.keyId, to: b.keyId };
  const one = await e2ee.seal(ab, { text: 'hi' }, ids);
  const two = await e2ee.seal(ab, { text: 'hi' }, ids);
  assert.notEqual(one.body, two.body);
  assert.notEqual(one.enc.k, two.enc.k);
});

test('a message altered on the server will not open', async () => {
  const { a, b, ab, ba } = await twoPeople();
  const sealed = await e2ee.seal(ab, { text: 'original' }, { from: a.keyId, to: b.keyId });
  const bytes = e2ee.unb64(sealed.body);
  bytes[0] ^= 1;
  await assert.rejects(e2ee.open(ba, { body: e2ee.b64(bytes), enc: sealed.enc }));
});

test('the safety code is the same on both phones and changes with either key', async () => {
  const { a, b } = await twoPeople();
  const code = await e2ee.safetyCode(a.publicKey, b.publicKey);
  assert.match(code, /^\d{4} \d{4} \d{4}$/);
  assert.equal(code, await e2ee.safetyCode(b.publicKey, a.publicKey));
  const c = await e2ee.createIdentity(e2ee.newChatKey());
  assert.notEqual(code, await e2ee.safetyCode(a.publicKey, c.publicKey));
});

test('a new key for the other person is noticed, unverifies them, and the old one is kept for old messages', async () => {
  await reset();
  const { a, b } = await twoPeople();
  assert.equal(await e2ee.keepPartner(AANA, a), false, 'first sight is not a change');
  await e2ee.markVerified();
  assert.equal((await e2ee.savedPartner()).verified, true);
  assert.equal(await e2ee.keepPartner(AANA, a), false, 'same key again');
  assert.equal((await e2ee.savedPartner()).verified, true);

  assert.equal(await e2ee.keepPartner(AANA, b), true);
  assert.equal((await e2ee.savedPartner()).verified, false);
  assert.equal(await e2ee.partnerKey(a.keyId), a.publicKey);
  assert.equal(await e2ee.partnerKey(b.keyId), b.publicKey);
});

// ---- the chat screen ------------------------------------------------------------------

test('first time: Messages offers to turn on encryption, with a chat key ready to save', async () => {
  await reset();
  const page = statsPage();
  page.openChat();
  await page.loadChatCrypto();
  assert.equal(page.chatCrypto, 'setup');
  assert.equal(e2ee.unb64url(page.chatNewKey).length, 32);
  page.closeChat();
});

test('turning it on puts only the public key and the locked private key on the server, then waits for “It’s saved”', async () => {
  await reset();
  await server.addPerson(AANA);
  const page = statsPage();
  page.openChat();
  await page.loadChatCrypto();
  const chatKey = page.chatNewKey;

  await page.setUpChatCrypto();
  assert.equal(page.chatCrypto, 'saved-check');
  assert.equal(page.chatNewKey, chatKey, 'still on screen to copy until it is saved');
  const pub = server.tables.chat_keys.get(ME);
  const vault = server.tables.chat_key_vault.get(ME);
  assert.ok(pub.public_key && vault.wrapped_private);
  assert.doesNotMatch(JSON.stringify([...server.calls.map((c) => c.row)]), new RegExp(chatKey), 'the chat key never reaches the server');

  await page.chatKeySaved();
  assert.equal(page.chatNewKey, '');
  assert.equal(page.chatCrypto, 'ready');
  page.closeChat();
});

test('if she hasn’t turned it on yet, sending waits rather than going out unlocked', async () => {
  await reset();
  const page = statsPage();
  page.openChat();
  await page.loadChatCrypto();
  await page.setUpChatCrypto();
  await page.chatKeySaved();
  assert.equal(page.chatCrypto, 'waiting');
  await assert.rejects(page.chatLock(), /isn’t set up/);
  page.closeChat();
});

test('a new phone: the password manager fills the chat key in, and old messages open', async () => {
  await reset();
  const aana = await server.addPerson(AANA);
  const page = statsPage();
  page.openChat();
  await page.loadChatCrypto();
  const chatKey = page.chatNewKey;
  await page.setUpChatCrypto();
  await page.chatKeySaved();

  // She sends one, sealed on her phone.
  const mine = server.tables.chat_keys.get(ME);
  const pair = await e2ee.pairKey(aana.privateKey, mine.public_key);
  const sealed = await e2ee.seal(pair, { text: 'from her phone' }, { from: aana.keyId, to: mine.key_id });
  const row = { id: crypto.randomUUID(), owner_email: AANA, recipient_email: ME, body: sealed.body, enc: sealed.enc,
    photo_path: null, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await local.putManyLocalIfNewer('messages', [row]);
  await Alpine.store('data').refreshCore();
  page.closeChat();

  // This phone forgets everything it unlocked: a new phone.
  await e2ee.forgetIdentity();
  await local.setMeta('e2ee:partner', null);
  await local.setMeta('e2ee:partner-keys', {});
  const fresh = statsPage();
  fresh.openChat();
  await fresh.loadChatCrypto();
  assert.equal(fresh.chatCrypto, 'unlock');

  fresh.chatKeyEntry = e2ee.newChatKey();
  await fresh.unlockChatCrypto();
  assert.match(fresh.chatCryptoError, /doesn’t match/);
  assert.equal(fresh.chatKeyEntry, '', 'a wrong key is not left in the box');

  fresh.chatKeyEntry = chatKey;
  await fresh.unlockChatCrypto();
  assert.equal(fresh.chatCrypto, 'ready');
  await fresh.chatUnlockPending();
  assert.equal(fresh.chatBody(row), 'from her phone');
  fresh.closeChat();
});

test('her key changing is flagged until the safety codes are compared again', async () => {
  await reset();
  await server.addPerson(AANA);
  const page = statsPage();
  page.openChat();
  await readyChat(page, server, AANA);
  await page.showSafetyCode();
  assert.match(page.chatSafety, /^\d{4} \d{4} \d{4}$/);
  await page.confirmSafetyCode();
  assert.equal(page.chatPartnerVerified, true);

  await server.addPerson(AANA);            // her new phone, new key
  await page.loadChatCrypto();
  assert.equal(page.chatPartnerChanged, true);
  assert.equal(page.chatPartnerVerified, false);
  page.closeChat();
});

test('offline on a phone that has never been unlocked, it says to connect once', async () => {
  await reset();
  const realSchema = supabase.schema;
  supabase.schema = () => ({ from: () => ({ select() { return this; }, in() { return Promise.reject(new Error('offline')); } }) });
  try {
    const page = statsPage();
    page.openChat();
    await page.loadChatCrypto();
    assert.equal(page.chatCrypto, 'needs-network');
    page.closeChat();
  } finally {
    supabase.schema = realSchema;
  }
});

test('closing the conversation drops the unlocked text and the keys from memory', async () => {
  await reset();
  const page = statsPage();
  page.openChat();
  await readyChat(page, server, AANA);
  page.chatOpened = { x: { text: 'secret', media: null } };
  page.closeChat();
  assert.deepEqual(page.chatOpened, {});
  await assert.rejects(page.chatLock(), /isn’t set up/);
});

// ---- markup, cache, schema ----------------------------------------------------------------

test('the composer shows only once encryption is ready; the key forms are real username + password pairs that never submit', async () => {
  const html = await read('../docs/index.html');
  assert.match(html, /<form class="chat-compose" x-show="chatCrypto === 'ready'" @submit\.prevent="sendChat\(\)">/);
  assert.match(html, /<template x-if="chatPhoto && chatCrypto === 'ready'">/);
  assert.match(html, /@submit\.prevent="setUpChatCrypto\(\)">[\s\S]*?autocomplete="username" value="Plates chat key"[\s\S]*?autocomplete="new-password"\s+x-model="chatNewKey"/);
  assert.match(html, /@submit\.prevent="unlockChatCrypto\(\)">[\s\S]*?autocomplete="username" value="Plates chat key"[\s\S]*?autocomplete="current-password"\s+x-model="chatKeyEntry"/);
  assert.match(html, /x-text="chatBody\(item\.m\)"/);
  assert.doesNotMatch(html, /x-text="item\.m\.body"|x-text="chatMenu\.body"|x-text="chatViewing\.body"/, 'no ciphertext on screen');
});

test('the encryption module is precached', async () => {
  assert.match(await read('../docs/sw.js'), /'\/js\/e2ee\.js',/);
});

test('the key tables: public keys for members, locked private keys for their owner alone', async () => {
  const sql = await read('../supabase/schema.sql');
  const block = sql.slice(sql.indexOf('-- ---- end-to-end encryption for messages'));
  assert.match(block, /alter table plates\.messages add column if not exists enc jsonb;/);
  assert.match(block, /create policy chat_keys_read on plates\.chat_keys\s+for select using \(plates\.is_member\(\)\);/);
  assert.match(block, /create policy chat_key_vault_read on plates\.chat_key_vault\s+for select using \(plates\.is_member\(\) and plates\.is_owner\(owner_email\)\);/);
  for (const t of ['chat_keys', 'chat_key_vault']) {
    assert.match(block, new RegExp(`alter table plates\\.${t} enable row level security`));
    assert.match(block, new RegExp(`on plates\\.${t}\\s+for insert with check \\(plates\\.is_member\\(\\) and plates\\.is_owner\\(owner_email\\)\\)`));
  }
  assert.doesNotMatch(block, /can_read|using \(true\)|allowed_emails|public\./);
  assert.match(block, /'application\/octet-stream'\]/);
});

test('the schema grants what sealed messages and the key tables need', async () => {
  // messages is granted column by column: the enc column has to be granted too,
  // or every sealed message is refused at sync and nothing sends. Caught while
  // applying the schema on 2026-11-24, after the dry run had passed.
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const block = sql.slice(sql.indexOf('-- ---- end-to-end encryption for messages'));
  assert.match(block, /grant select \(enc\), insert \(enc\), update \(enc\) on plates\.messages to authenticated;/);
  assert.match(block, /grant select, insert, update on plates\.chat_keys to authenticated;/);
  assert.match(block, /grant select, insert, update on plates\.chat_key_vault to authenticated;/);
  assert.match(block, /create policy chat_key_vault_read on plates\.chat_key_vault\s+for select using \(plates\.is_member\(\) and plates\.is_owner\(owner_email\)\);/,
    'a locked private key is readable by its owner alone');
});

test('setup tells you to tap the key box, since a password manager only saves a field you touched', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const setup = html.slice(html.indexOf(`<template x-if="chatCrypto === 'setup'">`), html.indexOf(`<template x-if="chatCrypto === 'saved-check'">`));
  assert.match(setup, /First tap the key box below/);
  assert.match(setup, /autocomplete="new-password"\s+x-model="chatNewKey"/);
});

// ---- locking what was sent before encryption -------------------------------------------

const messagesModule = await import('../docs/js/messages.js');

/** A plain, pre-encryption row of mine or hers, already on this phone. */
async function plainRow(over) {
  const row = { id: crypto.randomUUID(), owner_email: ME, recipient_email: AANA, body: 'before encryption',
    photo_path: null, enc: null, deleted_at: null, sent_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over };
  await local.putManyLocalIfNewer('messages', [row]);
  return row;
}

/** Watches the bucket: every upload and remove, in order; `refuseRemoves` makes deletes fail. */
function watchBucket() {
  const steps = [];
  const real = supabase.storage.from;
  let failRemove = false;
  supabase.storage.from = function () {
    return {
      upload: async (path, blob) => { steps.push(['upload', path, blob]); return { data: { path }, error: null }; },
      remove: async (paths) => {
        steps.push(['remove', ...paths]);
        return failRemove ? { data: null, error: { message: 'refused' } } : { data: null, error: null };
      },
      download: async () => ({ data: null, error: { message: 'not stubbed' } }),
    };
  };
  return { steps, refuseRemoves() { failRemove = true; }, restore() { supabase.storage.from = real; } };
}

test('my old messages are locked; hers, unsent and already-locked ones are left alone', async () => {
  const { a, b, ab, ba } = await twoPeople();
  const ids = { from: a.keyId, to: b.keyId };
  const lock = (content) => e2ee.seal(ab, content, ids);
  const bucket = watchBucket();
  try {
    const text = await plainRow({ body: 'hello from before' });
    const photoPath = `${crypto.randomUUID()}.jpg`;
    await local.putBlob(photoPath, new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }));
    const photo = await plainRow({ body: 'look', photo_path: photoPath });
    const hers = await plainRow({ owner_email: AANA, recipient_email: ME, body: 'hers' });
    const gone = await plainRow({ body: null, deleted_at: new Date().toISOString() });
    const already = await plainRow({ body: 'x', enc: { v: 1 } });
    const rows = [text, photo, hers, gone, already];

    assert.equal(await messagesModule.resealPast({ rows, ownerEmail: ME, lock }), 2);

    const t = await local.get('messages', text.id);
    assert.ok(t.enc && t.body !== 'hello from before', 'the server copy is ciphertext now');
    assert.equal((await e2ee.open(ba, t)).text, 'hello from before', 'and she can still read it');

    const p = await local.get('messages', photo.id);
    assert.match(p.photo_path, /\.bin$/, 'the file is an opaque object now');
    assert.equal((await e2ee.open(ba, p)).media, 'image/jpeg', 'its real type is inside');
    assert.deepEqual(bucket.steps.map((s) => s[0]), ['upload', 'remove'], 'the locked copy goes up before the readable one is deleted');
    assert.equal(bucket.steps[0][1], p.photo_path);
    assert.equal(bucket.steps[1][1], photoPath);
    assert.ok(!(await local.getBlob(photoPath)), 'no readable copy left on this phone either');

    assert.equal((await local.get('messages', hers.id)).enc, null, 'hers are hers to lock');
    assert.equal((await local.get('messages', gone.id)).body, null);

    const again = [t, p, hers, gone, already];
    assert.equal(await messagesModule.resealPast({ rows: again, ownerEmail: ME, lock }), 0, 'safe to run again');
  } finally {
    bucket.restore();
  }
});

test('if the readable file cannot be deleted, the message stays as it was and the locked copy is taken back', async () => {
  const { a, b, ab } = await twoPeople();
  const lock = (content) => e2ee.seal(ab, content, { from: a.keyId, to: b.keyId });
  const bucket = watchBucket();
  bucket.refuseRemoves();
  try {
    const photoPath = `${crypto.randomUUID()}.jpg`;
    await local.putBlob(photoPath, new Blob([new Uint8Array([9])], { type: 'image/jpeg' }));
    const row = await plainRow({ body: null, photo_path: photoPath });
    await assert.rejects(messagesModule.resealPast({ rows: [row], ownerEmail: ME, lock }), /refused/);
    const after = await local.get('messages', row.id);
    assert.equal(after.photo_path, photoPath);
    assert.equal(after.enc, null, 'tried again next time');
    const uploaded = bucket.steps[0][1];
    assert.ok(bucket.steps.some((s) => s[0] === 'remove' && s[1] === uploaded), 'the orphaned locked copy is removed');
  } finally {
    bucket.restore();
  }
});

test('once encryption is ready, Messages locks my earlier messages by itself', async () => {
  await reset();
  const page = statsPage();
  page.openChat();
  await readyChat(page, server, AANA);
  const row = await plainRow({ body: 'sent before it was on' });
  await Alpine.store('data').refreshCore();
  // Ready already started one run, on the rows it had then; a call while that
  // is going steps aside, so wait it out before asking again.
  while (page.chatResealing) await new Promise((r) => setTimeout(r, 5));
  await page.chatResealPast();
  const after = await local.get('messages', row.id);
  assert.ok(after.enc, 'locked');
  await page.chatUnlockPending();
  assert.equal(page.chatBody(after), 'sent before it was on', 'and still reads the same here');
  page.closeChat();
});

test('Messages is always mine, even while viewing her day', async () => {
  await reset();
  Alpine.store('ui').viewAs = AANA;
  try {
    const page = statsPage();
    assert.equal(page.email, AANA, 'the cards show her day');
    assert.equal(page.me, ME, 'Messages, photos and the PIN stay mine');
    page.openChat();
    await readyChat(page, server, AANA);
    page.chatText = 'still me';
    await page.sendChat();
    const sent = (await local.allRaw('messages')).filter((m) => m.recipient_email === AANA).at(-1);
    assert.equal(sent.owner_email, ME);
    assert.equal(page.chatPartner.email, AANA, 'talking to her, not to myself');
    page.closeChat();
  } finally {
    Alpine.store('ui').viewAs = '';
  }
});
