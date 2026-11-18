/**
 * Progress photos from the camera inside the app: one tap of the shutter saves
 * the photo, and a photo of you both shows in both timelines.
 *
 * The camera is a stand-in — a stream whose tracks remember being stopped —
 * but the code driving it is the real Stats screen in app.js, and the save
 * goes through the real progress.js into IndexedDB and the stub bucket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const camera = await import('../docs/js/camera.js');
const progress = await import('../docs/js/progress.js');
const local = await import('../docs/js/local.js');
const { supabase } = await import('../docs/js/supabase.js');

const ME = 'cgividen20@gmail.com';
const AANA = 'aanabraithwaite@gmail.com';

// addPhoto downscales through a canvas; these give it one that produces a blob.
globalThis.createImageBitmap = async () => ({ width: 3000, height: 4000, close() {} });
const canvas = () => ({
  width: 0, height: 0,
  getContext: () => ({ drawImage() {} }),
  toBlob: (done) => done(new Blob(['jpeg'], { type: 'image/jpeg' })),
});
document.createElement = canvas;

/** A camera stand-in: what was asked for, and whether its light went off. */
function fakeCamera({ refuse = null } = {}) {
  const asked = [];
  const tracks = [];
  navigator.mediaDevices = {
    getUserMedia: async (c) => {
      if (refuse) throw Object.assign(new Error('no'), { name: refuse });
      asked.push(c);
      const track = { stopped: false, stop() { this.stopped = true; } };
      tracks.push(track);
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    },
  };
  return { asked, tracks };
}

function statsPage() {
  Alpine.store('auth').session = { user: { email: ME } };
  Alpine.store('auth').members = [{ email: ME, sharing: true }, { email: AANA, sharing: true, display_name: 'Aana' }];
  const page = Alpine.reactive(components.statsPage());
  // The viewfinder: a video element the canvas fallback can read a frame from.
  page.$refs = { viewfinder: { videoWidth: 1080, videoHeight: 1920, play: async () => {} } };
  page.$nextTick = async () => {};
  return page;
}

// ---- the module ---------------------------------------------------------------

test('it asks for the biggest picture the camera has, without sound', () => {
  assert.deepEqual(camera.constraints('environment'), {
    audio: false,
    video: { facingMode: 'environment', width: { ideal: 4096 }, height: { ideal: 4096 } },
  });
});

test('the pose moves on after each shot and stays on the last', () => {
  assert.equal(camera.nextPose('front', progress.POSES), 'side');
  assert.equal(camera.nextPose('side', progress.POSES), 'back');
  assert.equal(camera.nextPose('back', progress.POSES), 'back');
});

test('a refused or missing camera says what to do', () => {
  assert.match(camera.problem({ name: 'NotAllowedError' }), /Allow it in the browser settings/);
  assert.match(camera.problem({ name: 'NotFoundError' }), /No camera found/);
  assert.match(camera.problem({ name: 'Other' }), /phone camera/);
});

test('a still comes from the camera itself where the browser can take one', async () => {
  const photo = new Blob(['full-res']);
  globalThis.ImageCapture = class { takePhoto() { return Promise.resolve(photo); } };
  try {
    const track = {};
    assert.equal(await camera.still({ getVideoTracks: () => [track] }, {}), photo);
  } finally {
    delete globalThis.ImageCapture;
  }
});

test('otherwise, or if the camera refuses a still, it is the frame on screen', async () => {
  globalThis.ImageCapture = class { takePhoto() { return Promise.reject(new Error('busy')); } };
  try {
    const blob = await camera.still({ getVideoTracks: () => [{}] }, { videoWidth: 1080, videoHeight: 1920 });
    assert.equal(blob.type, 'image/jpeg');
  } finally {
    delete globalThis.ImageCapture;
  }
});

// ---- whose timeline ---------------------------------------------------------------

test('a photo of you both is in both timelines; a solo one only in its owner\'s', () => {
  assert.equal(progress.inTimeline({ owner_email: AANA, together: true }, ME), true);
  assert.equal(progress.inTimeline({ owner_email: AANA, together: false }, ME), false);
  assert.equal(progress.inTimeline({ owner_email: 'CGividen20@gmail.com' }, ME), true);
});

