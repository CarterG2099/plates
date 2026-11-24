/**
 * Progress photos from the camera inside the app: the shutter freezes the shot,
 * tapping its pose saves it, and a photo of you both shows in both timelines.
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
const messages = await import('../docs/js/messages.js');
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

test('Take photo opens the back camera with no shot waiting, timer off', async () => {
  const cam = fakeCamera();
  const page = statsPage();
  await page.openCamera();
  assert.deepEqual({ ...page.camera }, { purpose: 'progress', mode: 'photo', facing: 'environment', together: false, timer: 0, countdown: 0, recording: false, elapsed: 0, shot: null });
  assert.equal(cam.asked[0].video.facingMode, 'environment');
  assert.equal(page.cameraError, '');
  page.closeCamera();
});

test('the shutter only freezes the shot; nothing is saved until a pose is chosen', async () => {
  fakeCamera();
  const page = statsPage();
  await page.openCamera();
  const before = supabase.storage._uploads.length;

  await page.shutter();
  assert.ok(page.camera.shot.blob instanceof Blob);
  assert.match(page.camera.shot.url, /^blob:/);
  assert.equal(supabase.storage._uploads.length, before, 'not saved yet');

  const first = page.camera.shot;
  await page.shutter();
  assert.equal(page.camera.shot, first, 'a second tap does not replace the shot');
  assert.equal(supabase.storage._uploads.length, before, 'nor save it');
  page.closeCamera();
});

test('choosing a pose saves the shot as today\'s, with that pose, and goes back to the viewfinder', async () => {
  fakeCamera();
  const page = statsPage();
  await page.openCamera();
  page.camera.together = true;
  const before = supabase.storage._uploads.length;

  await page.shutter();
  await page.keepShot('side');
  assert.equal(supabase.storage._uploads.length, before + 1, 'uploaded');
  assert.equal(page.camera.shot, null, 'ready for the next one');
  assert.equal(page.cameraSaving, 0);

  const rows = (await local.all('progress_photos')).filter((p) => p.object_path === supabase.storage._uploads.at(-1).path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pose, 'side');
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
  assert.equal(page.camera.shot, null, 'not yet');
  t.mock.timers.tick(1000); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(1000);
  t.mock.timers.reset();
  await shot;
  assert.equal(page.camera.countdown, 0);
  assert.ok(page.camera.shot, 'the shot is waiting for its pose');
  assert.equal(supabase.storage._uploads.length, before);
  page.closeCamera();
});

test('Retake throws the shot away and saves nothing', async () => {
  fakeCamera();
  const page = statsPage();
  await page.openCamera();
  const before = supabase.storage._uploads.length;
  const revoked = [];
  const real = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    await page.shutter();
    const { url } = page.camera.shot;
    page.retake();
    assert.equal(page.camera.shot, null);
    assert.deepEqual(revoked, [url], 'the preview is let go');
    await page.keepShot('front');
    assert.equal(supabase.storage._uploads.length, before, 'no shot, nothing to save');
  } finally {
    URL.revokeObjectURL = real;
  }
  page.closeCamera();
});

test('Done with a shot still waiting discards it', async () => {
  fakeCamera();
  const page = statsPage();
  await page.openCamera();
  const before = supabase.storage._uploads.length;
  const revoked = [];
  const real = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    await page.shutter();
    const { url } = page.camera.shot;
    page.closeCamera();
    assert.deepEqual(revoked, [url], 'the preview is let go');
  } finally {
    URL.revokeObjectURL = real;
  }
  assert.equal(page.camera, null);
  assert.equal(supabase.storage._uploads.length, before);
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

test('the camera screen: the pose is chosen under the frozen shot, not above the viewfinder', () => {
  const cam = html.slice(html.indexOf('<template x-if="camera">'), html.indexOf('<!-- Messages'));
  const top = cam.slice(cam.indexOf('camera-top'), cam.indexOf('camera-frame'));
  assert.doesNotMatch(top, /poses/, 'no pose to set before the shot');
  assert.match(cam, /<img class="camera-shot" x-show="camera\.shot && camera\.shot\.kind !== 'video'"/);
  assert.match(cam, /<div class="camera-bar camera-poses" x-show="camera\.shot && camera\.purpose === 'progress'">/);
  assert.match(cam, /<template x-for="p in poses" :key="p">\s*<button class="btn" @click="keepShot\(p\)"/);
  assert.match(cam, /@click="retake\(\)">Retake<\/button>/);
  assert.match(cam, /<div class="camera-bar" x-show="!camera\.shot">/);
});

test('the camera screen: inline video, Together, shutter, flip, timer, Done', () => {
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

// ---- the camera in Messages ------------------------------------------------------
//
// A chat photo is taken in the page and goes into the message box, never via
// the phone's camera app, which would leave a copy in the gallery.

/** The Stats screen with Messages open; Realtime is a no-op channel. */
function chatPage() {
  supabase.channel = () => ({ on() { return this; }, subscribe() { return this; } });
  supabase.removeChannel = () => {};
  const page = statsPage();
  page.photosLocked = false;
  page.openChat();
  assert.equal(page.chatOpen, true);
  return page;
}

