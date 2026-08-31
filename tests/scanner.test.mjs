import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();

/**
 * A fake camera.
 *
 * `queue` is what the "camera" sees, one frame per decode. `camera` is the
 * hardware: which devices exist, which one facingMode hands over, what the
 * track can do, and — via `applied` and `settings` — what the code actually
 * asked of it. The track is a singleton on purpose: several tests monkey-patch
 * its methods, and a per-stream track would silently detach them.
 */
let queue = [];

const camera = {
  devices: [
    { kind: 'videoinput', deviceId: 'cam-main', label: 'camera2 0, facing back' },
    { kind: 'videoinput', deviceId: 'cam-ultra', label: 'Back Ultra Wide Camera' },
    { kind: 'videoinput', deviceId: 'cam-front', label: 'Front Camera' },
  ],
  granted: 'cam-ultra',   // facingMode hands over the wrong lens, as phones do
  capabilities: {
    focusMode: ['continuous', 'single-shot'],
    pointsOfInterest: true,
    zoom: { min: 1, max: 8, step: 0.1 },
    torch: true,
  },
  applied: [],            // every advanced constraint, in order
  settings: {},           // what getSettings() reports back
  opens: [],              // the video constraints of every getUserMedia call
};

const track = {
  stop() {},
  getCapabilities: () => camera.capabilities,
  getSettings: () => ({ ...camera.settings }),
  applyConstraints: async (c) => {
    for (const adv of c?.advanced ?? []) {
      camera.applied.push(adv);
      if ('zoom' in adv) camera.settings.zoom = adv.zoom;
      if ('torch' in adv) camera.settings.torch = adv.torch;
      if ('focusMode' in adv) camera.settings.focusMode = adv.focusMode;
    }
  },
};
const stream = { getTracks: () => [track], getVideoTracks: () => [track] };

class FakeBarcodeDetector {
  static async getSupportedFormats() { return ['ean_13', 'upc_a', 'code_128']; }
  async detect() {
    const v = queue.shift() ?? null;
    return v ? [{ rawValue: v }] : [];
  }
}

navigator.mediaDevices = {
  getUserMedia: async ({ video: v }) => {
    camera.opens.push(v);
    camera.settings = { focusMode: 'continuous', deviceId: v?.deviceId?.exact ?? camera.granted };
    return stream;
  },
  enumerateDevices: async () => camera.devices,
};
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

// ---- lens, zoom, torch ----------------------------------------------------------
// The quality fixes: the browser's facingMode pick is often a rear lens that
// cannot focus at barcode range, and a barcode brought close enough to fill the
// frame sits inside the minimum focus distance. The lens gets corrected, and a
// starting zoom lets the barcode fill the frame from where focus works.

test('start moves off the lens the browser picked, onto the main rear camera', async () => {
  localStorage.removeItem('plates:scanner-camera');
  camera.opens = [];
  await scanner.start(video);

  assert.equal(camera.opens.length, 2, 'the permission open, then the corrective open');
  assert.deepEqual(camera.opens[1].deviceId, { exact: 'cam-main' },
    'the ultrawide is a specialist lens; camera2 0 is the main one');
  assert.equal(localStorage.getItem('plates:scanner-camera'), 'cam-main');
});

test('start applies a starting zoom and reports the whole control surface', async () => {
  camera.applied = [];
  const result = await scanner.start(video);

  assert.ok(camera.applied.some((a) => a.zoom === 2), 'zoom 2 lets focus happen at arm\'s length');
  assert.deepEqual(result.zoom, { min: 1, max: 8, step: 0.1, value: 2 });
  assert.equal(result.torch, true);
  assert.equal(result.canSwitch, true, 'two rear lenses means the switch button shows');
});

test('a lens that worked before wins over the heuristic', async () => {
  localStorage.setItem('plates:scanner-camera', 'cam-ultra');
  camera.opens = [];
  await scanner.start(video);

  assert.equal(camera.opens.length, 1, 'the granted lens is the remembered one — no corrective open');
  localStorage.removeItem('plates:scanner-camera');
});

test('setZoom clamps to what the lens can actually do', async () => {
  await scanner.start(video);
  assert.equal(await scanner.setZoom(50), 8);
  assert.equal(await scanner.setZoom(0), 1);
  assert.equal(await scanner.setZoom(3.5), 3.5);
});

test('setTorch reports the torch state the track ended up in', async () => {
  await scanner.start(video);
  assert.equal(await scanner.setTorch(true), true);
  assert.equal(await scanner.setTorch(false), false);
});

test('switchCamera cycles rear lenses and remembers the choice', async () => {
  localStorage.removeItem('plates:scanner-camera');
  await scanner.start(video);                    // corrected onto cam-main

  const result = await scanner.switchCamera(video);
  assert.equal(result.ok, true);
  assert.equal(camera.settings.deviceId, 'cam-ultra');
  assert.equal(localStorage.getItem('plates:scanner-camera'), 'cam-ultra');

  // The remembered lens now wins on the next start, with no corrective swap.
  camera.opens = [];
  await scanner.start(video);
  assert.equal(camera.opens.length, 1);
  assert.equal(camera.settings.deviceId, 'cam-ultra');
  localStorage.removeItem('plates:scanner-camera');
});

test('switchCamera declines gracefully with a single rear lens', async () => {
  const real = camera.devices;
  camera.devices = real.filter((d) => d.deviceId !== 'cam-ultra');
  try {
    await scanner.start(video);
    const result = await scanner.switchCamera(video);
    assert.equal(result.ok, false);
    assert.match(result.reason, /one rear camera/i);
  } finally {
    camera.devices = real;
  }
});

test('a tap still retriggers focus when the camera cannot steer by point', async () => {
  const real = camera.capabilities;
  camera.capabilities = { ...real, pointsOfInterest: undefined };
  try {
    await scanner.start(video);
    camera.applied = [];
    assert.equal(await scanner.focusAt(0.5, 0.5), true);
    assert.ok(camera.applied.some((a) => a.focusMode === 'single-shot'),
      'a bare single-shot retrigger refocuses on centre frame');
  } finally {
    camera.capabilities = real;
  }
});