test('Mine and Aana both show the together photo, whichever phone took it', async () => {
  const page = statsPage();
  const together = await local.save('progress_photos', { taken_on: '2026-11-17', pose: 'front', object_path: 't.jpg', together: true }, AANA);
  const hers = await local.save('progress_photos', { taken_on: '2026-11-16', pose: 'front', object_path: 'h.jpg', together: false }, AANA);
  const mine = await local.save('progress_photos', { taken_on: '2026-11-15', pose: 'front', object_path: 'm.jpg', together: false }, ME);
  await Alpine.store('data').refresh();

  page.ownerFilter = 'mine';
  const ids = page.photos.map((p) => p.id);
  assert.ok(ids.includes(together.id) && ids.includes(mine.id) && !ids.includes(hers.id));

  page.ownerFilter = 'partner';
  const theirs = page.photos.map((p) => p.id);
  assert.ok(theirs.includes(together.id) && theirs.includes(hers.id) && !theirs.includes(mine.id));
});

test('under a photo of you both, the weight is the timeline\'s owner\'s', async () => {
  const page = statsPage();
  await local.save('weight_log', { measured_at: '2026-11-17T12:00:00.000Z', weight_lb: 181 }, ME);
  await local.save('weight_log', { measured_at: '2026-11-17T12:00:00.000Z', weight_lb: 132 }, AANA);
  await Alpine.store('data').refresh();
  const photo = { owner_email: AANA, together: true, taken_on: '2026-11-17' };

  page.ownerFilter = 'mine';
  const mineWeight = page.photoWeight(photo);
  page.ownerFilter = 'partner';
  const herWeight = page.photoWeight(photo);
  assert.equal(mineWeight, 181);
  assert.equal(herWeight, 132);
  assert.equal(page.photoWeight({ ...photo, together: false }), herWeight, 'a solo photo: its owner\'s');
});

test('a photo saved together says so on its row', async () => {
  const row = await progress.savePhoto({ blob: new Blob(['x']), takenOn: '2026-11-18', pose: 'front', note: '', together: true, ownerEmail: ME });
  assert.equal(row.together, true);
  const solo = await progress.savePhoto({ blob: new Blob(['x']), takenOn: '2026-11-18', pose: 'side', note: '', ownerEmail: ME });
  assert.equal(solo.together, false);
});

// ---- the camera screen ------------------------------------------------------------

test('Take photo opens the back camera on front, timer off', async () => {
  const cam = fakeCamera();
  const page = statsPage();
  await page.openCamera();
  assert.deepEqual({ ...page.camera }, { facing: 'environment', pose: 'front', together: false, timer: 0, countdown: 0 });
  assert.equal(cam.asked[0].video.facingMode, 'environment');
  assert.equal(page.cameraError, '');
  page.closeCamera();
});

test('one tap saves the photo as today\'s, with the lit pose, and moves to the next pose', async () => {
  fakeCamera();
  const page = statsPage();
  await page.openCamera();
  page.camera.together = true;
  const before = supabase.storage._uploads.length;

  await page.shutter();
  assert.equal(supabase.storage._uploads.length, before + 1, 'uploaded');
  assert.equal(page.camera.pose, 'side', 'ready for the next one');
  assert.equal(page.cameraSaving, 0);

  const rows = (await local.all('progress_photos')).filter((p) => p.object_path === supabase.storage._uploads.at(-1).path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pose, 'front');
  assert.equal(rows[0].together, true);
  assert.equal(rows[0].owner_email, ME);
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  assert.equal(rows[0].taken_on, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  page.closeCamera();
});

test('with the timer set, it counts down before shooting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fakeCamera();
  const page = statsPage();
  await page.openCamera();
  page.cycleTimer();
  assert.equal(page.camera.timer, 3);
  const before = supabase.storage._uploads.length;

  const shot = page.shutter();
  await Promise.resolve();
  assert.equal(page.camera.countdown, 3);
  t.mock.timers.tick(1000); await Promise.resolve(); await Promise.resolve();
  assert.equal(page.camera.countdown, 2);
  assert.equal(supabase.storage._uploads.length, before, 'not yet');
  t.mock.timers.tick(1000); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(1000);
  t.mock.timers.reset();
  await shot;
  assert.equal(page.camera.countdown, 0);
  assert.equal(supabase.storage._uploads.length, before + 1);
  page.closeCamera();
});