test('Camera in Messages opens the camera in the page, with no pose or Together to choose', async () => {
  const cam = fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  assert.equal(page.camera.purpose, 'chat');
  assert.equal(cam.asked[0].video.facingMode, 'environment');
  page.closeCamera();
  page.closeChat();
});

test('Use photo puts the shot in the message box, closes the camera, and saves nothing', async () => {
  const cam = fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  const uploads = supabase.storage._uploads.length;
  const photos = (await local.all('progress_photos')).length;

  await page.shutter();
  const { blob, url } = page.camera.shot;
  page.useChatShot();

  assert.equal(page.camera, null, 'back to the conversation');
  assert.equal(cam.tracks[0].stopped, true, 'the camera light is off');
  assert.equal(page.chatPhoto.file, blob, 'the shot itself is waiting to send');
  assert.equal(page.chatPhoto.url, url, 'and its preview was handed over, not revoked');
  assert.equal(supabase.storage._uploads.length, uploads, 'nothing sent until Send');
  assert.equal((await local.all('progress_photos')).length, photos, 'not a progress photo');
  page.closeChat();
});

test('Send uploads the camera shot to the messages bucket, with its caption', async () => {
  fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  await page.shutter();
  page.useChatShot();
  page.chatText = 'gym selfie';

  await page.sendChat();
  const upload = supabase.storage._uploads.at(-1);
  assert.equal(upload.bucket, messages.BUCKET);
  const sent = (await local.all('messages')).find((m) => m.photo_path === upload.path);
  assert.equal(sent.body, 'gym selfie');
  assert.equal(sent.recipient_email, AANA);
  assert.equal(page.chatPhoto, null);
  page.closeChat();
});

test('the pose buttons cannot save a chat shot as a progress photo', async () => {
  fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  await page.shutter();
  const uploads = supabase.storage._uploads.length;
  await page.keepShot('front');
  assert.equal(supabase.storage._uploads.length, uploads);
  assert.ok(page.camera.shot, 'the shot is still waiting for Use photo or Retake');
  page.closeCamera();
  page.closeChat();
});

test('Retake in Messages throws the shot away and leaves the message box empty', async () => {
  fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  await page.shutter();
  page.retake();
  page.useChatShot();
  assert.equal(page.chatPhoto, null);
  assert.ok(page.camera, 'still in the camera, ready for another shot');
  page.closeCamera();
  page.closeChat();
});

test('with no camera in the page, Messages never falls back to the phone camera', async () => {
  delete navigator.mediaDevices;
  let clicked = '';
  const real = document.getElementById;
  document.getElementById = (id) => ({ click() { clicked = id; } });
  try {
    const page = chatPage();
    await page.openCamera('chat');
    assert.equal(clicked, '', 'no camera app, so no gallery copy');
    assert.equal(page.camera, null);
    assert.match(Alpine.store('ui').toast, /can’t show a camera/);
    page.closeChat();
  } finally {
    document.getElementById = real;
  }
});

