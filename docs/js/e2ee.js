/**
 * e2ee.js — end-to-end encryption for Messages.
 *
 * Each person has an ECDH P-256 key pair. The public half is on the server for
 * the other person to use. The private half is on the server too, but only
 * locked with that person's **chat key**: the password of a "Plates chat key"
 * login that their password manager saves and fills back in on a new phone
 * (Bitwarden, iCloud Keychain, Google — whichever they use). Plates offers 32
 * random bytes, but Safari puts its own Strong Password in their place, so the
 * chat key is whatever was saved, stretched with PBKDF2 (tested on both phones
 * 2026-11-24). The server never sees it, so it can never open the private key.
 *
 * Both private keys meet the other's public key in ECDH and land on the same
 * shared secret, so one **pair key** opens everything between the two of you,
 * in both directions. Each message gets its own random key; that key is locked
 * with the pair key and stored on the row, and it locks the message's text and
 * its file. What the server keeps of a message is ciphertext, the locked
 * message key, and which two public keys were used. Not even whether a file is
 * a photo or a video: that is inside the ciphertext too.
 *
 * Unlocked private keys are kept on the phone as non-extractable CryptoKeys:
 * usable for ECDH, impossible to read back out, even by this code.
 */

import { db } from './supabase.js';
import * as local from './local.js';

export const KEY_LABEL = 'Plates chat key';
const PAIR_INFO = new TextEncoder().encode('plates chat pair v1');

const ME = 'e2ee:me';             // { email, keyId, publicKey } — this phone's own identity
const PRIVATE = 'e2ee:private';   // CryptoKey, non-extractable
const PARTNER = 'e2ee:partner';   // { email, keyId, publicKey, verified } — the key now in use
const PARTNER_KEYS = 'e2ee:partner-keys';  // { [keyId]: publicKey } — every key seen, so old messages still open

// ---- encoding -----------------------------------------------------------------------

export const b64 = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => unb64(String(s).trim().replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).trim().length + 3) % 4));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---- the chat key ---------------------------------------------------------------------

/** A fresh chat key: 32 random bytes as 43 URL-safe characters, for the password manager. */
export function newChatKey() {
  return b64url(rand(32));
}

/** Shorter than any generated password: a typo or a partial fill, refused rather than stretched. */
export const MIN_CHAT_KEY = 16;

/**
 * The AES key that locks the private key, from the chat key's text. PBKDF2 at
 * 600,000 rounds: the text is a generated password (ours, or the manager's own),
 * and the rounds cost a guesser far more than they cost one unlock on a phone.
 */
export async function chatKeyFrom(text) {
  const secret = String(text ?? '').trim();
  if (secret.length < MIN_CHAT_KEY) {
    throw new Error('That isn’t a whole Plates chat key. Let your password manager fill it in.');
  }
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('plates chat key v1'), iterations: 600_000 },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

// ---- identity -------------------------------------------------------------------------

/** A short id for a public key: what a message records, and what a change is noticed by. */
export async function keyId(publicKey) {
  return hex(await crypto.subtle.digest('SHA-256', unb64(publicKey))).slice(0, 16);
}

/**
 * A new key pair, its private half locked with the chat key. Returns what goes
 * to the server (public key, locked private key) and the private key itself,
 * re-imported non-extractable for this phone to keep.
 */
export async function createIdentity(chatKeyText) {
  const wrapKey = await chatKeyFrom(chatKeyText);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const iv = rand(12);
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, pkcs8);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { publicKey, keyId: await keyId(publicKey), wrapped: b64(wrapped), iv: b64(iv), privateKey };
}

/** Open a locked private key with the chat key. A wrong key fails here, not later. */
export async function unlockIdentity({ wrapped, iv }, chatKeyText) {
  const wrapKey = await chatKeyFrom(chatKeyText);
  let pkcs8;
  try {
    pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, wrapKey, unb64(wrapped));
  } catch {
    throw new Error('That chat key doesn’t match. Make sure your password manager filled the newest “Plates chat key”.');
  }
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

// ---- the pair key ---------------------------------------------------------------------

/** The key both of you derive: my private key with your public one equals yours with mine. */
export async function pairKey(myPrivate, theirPublic) {
  const theirs = await crypto.subtle.importKey('raw', unb64(theirPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, myPrivate, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: PAIR_INFO },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

// ---- sealing and opening a message ---------------------------------------------------

/**
 * Lock a message for the two of you. `content` is { text, file } where file is
 * a Blob or null. Returns the row's `body` (ciphertext) and `enc`, and the
 * locked file to upload, if any.
 */
export async function seal(pair, { text = null, file = null }, { from, to }) {
  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const kiv = rand(12);
  const lockedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: kiv }, pair, await crypto.subtle.exportKey('raw', messageKey));

  const meta = JSON.stringify({ t: text || null, m: file ? (file.type || 'application/octet-stream') : null });
  const iv = rand(12);
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, messageKey, new TextEncoder().encode(meta));

  let locked = null;
  let fiv = null;
  if (file) {
    fiv = rand(12);
    const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fiv }, messageKey, await file.arrayBuffer());
    locked = new Blob([bytes], { type: 'application/octet-stream' });
  }

  return {
    body: b64(body),
    enc: { v: 1, from, to, k: b64(lockedKey), kiv: b64(kiv), iv: b64(iv), ...(fiv ? { fiv: b64(fiv) } : {}) },
    file: locked,
  };
}

