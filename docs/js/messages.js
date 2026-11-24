/**
 * messages.js — the private conversation behind the progress-photo PIN.
 *
 * Text is local-first like every other row: it lands in IndexedDB, renders at
 * once, and the outbox sends it when there is signal. A photo needs a
 * connection, the same rule as progress photos: the object is uploaded before
 * the row is written, so a message never points at nothing.
 *
 * While the conversation is open, Realtime hands over the other person's rows
 * the moment they land, instead of waiting up to a minute for the next pull.
 * The pull still runs, so a dropped socket only costs speed, not messages.
 *
 * "Read" is per device, kept in local meta: it only drives the unread dot,
 * and a second device showing a dot you already saw costs nothing.
 */

import { supabase } from './supabase.js';
import * as local from './local.js';
import * as sync from './sync.js';
import { downscale } from './progress.js';

export const BUCKET = 'plates-messages';
const READ_KEY = 'messages:read_at';

/**
 * Stamps as instants, not strings. The server hands back `+00:00` with
 * microseconds and this device writes `Z` with milliseconds; compared as text
 * the two orders disagree inside the same second.
 */
const at = (stamp) => Date.parse(stamp ?? '') || 0;

/**
 * Who this account can message, or undefined, in which case there is no
 * Messages button at all.
 *
 * Stricter than partnerOf(): that treats an unknown `sharing` as "any other
 * member", so a failed grants query or a membership cached before the flag
 * existed would hand Andra or the test account a conversation with someone.
 * Here only a confirmed grant from them counts, the same rule the database
 * holds sending to.
 */
export function partnerFor(members, email) {
  const me = String(email ?? '').toLowerCase();
  return (members ?? []).find((m) => m.email?.toLowerCase() !== me && m.sharing === true);
}

/** Live messages, oldest first, the way a conversation reads. */
export function thread(rows) {
  return (rows ?? [])
    .filter((m) => !m.deleted_at)
    .sort((a, b) => (at(a.sent_at) - at(b.sent_at)) || (a.id < b.id ? -1 : 1));
}

// ---- how the thread is laid out -------------------------------------------------

/** Messages from one person this close together tuck into one run of bubbles. */
export const GROUP_MS = 5 * 60_000;
/** A quiet hour this long gets a time marker even on the same day. */
export const GAP_MS = 60 * 60_000;

