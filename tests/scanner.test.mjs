import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();

/**
 * A fake camera.
 *
 * `queue` is what the "camera" sees, one frame per decode. Everything else is
 * the minimum getUserMedia surface start() touches.
 */
let queue = [];

const track = {
  stop() {},
  getCapabilities: () => ({ focusMode: ['continuous', 'single-shot'], pointsOfInterest: true }),
  getSettings: () => ({ focusMode: 'continuous' }),
  applyConstraints: async () => {},
};
const stream = { getTracks: () => [track], getVideoTracks: () => [track] };

class FakeBarcodeDetector {
  static async getSupportedFormats() { return ['ean_13', 'upc_a', 'code_128']; }
  async detect() {
    const v = queue.shift() ?? null;
    return v ? [{ rawValue: v }] : [];
  }
}

navigator.mediaDevices = { getUserMedia: async () => stream };
window.BarcodeDetector = FakeBarcodeDetector;
window.isSecureContext = true;

const scanner = await import('../docs/js/scanner.js');

const video = { videoWidth: 640, videoHeight: 480, setAttribute() {}, play: async () => {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the decode loop over a set of frames, resolving on a hit or a timeout. */
async function decode(frames, ms = 1500) {
  queue = [...frames];
  await scanner.start(video);

  return new Promise((resolve) => {
    let timer = null;
    const finish = (code) => {
      clearTimeout(timer);
      scanner.stopDecoding();
      resolve({ code, framesLeft: queue.length });
    };
    scanner.startDecoding(video, { onResult: finish });
    timer = setTimeout(() => finish(null), ms);
  });
}

test('two agreeing reads are accepted', async () => {
  const { code } = await decode([null, '0894700010045', '0894700010045']);
  assert.equal(code, '0894700010045');
});

test('a single read is not enough — Code 39 and 128 have no check digit', async () => {
  const { code } = await decode(['1111111111111', '2222222222222', null, null], 700);
  assert.equal(code, null);
});

test('noise before a stable code still resolves to the right one', async () => {
  const { code } = await decode(['9999999999999', null, '0044000032029', '0044000032029']);
  assert.equal(code, '0044000032029');
});

test('stopDecoding halts the loop before it can fire', async () => {
  queue = ['0894700010045', '0894700010045'];
  await scanner.start(video);

  let fired = false;
  scanner.startDecoding(video, { onResult: () => { fired = true; } });
  scanner.stopDecoding();

  await wait(400);
  assert.equal(fired, false);
});

test('nothing is decoded while the page is backgrounded', async () => {
  queue = ['0894700010045', '0894700010045'];
  await scanner.start(video);

  document.visibilityState = 'hidden';
  let fired = false;
  scanner.startDecoding(video, { onResult: () => { fired = true; } });

  await wait(400);
  scanner.stopDecoding();
  document.visibilityState = 'visible';

  assert.equal(fired, false);
  assert.equal(queue.length, 2, 'no frames should have been consumed');
});

test('a reopened scanner does not fire the previous session callback', async () => {
  // The generation guard: an in-flight tick from a closed session must die
  // rather than resume into the next one holding stale callbacks.
  queue = [];
  await scanner.start(video);

  let firstFired = false;
  scanner.startDecoding(video, { onResult: () => { firstFired = true; } });
  scanner.stopDecoding();

  queue = ['0894700010045', '0894700010045'];
  const second = await new Promise((resolve) => {
    scanner.startDecoding(video, { onResult: (c) => { scanner.stopDecoding(); resolve(c); } });
    setTimeout(() => { scanner.stopDecoding(); resolve(null); }, 1200);
  });

  assert.equal(second, '0894700010045');
  assert.equal(firstFired, false, 'the closed session must never fire');
});

test('start reports the decoder and the focus mode it managed to get', async () => {
  const result = await scanner.start(video);
  assert.equal(result.ok, true);
  assert.equal(result.decoder, 'native');
  assert.equal(result.focus, 'continuous');
});

test('start reports why it failed rather than throwing', async () => {
  const real = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async () => {
    const e = new Error('denied');
    e.name = 'NotAllowedError';
    throw e;
  };
  try {
    const result = await scanner.start(video);
    assert.equal(result.ok, false);
    assert.match(result.reason, /permission/i);
  } finally {
    navigator.mediaDevices.getUserMedia = real;
  }
});

test('focusAt clamps coordinates into range', async () => {
  const applied = [];
  const real = track.applyConstraints;
  track.applyConstraints = async (c) => { applied.push(c); };
  try {
    await scanner.start(video);
    await scanner.focusAt(-5, 99);
    const points = applied.flatMap((c) => c.advanced ?? []).flatMap((a) => a.pointsOfInterest ?? []);
    assert.ok(points.length > 0);
    assert.equal(points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), true);
  } finally {
    track.applyConstraints = real;
  }
});

test('focusAt reports false when the browser exposes no focus control', async () => {
  const real = track.getCapabilities;
  track.getCapabilities = () => ({});
  try {
    await scanner.start(video);
    assert.equal(await scanner.focusAt(0.5, 0.5), false);
  } finally {
    track.getCapabilities = real;
  }
});

test('capture returns null for a video with no frame yet', async () => {
  assert.equal(await scanner.capture({ videoWidth: 0, videoHeight: 0 }), null);
});

test('isSupported requires a secure context and a camera API', () => {
  assert.equal(scanner.isSupported(), true);

  const real = window.isSecureContext;
  window.isSecureContext = false;
  try {
    assert.equal(scanner.isSupported(), false);
  } finally {
    window.isSecureContext = real;
  }
});