async function messageKeyFor(pair, enc) {
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(enc.kiv) }, pair, unb64(enc.k));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

/** The text and the file's type of a sealed row: { text, media }. */
export async function open(pair, row) {
  const key = await messageKeyFor(pair, row.enc);
  const meta = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.enc.iv) }, key, unb64(row.body));
  const { t, m } = JSON.parse(new TextDecoder().decode(meta));
  return { text: t ?? null, media: m ?? null };
}

/** A sealed row's file, unlocked, as a Blob of its real type. */
export async function openFile(pair, row, lockedBlob, media) {
  const key = await messageKeyFor(pair, row.enc);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.enc.fiv) }, key, await lockedBlob.arrayBuffer());
  return new Blob([bytes], { type: media || 'application/octet-stream' });
}

// ---- the safety code -------------------------------------------------------------------

/**
 * Twelve digits from both public keys, the same on both phones whichever way
 * round. If they match when compared in person, nobody — the server included —
 * has put their own key between you.
 */
export async function safetyCode(publicA, publicB) {
  const [x, y] = [publicA, publicB].sort();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${x}|${y}`)));
  let digits = '';
  for (let i = 0; digits.length < 12; i += 2) digits += String(((digest[i] << 8) | digest[i + 1]) % 1000).padStart(3, '0');
  return digits.slice(0, 12).match(/.{4}/g).join(' ');
}

// ---- this phone's keys -----------------------------------------------------------------

export async function savedIdentity() {
  const [me, privateKey] = await Promise.all([local.getMeta(ME, null), local.getMeta(PRIVATE, null)]);
  return me && privateKey ? { ...me, privateKey } : null;
}

export async function keepIdentity(email, { keyId: id, publicKey, privateKey }) {
  await local.setMeta(PRIVATE, privateKey);
  await local.setMeta(ME, { email, keyId: id, publicKey });
}

export async function forgetIdentity() {
  await local.setMeta(PRIVATE, null);
  await local.setMeta(ME, null);
}

export function savedPartner() {
  return local.getMeta(PARTNER, null);
}

/**
 * Remember the other person's current key, and every key of theirs ever seen
 * so older messages still open. Returns whether it changed from the one before
 * — the cue for the safety-code warning.
 */
export async function keepPartner(email, { keyId: id, publicKey }) {
  const before = await local.getMeta(PARTNER, null);
  const changed = Boolean(before && before.email === email && before.keyId !== id);
  const verified = !changed && before?.keyId === id ? Boolean(before.verified) : false;
  await local.setMeta(PARTNER, { email, keyId: id, publicKey, verified });
  const all = await local.getMeta(PARTNER_KEYS, {});
  await local.setMeta(PARTNER_KEYS, { ...all, [id]: publicKey });
  return changed;
}

export async function markVerified() {
  const p = await local.getMeta(PARTNER, null);
  if (p) await local.setMeta(PARTNER, { ...p, verified: true });
}

/** The other person's public key with this id, from any seen. */
export async function partnerKey(id) {
  return (await local.getMeta(PARTNER_KEYS, {}))[id] ?? null;
}

// ---- the server -----------------------------------------------------------------------

/** Public keys for these people: { [email]: { keyId, publicKey } }. */
export async function fetchPublicKeys(emails) {
  const { data, error } = await db('chat_keys').select('owner_email, key_id, public_key').in('owner_email', emails);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.owner_email.toLowerCase(), { keyId: r.key_id, publicKey: r.public_key }]));
}

/** My locked private key, or null if I have never set up. */
export async function fetchVault(email) {
  const { data, error } = await db('chat_key_vault').select('key_id, wrapped_private, wrap_iv')
    .eq('owner_email', email).maybeSingle();
  if (error) throw error;
  return data ? { keyId: data.key_id, wrapped: data.wrapped_private, iv: data.wrap_iv } : null;
}

/** Put a new identity on the server: the public key for the other person, the locked private key for me. */
export async function publish(email, identity) {
  const now = new Date().toISOString();
  const vault = await db('chat_key_vault').upsert({
    owner_email: email, key_id: identity.keyId, wrapped_private: identity.wrapped, wrap_iv: identity.iv, updated_at: now,
  });
  if (vault.error) throw vault.error;
  const pub = await db('chat_keys').upsert({
    owner_email: email, key_id: identity.keyId, public_key: identity.publicKey, updated_at: now,
  });
  if (pub.error) throw pub.error;
}
