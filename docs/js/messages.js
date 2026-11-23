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

/** Live messages, oldest first, the way a conversation reads. */
export function thread(rows) {
  return (rows ?? [])
    .filter((m) => !m.deleted_at)
    .sort((a, b) => (at(a.sent_at) - at(b.sent_at)) || (a.id < b.id ? -1 : 1));
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

export async function sendText({ text, ownerEmail, recipientEmail }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('Nothing to send.');
  if (!recipientEmail) throw new Error('No one to send it to.');

  const row = await local.save('messages', {
    recipient_email: recipientEmail,
    body,
    photo_path: null,
    sent_at: new Date().toISOString(),
  }, ownerEmail);
  sync.nudge();
  return row;
}

/** Upload + row, split from sendPhoto so the ordering is testable without a canvas. */
export async function savePhotoMessage({ blob, text, ownerEmail, recipientEmail }) {
  if (!recipientEmail) throw new Error('No one to send it to.');
  const photoPath = `${crypto.randomUUID()}.jpg`;

  const { error } = await supabase.storage.from(BUCKET)
    .upload(photoPath, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message ?? String(error));

  const row = await local.save('messages', {
    recipient_email: recipientEmail,
    body: String(text ?? '').trim() || null,
    photo_path: photoPath,
    sent_at: new Date().toISOString(),
  }, ownerEmail);
  await local.putBlob(photoPath, blob);

  sync.nudge();
  return row;
}

export async function sendPhoto({ file, text, ownerEmail, recipientEmail }) {
  if (!file) throw new Error('No photo selected.');
  if (!navigator.onLine) throw new Error('Sending a photo needs a connection.');

  const blob = await downscale(file);
  return savePhotoMessage({ blob, text, ownerEmail, recipientEmail });
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
    ...existing, body: null, deleted_at: new Date().toISOString(),
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
  const channel = supabase.channel('plates-messages')
    .on('postgres_changes', { event: '*', schema: 'plates', table: 'messages' }, async (payload) => {
      const row = payload?.new;
      if (!row?.id) return;
      const applied = await local.putManyLocalIfNewer('messages', [row]);
      if (applied) onChange(row);
    })
    .subscribe();

  return () => { Promise.resolve(supabase.removeChannel?.(channel)).catch(() => {}); };
}