test('a refused camera in Messages says why without suggesting the phone camera', async () => {
  fakeCamera({ refuse: 'NotAllowedError' });
  const page = chatPage();
  await page.openCamera('chat');
  assert.match(page.cameraError, /Allow it in the browser settings/);
  assert.doesNotMatch(page.cameraError, /phone camera/);
  page.closeCamera();
  page.closeChat();
});

test('no chat camera problem ever points at the phone camera', () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', undefined]) {
    assert.doesNotMatch(camera.problem({ name }, 'chat'), /phone camera/i, String(name));
  }
  assert.match(camera.problem({ name: 'NotAllowedError' }), /phone camera/, 'progress photos still offer it');
});

test('the message box has a camera icon (in the page) beside a library icon', () => {
  const chat = html.slice(html.indexOf('<form class="chat-compose"'), html.indexOf('</form>', html.indexOf('<form class="chat-compose"')));
  assert.match(chat, /<button type="button" class="chat-icon" @click="openCamera\('chat'\)" aria-label="Take a photo">\s*<svg/);
  assert.match(chat, /<label class="chat-icon" for="pm-photo" @click="pickerHeld = true" aria-label="Send a photo from the library">\s*<svg/);
  assert.doesNotMatch(chat, />(Camera|Library|Photo|Send)</, 'icons, not words');
});

test('the camera screen in chat mode: Use photo, no poses, no Together, no phone-camera button', () => {
  const cam = html.slice(html.indexOf('<template x-if="camera">'), html.indexOf('<!-- Messages'));
  assert.match(cam, /<div class="camera-top chips" x-show="camera\.purpose === 'progress'">/);
  assert.match(cam, /<div class="camera-bar camera-poses" x-show="camera\.shot && camera\.purpose === 'chat'">\s*<button class="camera-side" @click="retake\(\)">Retake<\/button>\s*<button class="btn btn-primary" @click="useChatShot\(\)"\s+x-text="camera\.shot\?\.kind === 'video' \? 'Use video' : 'Use photo'">/);
  assert.match(cam, /<button class="btn" x-show="camera\.purpose === 'progress'" @click="usePhoneCamera\(\)">/);
});

// ---- video clips in Messages ------------------------------------------------------
//
// MediaRecorder is a stand-in that hands over one chunk when stopped (or none,
// with `empty`), and remembers what it was asked for.

class FakeRecorder {
  static supported = ['video/webm;codecs=vp8,opus', 'video/webm'];
  static isTypeSupported(type) { return FakeRecorder.supported.includes(type); }
  static last = null;
  static empty = false;
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options?.mimeType ?? '';
    this.state = 'inactive';
    this.stops = 0;
    FakeRecorder.last = this;
  }
  start() { this.state = 'recording'; }
  stop() {
    this.stops++;
    this.state = 'inactive';
    if (!FakeRecorder.empty) this.ondataavailable?.({ data: new Blob(['clip'], { type: 'video/webm' }) });
    queueMicrotask(() => this.onstop?.());
  }
}

function withRecorder(t) {
  globalThis.MediaRecorder = FakeRecorder;
  FakeRecorder.supported = ['video/webm;codecs=vp8,opus', 'video/webm'];
  FakeRecorder.empty = false;
  t.after(() => { delete globalThis.MediaRecorder; });
}

const settle = () => new Promise((r) => setImmediate(r));

test('a clip asks for sound and a phone-sized frame; a still asks for neither', () => {
  const clip = camera.constraints('user', { audio: true });
  assert.equal(clip.audio, true);
  assert.equal(clip.video.width.ideal, 1280);
  const still = camera.constraints('user');
  assert.equal(still.audio, false);
  assert.equal(still.video.width.ideal, 4096);
});

