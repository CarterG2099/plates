/**
 * The looping exercise clips.
 *
 * They are Hevy's artwork, so they come from a members-only bucket and never
 * from the public repo. Everything that is not a clip — no file, no network,
 * reduced motion — has to come back as null so the sheet keeps its drawing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const { supabase } = await import('../docs/js/supabase.js');
const motion = await import('../docs/js/motion.js');

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** Stub the bucket: `clips` maps object path → bytes; anything else is missing. */
function stubBucket(clips) {
  const calls = [];
  const real = supabase.storage.from;
  supabase.storage.from = (bucket) => ({
    download: async (path) => {
      calls.push({ bucket, path });
      return path in clips
        ? { data: new Blob([clips[path]], { type: 'video/mp4' }), error: null }
        : { data: null, error: { message: 'Object not found' } };
    },
  });
  return { calls, restore: () => { supabase.storage.from = real; } };
}

test('a clip comes back as a playable object URL, from the private bucket, named by slug', async () => {
  const bucket = stubBucket({ 'seated-incline-curl-dumbbell.mp4': 'mp4 bytes' });
  try {
    const url = await motion.motionUrl('Seated Incline Curl (Dumbbell)');
    assert.match(url, /^blob:/);
    assert.deepEqual(bucket.calls, [{ bucket: 'plates-exercise-motion', path: 'seated-incline-curl-dumbbell.mp4' }]);
  } finally {
    bucket.restore();
  }
});

test('an exercise without a clip is null, and is asked about once a session', async () => {
  const bucket = stubBucket({});
  try {
    assert.equal(await motion.motionUrl('Zercher Squat'), null);
    assert.equal(await motion.motionUrl('Zercher Squat'), null);
    assert.equal(bucket.calls.length, 1);
  } finally {
    bucket.restore();
  }
});

test('a clip is downloaded once however often the sheet opens', async () => {
  const bucket = stubBucket({ 'face-pull.mp4': 'x' });
  try {
    const first = await motion.motionUrl('Face Pull');
    const second = await motion.motionUrl('Face Pull');
    assert.equal(first, second);
    assert.equal(bucket.calls.length, 1);
  } finally {
    bucket.restore();
  }
});

test('offline asks nothing and keeps the drawing, and does not remember a miss', async () => {
  const bucket = stubBucket({ 'shrug.mp4': 'x' });
  navigator.onLine = false;
  try {
    assert.equal(await motion.motionUrl('Shrug'), null);
    assert.equal(bucket.calls.length, 0);
  } finally {
    navigator.onLine = true;
  }
  try {
    assert.match(await motion.motionUrl('Shrug'), /^blob:/, 'back online, the clip loads');
  } finally {
    bucket.restore();
  }
});

test('reduced motion keeps the still drawing and asks nothing', async () => {
  const bucket = stubBucket({ 'lat-pulldown.mp4': 'x' });
  globalThis.matchMedia = (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
  try {
    assert.equal(await motion.motionUrl('Lat Pulldown'), null);
    assert.equal(bucket.calls.length, 0);
  } finally {
    delete globalThis.matchMedia;
    bucket.restore();
  }
});

test('a storage failure is null, not a thrown error in the sheet', async () => {
  const real = supabase.storage.from;
  supabase.storage.from = () => ({ download: async () => { throw new Error('boom'); } });
  try {
    assert.equal(await motion.motionUrl('Hip Thrust'), null);
  } finally {
    supabase.storage.from = real;
  }
});

test('the sheet shows the clip in the drawing\'s place, muted and looping', async () => {
  const html = await source('../docs/index.html');
  assert.match(html, /class="figure-pair" x-show="!detailMotion"/);
  // Mounted only while there is a clip: a merely hidden player kept decoding the
  // previous exercise's loop.
  assert.match(html, /<template x-if="detailMotion">\s*<video class="motion"/);
  const video = html.match(/<video class="motion"[^>]*>/s)?.[0] ?? '';
  for (const attr of [':src="detailMotion"', 'autoplay', 'muted', 'loop', 'playsinline']) {
    assert.ok(video.includes(attr), `video is missing ${attr}`);
  }
});

test('opening a sheet asks for its clip and drops a late answer for a closed one', async () => {
  const app = await source('../docs/js/app.js');
  assert.match(app, /motion\.motionUrl\(detail\.exercise\.name \|\| name\)/);
  // Not `this.detail === detail`: Alpine returns a reactive proxy, so identity
  // never holds and every clip was silently dropped. Caught in the browser.
  assert.match(app, /if \(this\.detail\?\.exerciseId === exerciseId\) this\.detailMotion = url;/);
  assert.doesNotMatch(app, /this\.detail === detail/);
});

test('the module is precached, like every other script the shell imports', async () => {
  assert.match(await source('../docs/sw.js'), /'\/js\/motion\.js',/);
});

test('the bucket is members-read and admin-write, never public', async () => {
  const sql = await source('../supabase/schema.sql');
  const block = sql.slice(sql.indexOf("values ('plates-exercise-motion'"));
  assert.match(block, /^values \('plates-exercise-motion', 'plates-exercise-motion', false,/);
  assert.match(block, /plates_motion_read[\s\S]*?plates\.is_member\(\)/);
  for (const op of ['insert', 'update', 'delete']) {
    assert.match(block, new RegExp(`plates_motion_${op}[\\s\\S]*?plates\\.is_admin\\(\\)`), `${op} must be admin-only`);
  }
});