test('the timer goes off, 3s, 10s, and round again', async () => {
  fakeCamera();
  const page = statsPage();
  await page.openCamera();
  const seen = [page.camera.timer];
  for (let i = 0; i < 3; i++) { page.cycleTimer(); seen.push(page.camera.timer); }
  assert.deepEqual(seen, [0, 3, 10, 0]);
  page.closeCamera();
});

test('flipping turns the old camera off and opens the other one', async () => {
  const cam = fakeCamera();
  const page = statsPage();
  await page.openCamera();
  await page.flipCamera();
  assert.equal(cam.tracks[0].stopped, true);
  assert.equal(cam.asked[1].video.facingMode, 'user');
  assert.equal(page.camera.facing, 'user');
  page.closeCamera();
  assert.equal(cam.tracks[1].stopped, true, 'Done turns the camera light off');
  assert.equal(page.camera, null);
});

test('locking the photos closes the camera too', async () => {
  const cam = fakeCamera();
  const page = statsPage();
  await page.openCamera();
  page.relockPhotos();
  assert.equal(page.camera, null);
  assert.equal(cam.tracks[0].stopped, true);
});

test('a refused camera says why and offers the phone camera', async () => {
  fakeCamera({ refuse: 'NotAllowedError' });
  const page = statsPage();
  await page.openCamera();
  assert.match(page.cameraError, /Allow it in the browser settings/);
  page.closeCamera();
});

test('with no camera in the page at all, Take photo falls back to the phone camera', async () => {
  delete navigator.mediaDevices;
  let clicked = '';
  const real = document.getElementById;
  document.getElementById = (id) => ({ click() { clicked = id; } });
  try {
    const page = statsPage();
    await page.openCamera();
    assert.equal(clicked, 'pp-camera');
    assert.equal(page.camera, null);
    assert.equal(page.pickerHeld, true, 'so the camera app hiding the page does not relock it');
  } finally {
    document.getElementById = real;
  }
});

// ---- markup ---------------------------------------------------------------------

const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');

test('Take photo opens the camera; the library still goes through the save sheet', () => {
  assert.match(html, /<button class="btn btn-primary" @click="openCamera\(\)">Take photo<\/button>/);
  assert.match(html, /<label class="btn" for="pp-library" @click="pickerHeld = true">From library<\/label>/);
});

test('the camera screen: inline video, poses and Together, shutter, flip, timer, Done', () => {
  const cam = html.slice(html.indexOf('<template x-if="camera">'), html.indexOf('<!-- Save a progress photo'));
  assert.match(cam, /<video x-ref="viewfinder" playsinline muted autoplay/);
  assert.match(cam, /:class="camera\.facing === 'user' && 'is-mirrored'"/);
  assert.match(cam, /@click="camera\.together = !camera\.together">Together<\/button>/);
  assert.match(cam, /class="camera-shutter" @click="shutter\(\)"/);
  assert.match(cam, /@click="flipCamera\(\)"/);
  assert.match(cam, /@click="cycleTimer\(\)"/);
  assert.match(cam, /@click="usePhoneCamera\(\)"/);
  assert.match(cam, /@click="closeCamera\(\)">Done<\/button>/);
});

test('Together can be set when saving from the library and changed later', () => {
  assert.match(html, /@click="photoDraft\.together = !photoDraft\.together">Together<\/button>/);
  assert.match(html, /@click="editPhoto\(\{ together: !viewingPhoto\.together \}\)">Together<\/button>/);
  assert.match(html, /<span class="photo-cell-together" x-show="p\.together">Together<\/span>/);
});

test('the camera module is precached', async () => {
  const sw = await readFile(fileURLToPath(new URL('../docs/sw.js', import.meta.url)), 'utf8');
  assert.match(sw, /'\/js\/camera\.js',/);
});
