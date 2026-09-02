/**
 * progress.js — locked progress photos.
 *
 * The photos live in a private Supabase Storage bucket; the rows describing
 * them sync through the normal local-first machinery like any other table.
 * Blobs are cached in IndexedDB after the first download, so browsing is
 * instant and works offline — only adding a photo needs a connection, the
 * same rule the food-photo reader already follows.
 *
 * The PIN is a privacy curtain, not cryptography. It stops someone holding an
 * unlocked phone from browsing the section; it does not protect the bytes —
 * that is RLS's job, and a four-digit hash is brute-forceable by anyone who
 * can read it anyway. Hashed rather than stored plain only so a shoulder-surfed
 * database row doesn't read out loud.
 */

import { supabase } from './supabase.js';
import * as local from './local.js';
import * as sync from './sync.js';

export const BUCKET = 'plates-progress';
export const POSES = ['front', 'side', 'back'];

// Enough pixels for a full-screen phone view; ~300KB as JPEG. A raw camera
// photo is several megabytes and 12MP of detail nobody zooms into.
const MAX_EDGE = 1600;
const QUALITY = 0.85;

/** Salted with the email so the two of us with the same PIN store different hashes. */
export async function hashPin(email, pin) {
  const bytes = new TextEncoder().encode(`${String(email ?? '').toLowerCase()}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One submit of the PIN pad, as a pure step so the flow is testable.
 *
 * Returns the next state: `{ stage, first?, error?, unlocked?, save? }` —
 * `save` carries a confirmed new PIN the caller must persist, `unlocked` means
 * the entered PIN matched the stored hash.
 *
 * Confirm is checked before the no-stored-hash case: while a new PIN is being
 * set there is still no stored hash, so a hash-first check loops back into
 * "set" forever and the flow can never get past "enter it again to confirm".
 * That was shipped, once.
 */
export async function pinStep({ pin, stage, storedHash, first, email }) {
  if (!/^\d{4}$/.test(pin)) return { stage, error: 'Four digits.' };

  if (stage === 'confirm') {
    if (pin !== first) {
      return { stage: storedHash ? 'enter' : 'set', error: 'Those didn’t match — start over.' };
    }
    return { stage: 'enter', save: pin };
  }

  if (!storedHash || stage === 'set') return { stage: 'confirm', first: pin };

  if (await hashPin(email, pin) === storedHash) return { stage: 'enter', unlocked: true };
  return { stage, error: 'Wrong PIN.' };
}

/** Live rows, newest day first. */
export function photosFor(rows, pose = 'all') {
  return (rows ?? [])
    .filter((p) => !p.deleted_at && (pose === 'all' || p.pose === pose))
    .sort((a, b) => (a.taken_on === b.taken_on
      ? (a.updated_at < b.updated_at ? 1 : -1)
      : (a.taken_on < b.taken_on ? 1 : -1)));
}

/**
 * The logged weight nearest to when the photo was taken, for the compare view.
 * A photo without a weigh-in nearby gets nothing rather than a stale number —
 * seven days is already a stretch for "what I weighed in this picture".
 */
export function nearestWeight(weightLog, ownerEmail, takenOn, windowDays = 7) {
  const target = new Date(`${takenOn}T12:00:00`).getTime();
  const window = windowDays * 86_400_000;

  let best = null;
  for (const w of weightLog ?? []) {
    if (w.owner_email !== ownerEmail || w.deleted_at) continue;
    const lb = Number(w.weight_lb);
    if (!Number.isFinite(lb)) continue;
    const gap = Math.abs(new Date(w.measured_at).getTime() - target);
    if (gap <= window && (!best || gap < best.gap)) best = { lb, gap };
  }
  return best ? best.lb : null;
}

/** Downscale + upload + row. Split from addPhoto so the row logic is testable. */
export async function savePhoto({ blob, takenOn, pose, note, ownerEmail }) {
  const objectPath = `${crypto.randomUUID()}.jpg`;

  const { error } = await supabase.storage.from(BUCKET)
    .upload(objectPath, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message ?? String(error));

  // The row is written only after the upload succeeds, so a row never points at
  // an object that isn't there. The blob is cached immediately so the grid can
  // render this photo without ever re-downloading it.
  const row = await local.save('progress_photos', {
    taken_on: takenOn,
    pose: pose || null,
    note: note || null,
    object_path: objectPath,
  }, ownerEmail);
  await local.putBlob(objectPath, blob);

  sync.nudge();
  return row;
}

export async function addPhoto({ file, takenOn, pose, note, ownerEmail }) {
  if (!file) throw new Error('No photo selected.');
  if (!navigator.onLine) throw new Error('Saving a photo needs a connection.');

  const blob = await downscale(file);
  return savePhoto({ blob, takenOn, pose, note, ownerEmail });
}

/** Cached blob if we have it, the bucket if not. */
export async function photoBlob(objectPath) {
  const cached = await local.getBlob(objectPath);
  if (cached) return cached;

  const { data, error } = await supabase.storage.from(BUCKET).download(objectPath);
  if (error) throw new Error(error.message ?? String(error));

  await local.putBlob(objectPath, data);
  return data;
}

export async function removePhoto(photo) {
  const row = await local.remove('progress_photos', photo.id);
  await local.deleteBlob(photo.object_path);
  sync.nudge();

  // Best-effort: an orphaned object in the bucket costs nothing and is
  // invisible; blocking the delete on the network would cost the row.
  Promise.resolve(supabase.storage.from(BUCKET).remove([photo.object_path])).catch(() => {});
  return row;
}

async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read the photo.'))),
      'image/jpeg', QUALITY);
  });
}
