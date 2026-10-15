/**
 * Pairing a watch: the phone asks for a one-time code, the watch redeems it.
 *
 * pairing.ts is imported straight from supabase/functions, so this is the
 * source Deno runs. The function's database half is pinned by source, the same
 * way the other functions are — and was exercised live against the test account
 * when it shipped (a planted code redeemed to a session, then refused on reuse).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();

const p = await import('../supabase/functions/watch-pair/pairing.ts');
const watch = await import('../docs/js/watch.js');
const { supabase } = await import('../docs/js/supabase.js');

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// ---- codes ----------------------------------------------------------------------

test('a code is always eight digits, leading zeros kept', () => {
  assert.equal(p.newCode((b) => { b[0] = 42; return b; }), '00000042');
  for (let i = 0; i < 200; i++) assert.match(p.newCode(), /^\d{8}$/);
});

test('draws above the last whole multiple of 10^8 are thrown away, not wrapped', () => {
  // A plain modulo would turn the top of the 32-bit range into small codes,
  // making them likelier. The sampler must draw again instead.
  const limit = Math.floor(2 ** 32 / 1e8) * 1e8;
  const draws = [limit, 2 ** 32 - 1, 12345678];
  let calls = 0;
  const code = p.newCode((b) => { b[0] = draws[calls++]; return b; });
  assert.equal(calls, 3, 'both out-of-range draws were rejected');
  assert.equal(code, '12345678');
});

test('typed codes forgive spaces and dashes and nothing else', () => {
  assert.equal(p.normaliseCode('4815 1623'), '48151623');
  assert.equal(p.normaliseCode('4815-1623'), '48151623');
  assert.equal(p.normaliseCode(48151623), '48151623');
  assert.equal(p.normaliseCode('4815162'), null);
  assert.equal(p.normaliseCode('481516234'), null);
  assert.equal(p.normaliseCode('4815l623'), null);
  assert.equal(p.normaliseCode(null), null);
  assert.equal(p.normaliseCode({ code: '48151623' }), null);
});

test('the stored hash is plain SHA-256 hex, so a planted test code can be made by hand', async () => {
  const expected = createHash('sha256').update('48151623').digest('hex');
  assert.equal(await p.hashCode('48151623'), expected);
});

test('a code lives minutes, and few guesses are allowed', () => {
  assert.ok(p.TTL_MS <= 10 * 60_000);
  assert.ok(p.MAX_FAILURES <= 20);
});

// ---- the function ---------------------------------------------------------------

test('redeem burns live codes on a miss, and claims a match only once', async () => {
  const src = await source('../supabase/functions/watch-pair/index.ts');
  assert.match(src, /failed_attempts: p\.failed_attempts \+ 1/, 'a wrong guess counts against live codes');
  assert.match(src, /\.lt\("failed_attempts", MAX_FAILURES\)/, 'burned codes stop matching');
  assert.match(src, /\.gt\("expires_at", now\)/, 'expired codes stop matching');
  assert.match(src, /\.eq\("id", match\.id\)\.is\("used_at", null\)/, 'the claim is guarded against a race');
});

test('create needs a signed-in member and retires the old code', async () => {
  const src = await source('../supabase/functions/watch-pair/index.ts');
  assert.match(src, /auth\.getUser\(\)/);
  assert.match(src, /rpc\("is_member"\)/);
  assert.match(src, /\.eq\("owner_email", me\.email\)\.is\("used_at", null\)/);
  assert.doesNotMatch(src, /code: code,|code_hash: code\b/, 'only the hash is stored');
});

test('the pairing table is closed to the API', async () => {
  const schema = await source('../supabase/schema.sql');
  const block = schema.slice(schema.indexOf('create table if not exists plates.watch_pairings'));
  assert.match(block, /alter table plates\.watch_pairings enable row level security/);
  assert.match(block, /revoke all on plates\.watch_pairings from anon, authenticated/);
  assert.doesNotMatch(block, /create policy/, 'no policy: only the service role reads it');
});

// ---- the phone ------------------------------------------------------------------

test('the phone asks for a code with the create action', async () => {
  const real = supabase.functions.invoke;
  const calls = [];
  supabase.functions.invoke = async (name, options) => {
    calls.push({ name, body: options.body });
    return { data: { code: '00420042', expires_at: '2026-10-14T21:00:00Z' }, error: null };
  };
  try {
    const result = await watch.createPairing();
    assert.deepEqual(result, { code: '00420042', expiresAt: '2026-10-14T21:00:00Z' });
  } finally {
    supabase.functions.invoke = real;
  }
  assert.deepEqual(calls, [{ name: 'watch-pair', body: { action: 'create' } }]);
});

test('an error the function explains reaches the screen as that explanation', async () => {
  const real = supabase.functions.invoke;
  supabase.functions.invoke = async () => ({ data: { error: 'Not a Plates member.' }, error: null });
  try {
    await assert.rejects(() => watch.createPairing(), /Not a Plates member/);
  } finally {
    supabase.functions.invoke = real;
  }
});

test('the code is shown in two halves', () => {
  assert.equal(watch.formatCode('48151623'), '4815 1623');
  assert.equal(watch.formatCode(''), '');
});

test('settings has the pair row, and a reopened sheet never shows a stale code', async () => {
  const html = await source('../docs/index.html');
  assert.match(html, /@click="\$store\.ui\.pairWatch\(\)"/);
  assert.match(html, /x-text="\$store\.ui\.watchCodeText"/);

  const app = await source('../docs/js/app.js');
  const open = app.slice(app.indexOf('openSettings() {'), app.indexOf('openSettings() {') + 200);
  assert.match(open, /this\.watchCode = null/);

  const sw = await source('../docs/sw.js');
  assert.match(sw, /'\/js\/watch\.js'/, 'precached, or Settings breaks offline');
});