const localDay = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "Today", "Yesterday", or "Tue, Nov 4" — the marker on a new day. */
export function dayLabel(stamp, now = new Date()) {
  const d = new Date(stamp);
  if (localDay(d) === localDay(now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (localDay(d) === localDay(yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function clockLabel(stamp) {
  return new Date(stamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The thread as the screen draws it: a marker on each new day ("Today") and
 * after a quiet hour (the time), then the messages, each with its place in a
 * run — 'single', 'first', 'middle' or 'last' — which is what rounds the
 * corners where bubbles meet. A run is one person's messages, each within
 * GROUP_MS of the one before, and a marker always ends it.
 */
export function layout(rows, now = new Date()) {
  const msgs = thread(rows);
  const items = [];
  let prev = null;

  for (const m of msgs) {
    const t = at(m.sent_at);
    let marker = null;
    if (!prev || localDay(new Date(prev.t)) !== localDay(new Date(t))) marker = dayLabel(m.sent_at, now);
    else if (t - prev.t >= GAP_MS) marker = clockLabel(m.sent_at);
    if (marker) items.push({ key: `marker:${m.id}`, kind: 'marker', label: marker });

    const joins = !marker && prev && prev.owner === m.owner_email?.toLowerCase() && t - prev.t < GROUP_MS;
    const item = { key: m.id, kind: 'msg', m, place: 'single' };
    if (joins) {
      const before = items[items.length - 1];
      before.place = before.place === 'single' ? 'first' : 'middle';
      item.place = 'last';
    }
    items.push(item);
    prev = { t, owner: m.owner_email?.toLowerCase() };
  }
  return items;
}

// ---- reactions --------------------------------------------------------------------

/** The bar a long-press or a photo's viewer offers. Double-tap is always the first. */
export const REACTIONS = ['❤️', '🔥', '😍', '😘', '🥵', '😈', '😂', '👍'];

/**
 * Each person's current reaction to a message: the newest live row per person.
 * Two phones reacting offline can leave two rows for one person (see the
 * schema); only the newest counts.
 */
export function reactionsFor(reactions, messageId) {
  const newest = new Map();
  for (const r of reactions ?? []) {
    if (r.deleted_at || r.message_id !== messageId) continue;
    const who = r.owner_email?.toLowerCase();
    if (!newest.has(who) || at(r.updated_at) > at(newest.get(who).updated_at)) newest.set(who, r);
  }
  return [...newest.values()].sort((a, b) => at(a.updated_at) - at(b.updated_at));
}

/**
 * React, change your reaction, or — the same emoji again — take it back.
 * Your own rows only; stale duplicates from another phone are tombstoned too,
 * so taking a reaction back never leaves an older one showing.
 */
export async function react({ reactions, messageId, emoji, ownerEmail }) {
  const me = String(ownerEmail ?? '').toLowerCase();
  const mine = (reactions ?? []).filter((r) => !r.deleted_at && r.message_id === messageId
    && r.owner_email?.toLowerCase() === me)
    .sort((a, b) => at(b.updated_at) - at(a.updated_at));
  const [current, ...stale] = mine;
  const now = new Date().toISOString();

  for (const r of stale) await local.save('message_reactions', { ...r, deleted_at: now }, r.owner_email);

  let row;
  if (current?.emoji === emoji) {
    row = await local.save('message_reactions', { ...current, deleted_at: now }, current.owner_email);
  } else if (current) {
    row = await local.save('message_reactions', { ...current, emoji }, current.owner_email);
  } else {
    row = await local.save('message_reactions', { message_id: messageId, emoji }, ownerEmail);
  }
  sync.nudge();
  return row;
}

// ---- typing ---------------------------------------------------------------------

/** How long "typing…" stays up after the last keystroke signal. */
export const TYPING_MS = 5000;
/** Don't signal more often than this while someone keeps typing. */
const TYPING_EVERY_MS = 2500;

/**
 * Who a typing signal is from, without putting an email on the wire: the
 * channel is broadcast, so anything in it is readable by anyone who knows the
 * name. A short hash is enough to tell the two of you apart.
 */
export async function typingTag(email) {
  const bytes = new TextEncoder().encode(String(email ?? '').toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * "Typing…" both ways, while the conversation is open. Nothing is stored:
 * signals go over a Realtime broadcast and are forgotten. onChange(true) when
 * the other person starts, and false when they stop, send, or go quiet for
 * TYPING_MS. Returns { typing(), stopped(), close() } for this side.
 */
export function typingChannel({ myEmail, partnerEmail, onChange }) {
  let theirs = null;
  let mine = null;
  let lastSent = 0;
  let quiet = null;
  const ready = Promise.all([typingTag(myEmail), typingTag(partnerEmail)])
    .then(([m, t]) => { mine = m; theirs = t; });

  const set = (on) => {
    clearTimeout(quiet);
    if (on) quiet = setTimeout(() => onChange(false), TYPING_MS);
    onChange(on);
  };

  const channel = supabase.channel('plates-typing', { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'typing' }, ({ payload } = {}) => {
      if (theirs && payload?.from === theirs) set(Boolean(payload.on));
    })
    .subscribe();

  const send = async (on) => {
    await ready;
    Promise.resolve(channel.send?.({ type: 'broadcast', event: 'typing', payload: { from: mine, on } }))
      .catch(() => {});
  };

  return {
    typing() {
      const now = Date.now();
      if (now - lastSent < TYPING_EVERY_MS) return;
      lastSent = now;
      send(true);
    },
    stopped() {
      if (!lastSent) return;
      lastSent = 0;
      send(false);
    },
    close() {
      clearTimeout(quiet);
      if (lastSent) send(false);
      Promise.resolve(supabase.removeChannel?.(channel)).catch(() => {});
    },
  };
}

/** Messages to me that arrived after I last looked. My own never count. */
export function unreadCount(rows, email, readAt) {
  const me = String(email ?? '').toLowerCase();
  return (rows ?? []).filter((m) => !m.deleted_at
    && m.owner_email?.toLowerCase() !== me
    && at(m.sent_at) > at(readAt)).length;
}

export function readAt() {
  return local.getMeta(READ_KEY, null);
}

/** Marks everything up to the newest message as seen. */
export async function markRead(rows) {
  const newest = (rows ?? []).reduce((best, m) => (at(m.sent_at) > at(best) ? m.sent_at : best), null);
  if (newest && at(newest) > at(await readAt())) await local.setMeta(READ_KEY, newest);
  return local.getMeta(READ_KEY, null);
}

/**
 * `lock`, when the conversation is end-to-end encrypted, is e2ee.seal bound to
 * the pair key: given { text, file } it returns the ciphertext `body`, the
 * row's `enc`, and the locked file. Without it the message goes as before.
 */
export async function sendText({ text, ownerEmail, recipientEmail, lock = null }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('Nothing to send.');
  if (!recipientEmail) throw new Error('No one to send it to.');

  const sealed = lock ? await lock({ text: body, file: null }) : null;
  const row = await local.save('messages', {
    recipient_email: recipientEmail,
    body: sealed ? sealed.body : body,
    ...(sealed ? { enc: sealed.enc } : {}),
    photo_path: null,
    sent_at: new Date().toISOString(),
  }, ownerEmail);
  sync.nudge();
  return row;
}

/** A clip is told apart from a photo by its object's extension; the row has no type column. */
export function isVideo(path) {
  return /\.(mp4|webm)$/i.test(path ?? '');
}

/** The bucket refuses anything bigger (see the schema); saying so here is kinder than a 413. */
export const VIDEO_MAX_BYTES = 25 * 1024 * 1024;

/** Upload + row, split from sendPhoto so the ordering is testable without a canvas. */
export async function savePhotoMessage({ blob, text, ownerEmail, recipientEmail, ext = 'jpg', contentType = 'image/jpeg', lock = null }) {
  if (!recipientEmail) throw new Error('No one to send it to.');
  const caption = String(text ?? '').trim() || null;

  // Sealed, the object is ciphertext named .bin: the bucket learns neither
  // what kind of file it is nor anything in it. Its real type is inside.
  const sealed = lock ? await lock({ text: caption, file: blob }) : null;
  const photoPath = `${crypto.randomUUID()}.${sealed ? 'bin' : ext}`;
  const object = sealed ? sealed.file : blob;

  const { error } = await supabase.storage.from(BUCKET)
    .upload(photoPath, object, { contentType: sealed ? 'application/octet-stream' : contentType });
  if (error) throw new Error(error.message ?? String(error));

  const row = await local.save('messages', {
    recipient_email: recipientEmail,
    body: sealed ? sealed.body : caption,
    ...(sealed ? { enc: sealed.enc } : {}),
    photo_path: photoPath,
    sent_at: new Date().toISOString(),
  }, ownerEmail);
  // The cached copy is the locked one too; it is opened only to be shown.
  await local.putBlob(photoPath, object);

  sync.nudge();
  return row;
}

export async function sendPhoto({ file, text, ownerEmail, recipientEmail, lock = null }) {
  if (!file) throw new Error('No photo selected.');
  if (!navigator.onLine) throw new Error('Sending a photo needs a connection.');

  const blob = await downscale(file);
  return savePhotoMessage({ blob, text, ownerEmail, recipientEmail, lock });
}

/** A clip from the in-page camera. Sent as recorded: no re-encoding in the browser. */
export async function sendVideo({ blob, text, ownerEmail, recipientEmail, lock = null }) {
  if (!blob) throw new Error('No clip recorded.');
  if (!navigator.onLine) throw new Error('Sending a video needs a connection.');
  if (blob.size > VIDEO_MAX_BYTES) throw new Error('That clip is too big to send. Try a shorter one.');

  const contentType = String(blob.type || 'video/webm').split(';')[0];
  const ext = /mp4/i.test(contentType) ? 'mp4' : 'webm';
  return savePhotoMessage({ blob, text, ownerEmail, recipientEmail, ext, contentType, lock });
}

/** Cached blob if we have it, the bucket if not. */
export async function photoBlob(photoPath) {
  const cached = await local.getBlob(photoPath);
  if (cached) return cached;

  const { data, error } = await supabase.storage.from(BUCKET).download(photoPath);
  if (error) throw new Error(error.message ?? String(error));

  await local.putBlob(photoPath, data);
  return data;
}

/**
 * Gone for both of us. The text is cleared on the tombstone itself, so it does
 * not sit on the server after "unsend"; photo_path stays only so the object
 * can still be found and removed if the removal below fails.
 */
export async function unsend(message) {
  const existing = await local.get('messages', message.id);
  if (!existing) return null;

  const row = await local.save('messages', {
    ...existing, body: null, ...(existing.enc ? { enc: null } : {}), deleted_at: new Date().toISOString(),
  }, existing.owner_email);
  if (row.photo_path) await local.deleteBlob(row.photo_path);
  sync.nudge();

  // Best-effort, like removePhoto: the row is already unreadable, and the
  // bucket's read policy refuses a tombstoned message's photo anyway.
  if (row.photo_path) {
    Promise.resolve(supabase.storage.from(BUCKET).remove([row.photo_path])).catch(() => {});
  }
  return row;
}

/**
 * Drop cached photos of messages the other person unsent. Their tombstone
 * arrives through sync; without this the bytes would stay on this phone.
 */
export async function purgeUnsent() {
  const rows = await local.allRaw('messages');
  let purged = 0;
  for (const m of rows) {
    if (!m.deleted_at || !m.photo_path) continue;
    if (await local.getBlob(m.photo_path)) {
      await local.deleteBlob(m.photo_path);
      purged++;
    }
  }
  return purged;
}

/**
 * Live rows while the conversation is open. Each change goes through the same
 * last-write-wins put the pull uses, so a socket event and a pull carrying the
 * same row cannot fight. Returns the unsubscribe.
 */
export function listen(onChange) {
  const apply = (table) => async (payload) => {
    const row = payload?.new;
    if (!row?.id) return;
    const applied = await local.putManyLocalIfNewer(table, [row]);
    if (applied) onChange(row);
  };
  const channel = supabase.channel('plates-messages')
    .on('postgres_changes', { event: '*', schema: 'plates', table: 'messages' }, apply('messages'))
    .on('postgres_changes', { event: '*', schema: 'plates', table: 'message_reactions' }, apply('message_reactions'))
    .subscribe();

  return () => { Promise.resolve(supabase.removeChannel?.(channel)).catch(() => {}); };
}