test('clips record as MP4 where the browser can, else WebM, and keep that extension', (t) => {
  withRecorder(t);
  assert.equal(camera.recorderType(), 'video/webm;codecs=vp8,opus');
  FakeRecorder.supported = ['video/mp4', 'video/webm'];
  assert.equal(camera.recorderType(), 'video/mp4');
  assert.equal(camera.extensionFor('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(camera.extensionFor('video/webm'), 'webm');
});

test('a clip stops itself at the limit', async (t) => {
  withRecorder(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rec = camera.record({}, { maxMs: 15_000 });
  t.mock.timers.tick(14_999);
  assert.equal(FakeRecorder.last.state, 'recording');
  t.mock.timers.tick(1);
  t.mock.timers.reset();
  const blob = await rec.done;
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'video/webm');
  assert.equal(camera.VIDEO_MAX_S, 15);
});

test('a clip with nothing in it says so instead of sending an empty file', async (t) => {
  withRecorder(t);
  FakeRecorder.empty = true;
  const rec = camera.record({});
  await assert.rejects(rec.stop(), /recorded nothing/);
});

test('Video is offered in the chat camera only, and only where the browser can record', async (t) => {
  fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  assert.equal(page.canRecordVideo, false, 'no MediaRecorder: no Video chip');
  withRecorder(t);
  assert.equal(page.canRecordVideo, true);
  page.closeCamera();
  await page.openCamera('progress');
  assert.equal(page.canRecordVideo, false, 'progress photos stay photos');
  page.closeCamera();
  page.closeChat();
});

test('switching to Video reopens the camera with the microphone', async (t) => {
  withRecorder(t);
  const cam = fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  await page.setCameraMode('video');
  assert.equal(page.camera.mode, 'video');
  assert.equal(cam.asked.at(-1).audio, true);
  assert.equal(cam.tracks[0].stopped, true, 'the silent stream was let go');
  page.closeCamera();
  page.closeChat();
});

test('with the microphone refused, the clip records silent and says so', async (t) => {
  withRecorder(t);
  const asked = [];
  navigator.mediaDevices = {
    getUserMedia: async (c) => {
      asked.push(c);
      if (c.audio) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      const track = { stop() {} };
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    },
  };
  const page = chatPage();
  await page.openCamera('chat');
  await page.setCameraMode('video');
  assert.equal(page.cameraError, '');
  assert.match(page.cameraNote, /No sound/);
  assert.equal(asked.at(-1).audio, false);
  page.closeCamera();
  page.closeChat();
});

test('the shutter starts and stops a clip; Use video puts it in the message box', async (t) => {
  withRecorder(t);
  fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  await page.setCameraMode('video');

  await page.shutter();
  assert.equal(page.camera.recording, true);
  assert.equal(page.camera.shot, null);
  await page.shutter();
  await settle();
  assert.equal(page.camera.recording, false);
  assert.equal(page.camera.shot.kind, 'video');

  const { blob } = page.camera.shot;
  page.useChatShot();
  assert.equal(page.camera, null);
  assert.equal(page.chatPhoto.kind, 'video');
  assert.equal(page.chatPhoto.file, blob);
  page.closeChat();
});

test('Send uploads the clip to the messages bucket as video, never as a progress photo', async (t) => {
  withRecorder(t);
  fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  await page.setCameraMode('video');
  await page.shutter(); await page.shutter(); await settle();
  page.useChatShot();
  page.chatText = 'for later';
  const photos = (await local.all('progress_photos')).length;

  await page.sendChat();
  const upload = supabase.storage._uploads.at(-1);
  assert.equal(upload.bucket, messages.BUCKET);
  assert.match(upload.path, /\.webm$/);
  assert.equal(messages.isVideo(upload.path), true);
  const sent = (await local.all('messages')).find((m) => m.photo_path === upload.path);
  assert.equal(sent.body, 'for later');
  assert.equal((await local.all('progress_photos')).length, photos);
  page.closeChat();
});

test('closing the camera mid-clip throws the clip away', async (t) => {
  withRecorder(t);
  const cam = fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  await page.setCameraMode('video');
  await page.shutter();
  const recorder = FakeRecorder.last;
  page.closeCamera();
  await settle();
  assert.equal(recorder.stops, 1, 'recording stopped');
  assert.equal(page.camera, null);
  assert.equal(page.chatPhoto, null, 'nothing handed over');
  assert.ok(cam.tracks.every((tr) => tr.stopped), 'camera and microphone off');
  page.closeChat();
});

test('mid-clip the camera cannot be flipped or switched back to Photo', async (t) => {
  withRecorder(t);
  const cam = fakeCamera();
  const page = chatPage();
  await page.openCamera('chat');
  await page.setCameraMode('video');
  await page.shutter();
  const opened = cam.asked.length;
  await page.flipCamera();
  await page.setCameraMode('photo');
  assert.equal(cam.asked.length, opened, 'no new stream mid-clip');
  assert.equal(page.camera.mode, 'video');
  page.closeCamera();
  page.closeChat();
});

test('a clip too big for the bucket, or sent offline, is refused before uploading', async () => {
  const uploads = supabase.storage._uploads.length;
  const big = { size: messages.VIDEO_MAX_BYTES + 1, type: 'video/webm' };
  await assert.rejects(messages.sendVideo({ blob: big, ownerEmail: ME, recipientEmail: AANA }), /too big/);
  navigator.onLine = false;
  try {
    await assert.rejects(messages.sendVideo({ blob: new Blob(['x'], { type: 'video/mp4' }), ownerEmail: ME, recipientEmail: AANA }), /needs a connection/);
  } finally {
    navigator.onLine = true;
  }
  assert.equal(supabase.storage._uploads.length, uploads);
});

test('an MP4 clip is stored as .mp4 with its own content type', async () => {
  await messages.sendVideo({ blob: new Blob(['x'], { type: 'video/mp4;codecs=avc1' }), ownerEmail: ME, recipientEmail: AANA });
  const upload = supabase.storage._uploads.at(-1);
  assert.match(upload.path, /\.mp4$/);
  assert.equal(messages.isVideo('a.jpg'), false);
  assert.equal(messages.isVideo('a.MP4'), true);
});

test('a clip plays only while held, with sound where the phone allows, silent where it does not', async () => {
  fakeCamera();
  const page = chatPage();
  const calls = [];
  const el = {
    muted: true,
    play() { calls.push(`play:${this.muted ? 'muted' : 'sound'}`); return calls.length === 1 ? Promise.reject(new Error('gesture')) : Promise.resolve(); },
    pause() { calls.push('pause'); },
  };
  page.chatPlay(el, true);
  await settle();
  assert.deepEqual(calls, ['play:sound', 'play:muted']);
  page.chatPlay(el, false);
  assert.equal(calls.at(-1), 'pause');
  page.closeChat();
});

test('the camera screen offers Photo and Video in chat, and a stop button while recording', () => {
  const cam = html.slice(html.indexOf('<template x-if="camera">'), html.indexOf('<!-- Messages'));
  assert.match(cam, /<div class="camera-top chips" x-show="canRecordVideo">/);
  assert.match(cam, /@click="setCameraMode\('video'\)">Video<\/button>/);
  assert.match(cam, /:aria-label="camera\.mode !== 'video' \? 'Take the photo' : \(camera\.recording \? 'Stop recording' : 'Start recording'\)"/);
  assert.match(cam, /<div class="camera-rec" x-show="camera\.recording"/);
});

test('clips in the thread and full screen play only while held; the waiting one too', () => {
  assert.match(html, /x-effect="chatPlay\(\$el, chatRevealed === item\.m\.id\)"/);
  assert.match(html, /x-effect="chatPlay\(\$el, chatRevealed === 'viewer'\)"/);
  assert.match(html, /x-effect="chatRevealed === 'pending' \? \$el\.play\?\.\(\) : \$el\.pause\?\.\(\)"/);
  assert.doesNotMatch(html, /<video[^>]*\bautoplay\b[^>]*chatPhotoUrl/, 'no clip in the thread plays on its own');
});

test('the messages bucket takes short clips, and is still private', async () => {
  const sql = await readFile(fileURLToPath(new URL('../supabase/schema.sql', import.meta.url)), 'utf8');
  const update = sql.match(/update storage\.buckets[\s\S]+?where id = 'plates-messages';/)?.[0] ?? '';
  assert.match(update, /file_size_limit = 26214400/);
  assert.match(update, /'video\/mp4','video\/webm'/);
  assert.doesNotMatch(update, /public/);
  assert.equal(messages.VIDEO_MAX_BYTES, 26214400, 'the app and the bucket agree');
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
