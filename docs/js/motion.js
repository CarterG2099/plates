/**
 * motion.js — the moving demonstration of an exercise, when there is one.
 *
 * The clips are short loops cut from Hevy's own exercise animations. They are
 * Hevy's artwork, so they live in a members-only storage bucket rather than in
 * docs/img with the drawings: this repo is public and the bucket is not.
 *
 * Named like the drawings — `<artSlug(name)>.mp4` — so adding one is an upload
 * and nothing else. No clip, no connection, or reduced motion all come back as
 * null, and the sheet keeps the drawing it already shows.
 */

import { supabase } from './supabase.js';
import { artSlug } from './muscle-map.js';

export const BUCKET = 'plates-exercise-motion';

// slug → Promise<object URL | null>. Misses are remembered too: an exercise
// without a clip should cost one request a session, not one per opening.
const cache = new Map();

/** The clip for an exercise as a playable URL, or null. */
export function motionUrl(name) {
  const slug = artSlug(name);
  if (!slug) return Promise.resolve(null);
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return Promise.resolve(null);
  if (!navigator.onLine) return Promise.resolve(null);

  if (!cache.has(slug)) {
    const pending = Promise.resolve(supabase.storage.from(BUCKET).download(`${slug}.mp4`))
      .then(({ data, error }) => (error || !data ? null : URL.createObjectURL(data)))
      .catch(() => null)
      .then((url) => {
        // A failure that might be the network rather than a missing clip is
        // not worth remembering; only a definite answer stays cached.
        if (url === null && !navigator.onLine) cache.delete(slug);
        return url;
      });
    cache.set(slug, pending);
  }
  return cache.get(slug);
}
