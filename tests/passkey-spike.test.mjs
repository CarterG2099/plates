/**
 * The encryption check page (docs/spike/passkey.html): does a phone's passkey
 * give back a stable secret? It runs on the phones themselves, so what can be
 * held here is what it must never do — talk to a server, keep the secret, or
 * skip the fingerprint — and that it asks the way a new phone would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../docs/spike/passkey.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));

test('the check page cannot send anything anywhere', () => {
  assert.match(html, /connect-src 'none';/);
  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|sendBeacon|supabase/);
});

test('every passkey use needs the fingerprint or Face ID', () => {
  const uses = script.match(/userVerification: '\w+'/g);
  assert.ok(uses.length >= 2);
  assert.ok(uses.every((u) => u === "userVerification: 'required'"));
  assert.match(script, /residentKey: 'required'/, 'a passkey a new phone can find on its own');
});

test('Check again asks for the passkey like a new phone would: no remembered credential', () => {
  assert.match(script, /allowCredentials: \[\],/);
  assert.match(script, /rpId: location\.hostname/);
});

// ---- the password-manager key (Bitwarden) ----------------------------------------

test('the key is 32 random bytes in a username + new-password pair, so a manager offers to save it', () => {
  assert.match(script, /newField\.value = b64url\(rand\(32\)\);/);
  assert.match(html, /<form id="pm-save"[\s\S]*?autocomplete="username" value="Plates chat key"[\s\S]*?id="pm-new" name="password" type="password" autocomplete="new-password"/);
  assert.match(html, /<form id="pm-restore"[\s\S]*?id="pm-fill" name="password" type="password" autocomplete="current-password"/);
  assert.doesNotMatch(html.match(/<form id="pm-save"[\s\S]*?<\/form>/)[0], /readonly/, 'managers skip read-only fields');
});

test('the key never leaves the page: forms do not really submit, and only the locked note is kept', () => {
  assert.match(html, /form-action 'none';/);
  const handlers = script.match(/getElementById\('pm-(save|restore)'\)\.onsubmit = async \(event\) => \{\s*event\.preventDefault\(\);/g);
  assert.equal(handlers?.length, 2);
  const stored = script.match(/localStorage\.setItem\(PM_STORE, JSON\.stringify\((\{[^}]+\})\)\)/)?.[1];
  assert.equal(stored, '{ iv: b64(iv), locked: b64(locked) }');
  assert.match(script, /field\.value = '';/, 'the filled key is cleared after use');
});

/** The page's own pmKey, run under Node's WebCrypto: the real function, not a copy. */
const pmKey = new Function(
  `${script.slice(script.indexOf('const PM_MIN_LENGTH'), script.indexOf('const newField'))} return pmKey;`,
)();

const lock = async (key, text) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, locked: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)) };
};

test('whatever the password manager saved is the key: iCloud\'s Strong Password works as well as ours', async () => {
  // Safari on iPhone puts its own 20-character password in a new-password field.
  // Read as our 43-character format that was 15 bytes, and the old check refused it.
  for (const saved of ['xyzAbc-defGhi-jklMn4', 'q3Jb0n8V0sA7hKkP2wQeX9zR1tYuIoPaSdFgHjKlZxC']) {
    const { iv, locked } = await lock(await pmKey(saved), 'hello');
    const again = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await pmKey(` ${saved} `), locked);
    assert.equal(new TextDecoder().decode(again), 'hello', `${saved.length} characters, filled back in`);
  }
});

test('a different saved key does not unlock the note', async () => {
  const { iv, locked } = await lock(await pmKey('xyzAbc-defGhi-jklMn4'), 'hello');
  await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await pmKey('xyzAbc-defGhi-jklMn5'), locked));
});

test('a fill too short to be a saved key is refused before it is used', async () => {
  await assert.rejects(pmKey('hunter2'), /7 characters; a saved one is at least 16/);
});

test('it asks the passkey for a secret, and keeps only the locked note, never the secret', () => {
  assert.match(script, /extensions: \{ prf: \{ eval: \{ first: SALT \} \} \}/);
  const stored = script.match(/localStorage\.setItem\(STORE, JSON\.stringify\((\{[^}]+\})\)\)/)?.[1];
  assert.equal(stored, '{ iv: b64(iv), locked: b64(locked) }');
  assert.match(script, /importKey\('raw', secret, 'HKDF', false/, 'the derived key cannot be exported');
});
