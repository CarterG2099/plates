// webpush.ts — Web Push, from the specs, with no dependencies.
//
// RFC 8291 for the payload encryption (aes128gcm) and RFC 8292 for the VAPID
// authorization header. Both are short and entirely doable on WebCrypto, which
// is why there is no library here: the alternative was pulling an npm package
// into an Edge Function for ~120 lines of HKDF and one AES-GCM call.
//
// Kept in its own file so it can be exercised from Node without deploying —
// tests/webpush.test.mjs decrypts what this produces and checks it round-trips.

const enc = new TextEncoder();

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * HKDF as RFC 8291 uses it: one extract, then a single 0x01 expand block.
 * Every output here is =< 32 bytes, so the multi-block case never arises.
 */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const extractKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", extractKey, ikm));

  const expandKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const block = new Uint8Array(await crypto.subtle.sign("HMAC", expandKey, concat(info, Uint8Array.of(1))));
  return block.slice(0, length);
}

export interface PushSubscription {
  endpoint: string;
  p256dh: string;   // the browser's public key, base64url, uncompressed P-256 point
  auth: string;     // 16-byte shared auth secret, base64url
}

/**
 * Encrypt a payload for one subscription, producing an aes128gcm body.
 *
 * Layout is RFC 8188 §2.1: salt(16) | record size(4) | key id length(1) |
 * key id(65, our ephemeral public key) | ciphertext.
 */
export async function encryptPayload(sub: PushSubscription, payload: string) {
  const uaPublic = b64urlToBytes(sub.p256dh);
  const authSecret = b64urlToBytes(sub.auth);

  // A fresh ephemeral keypair per message — reusing one would let two messages
  // to the same subscriber share a key stream.
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256),
  );

  // RFC 8291 §3.4: the auth secret salts the ECDH output, and the info string
  // binds the result to both parties' public keys.
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 is the delimiter marking this as the final record.
  const plaintext = concat(enc.encode(payload), Uint8Array.of(2));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);

  return concat(salt, recordSize, Uint8Array.of(asPublic.length), asPublic, ciphertext);
}

/**
 * The `Authorization: vapid ...` header proving who is sending.
 *
 * `aud` is the push service's origin, not the endpoint — services reject a JWT
 * scoped to the full path.
 */
export async function vapidHeader(
  endpoint: string,
  { publicKey, privateKey, subject }: { publicKey: string; privateKey: string; subject: string },
) {
  const audience = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;

  // The private key is the raw 32-byte scalar, base64url — the `d` of a P-256
  // JWK. Rebuilt into a JWK here because WebCrypto will not import a bare scalar.
  const pub = b64urlToBytes(publicKey);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: privateKey,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)),
  );

  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${publicKey}`;
}

export interface SendResult {
  ok: boolean;
  status: number;
  /** 404/410 mean the browser threw the subscription away; stop using it. */
  gone: boolean;
}

export async function sendPush(
  sub: PushSubscription,
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttlSeconds = 3600,
): Promise<SendResult> {
  const body = await encryptPayload(sub, payload);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(ttlSeconds),
      "Authorization": await vapidHeader(sub.endpoint, vapid),
    },
    body,
  });

  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
