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

test('a key that is not exactly 32 bytes is refused before it is used', () => {
  assert.match(script, /if \(raw\.length !== 32\) throw/);
});

test('it asks the passkey for a secret, and keeps only the locked note, never the secret', () => {
  assert.match(script, /extensions: \{ prf: \{ eval: \{ first: SALT \} \} \}/);
  const stored = script.match(/localStorage\.setItem\(STORE, JSON\.stringify\((\{[^}]+\})\)\)/)?.[1];
  assert.equal(stored, '{ iv: b64(iv), locked: b64(locked) }');
  assert.match(script, /importKey\('raw', secret, 'HKDF', false/, 'the derived key cannot be exported');
});
