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

test('it asks the passkey for a secret, and keeps only the locked note, never the secret', () => {
  assert.match(script, /extensions: \{ prf: \{ eval: \{ first: SALT \} \} \}/);
  const stored = script.match(/localStorage\.setItem\(STORE, JSON\.stringify\((\{[^}]+\})\)\)/)?.[1];
  assert.equal(stored, '{ iv: b64(iv), locked: b64(locked) }');
  assert.match(script, /importKey\('raw', secret, 'HKDF', false/, 'the derived key cannot be exported');
});
