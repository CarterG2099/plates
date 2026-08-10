/**
 * The Web Push encryption in the notify-idle-workouts function.
 *
 * This is hand-rolled RFC 8291, so it gets checked from the other side: build a
 * subscription the way a browser would, encrypt a payload with the real code,
 * then decrypt it here as the push service's client would and compare. Crypto
 * that is merely "written carefully" is crypto that silently produces garbage a
 * push service rejects with an opaque 400.
 *
 * The Deno module runs unmodified — it uses only WebCrypto and TextEncoder,
 * both of which Node has as globals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Strip the TypeScript. The file is types-in-signatures only, no TS runtime
// features, so this is enough to import it — and it keeps the function itself
// written in the TS the rest of supabase/functions uses.
const src = readFileSync(new URL('../supabase/functions/notify-idle-workouts/webpush.ts', import.meta.url), 'utf8')
  .replace(/^export interface [\s\S]*?^}/gm, '')
  .replace(/: JsonWebKey/g, '')
  .replace(/: Promise<SendResult>/g, '')
  .replace(/\): SendResult/g, ')')
  .replace(/sub: PushSubscription/g, 'sub')
  .replace(/\(s: string\)/g, '(s)')
  .replace(/\(b: Uint8Array\)/g, '(b)')
  .replace(/\(\.\.\.parts: Uint8Array\[\]\)/g, '(...parts)')
  .replace(/salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number/g, 'salt, ikm, info, length')
  .replace(/payload: string/g, 'payload')
  .replace(/endpoint: string,\n/g, 'endpoint,\n')
  .replace(/\{ publicKey, privateKey, subject \}: \{[^}]*\}/g, '{ publicKey, privateKey, subject }')
  .replace(/vapid: \{[^}]*\},/g, 'vapid,')
  .replace(/ttlSeconds = 3600,\n\)[^{]*\{/g, 'ttlSeconds = 3600,\n) {')
  .replace(/: string(?=[,)\s])/g, '')
  .replace(/: Uint8Array(?=[,)\s])/g, '')
  .replace(/: number(?=[,)\s])/g, '');

const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const { encryptPayload, vapidHeader, b64urlToBytes, bytesToB64url } = mod;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A subscription shaped exactly like the one a browser hands you. */
async function fakeSubscription() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    private: kp.privateKey,
    sub: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: b64url(raw),
      auth: b64url(auth),
    },
    uaPublic: raw,
    authSecret: auth,
  };
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const ek = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', ek, ikm));
  const xk = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const block = new Uint8Array(await crypto.subtle.sign('HMAC', xk, concat(info, Uint8Array.of(1))));
  return block.slice(0, length);
}

/** The receiving half of RFC 8291, written independently of the sender. */
async function decrypt(body, receiver) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);

  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, receiver.private, 256),
  );

  const keyInfo = concat(new TextEncoder().encode('WebPush: info\0'), receiver.uaPublic, asPublic);
  const ikm = await hkdf(receiver.authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ciphertext),
  );

  assert.equal(plain[plain.length - 1], 2, 'last record must carry the 0x02 delimiter');
  return new TextDecoder().decode(plain.slice(0, -1));
}

test('an encrypted payload decrypts back to exactly what went in', async () => {
  const receiver = await fakeSubscription();
  const message = JSON.stringify({ title: 'Still training?', body: 'Ab Wheel Rollout · 24 min' });

  const body = await encryptPayload(receiver.sub, message);
  assert.equal(await decrypt(body, receiver), message);
});

test('the body is laid out as RFC 8188 expects', async () => {
  const receiver = await fakeSubscription();
  const body = await encryptPayload(receiver.sub, 'hi');

  // salt(0..15) | record size(16..19) | key id length(20) | key id(21..85)
  assert.equal(body[20], 65, 'key id length is an uncompressed P-256 point');
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096, 'record size');
  assert.equal(body[21], 0x04, 'the ephemeral key is uncompressed');
  // salt(16) + rs(4) + idlen(1) + key(65) + plaintext(2+1) + GCM tag(16)
  assert.equal(body.length, 16 + 4 + 1 + 65 + 3 + 16);
});

test('every message uses a fresh salt and ephemeral key', async () => {
  const receiver = await fakeSubscription();
  const a = await encryptPayload(receiver.sub, 'same');
  const b = await encryptPayload(receiver.sub, 'same');

  assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16), 'salt must differ');
  assert.notDeepEqual(a.slice(21, 86), b.slice(21, 86), 'ephemeral key must differ');
  assert.notDeepEqual(a.slice(86), b.slice(86), 'and so the ciphertext differs');
});

test('a payload at the far end of what we send still round-trips', async () => {
  const receiver = await fakeSubscription();
  const long = 'x'.repeat(2000);
  assert.equal(await decrypt(await encryptPayload(receiver.sub, long), receiver), long);
});

test('the wrong subscriber cannot read it', async () => {
  const intended = await fakeSubscription();
  const other = await fakeSubscription();
  const body = await encryptPayload(intended.sub, 'secret');

  await assert.rejects(() => decrypt(body, other));
});

// ---- VAPID -------------------------------------------------------------------

/** A keypair in the shape the function's secrets hold: raw public, scalar private. */
async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64url(pub), privateKey: jwk.d, verify: kp.publicKey };
}

test('the VAPID header is a signature the push service can verify', async () => {
  const keys = await vapidKeys();
  const header = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', {
    publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:me@example.com',
  });

  const [, t, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey, 'the key the service checks against is included');

  const [h, c, sig] = t.split('.');
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.verify,
    b64urlToBytes(sig),
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert.equal(ok, true, 'signature must verify against the advertised public key');
});

test('the JWT audience is the origin, not the whole endpoint', async () => {
  // Push services reject a token scoped to the full path.
  const keys = await vapidKeys();
  const header = await vapidHeader('https://updates.push.services.mozilla.com/wpush/v2/gAAA...', {
    publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:me@example.com',
  });
  const claims = JSON.parse(Buffer.from(header.split('.')[1], 'base64url').toString());

  assert.equal(claims.aud, 'https://updates.push.services.mozilla.com');
  assert.equal(claims.sub, 'mailto:me@example.com');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'not already expired');
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 12 * 60 * 60 + 5, 'and within the 12h cap');
});

test('base64url helpers round-trip bytes that need padding and substitution', () => {
  for (const len of [1, 2, 3, 16, 32, 65]) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    assert.deepEqual(b64urlToBytes(bytesToB64url(bytes)), bytes);
  }
  assert.match(bytesToB64url(Uint8Array.of(251, 255, 190)), /^[A-Za-z0-9_-]+$/);
});
