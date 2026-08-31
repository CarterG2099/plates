/**
 * scanner.js — barcode capture.
 *
 * Decodes continuously: point the camera and it reads, no tap. The earlier
 * capture-to-decode design put a button between you and the thing you came to
 * do, which is the wrong trade in an app whose entire premise is speed.
 *
 * The cost that design was avoiding is real, so it is paid for explicitly here
 * instead — a throttled loop rather than every frame, one reused canvas, a
 * smaller frame on the CPU decode path, and no work at all while backgrounded.
 *
 * Native BarcodeDetector is used where it exists (Chromium). Everywhere else a
 * ZXing build is fetched on demand — the pure-JS port, not the WASM one, so the
 * page never needs 'wasm-unsafe-eval' in its CSP.
 */

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

/** Which rear lens worked last time; heuristics run only until one is chosen. */
const CAMERA_KEY = 'plates:scanner-camera';

/** Barcodes are small; resolution is what decodes them. */
const RESOLUTION = { width: { ideal: 1920 }, height: { ideal: 1080 } };

/**
 * Hold the packet where the lens can focus, and zoom instead of leaning in.
 *
 * The natural move with a small barcode is to bring it close until it fills the
 * frame — which on most phones is inside the lens's minimum focus distance, so
 * the preview goes soft and never recovers. Starting at 2× lets the same
 * framing happen from twice as far away, comfortably inside focus range. This
 * is what the platform barcode scanners do; it is the single biggest reason the
 * camera app reads a code this scanner missed.
 */
const DEFAULT_ZOOM = 2;

let stream = null;
let detector = null;
let zxingReader = null;
let scanTimer = null;
let scanning = false;
let generation = 0;

export function isSupported() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
}

/**
 * Open the rear camera into `video` — the right rear camera, not whichever one
 * the browser felt like.
 *
 * `facingMode: environment` is a coin toss on a multi-lens phone: the browser
 * may hand over the ultrawide, whose minimum focus distance is far beyond
 * barcode range, so the preview looks alive and nothing ever sharpens. Labels
 * are blank until permission is granted, so the order has to be: open any rear
 * camera, then look at what else exists and move to the main lens if the pick
 * was a specialist one.
 *
 * @returns {Promise<{ok: true, decoder: string, focus: string,
 *   zoom: {min:number,max:number,step:number,value:number}|null,
 *   torch: boolean, canSwitch: boolean} | {ok: false, reason: string}>}
 */
export async function start(video) {
  if (!isSupported()) {
    return { ok: false, reason: 'Camera needs a secure connection (https).' };
  }

  // focusMode deliberately NOT requested in any getUserMedia call. As a basic
  // constraint it is required, so a device without focus control fails the
  // whole call and you get no camera at all. Focus is asked for on the live
  // track afterwards, where a refusal costs nothing.
  const opened = await openCamera(video, { facingMode: { ideal: 'environment' } });
  if (!opened.ok) return opened;

  try {
    const devices = (await navigator.mediaDevices.enumerateDevices?.()) ?? [];
    const want = pickCamera(devices);
    const got = videoTrack()?.getSettings?.()?.deviceId;
    if (want && got && want !== got) {
      const swapped = await openCamera(video, { deviceId: { exact: want } });
      // A failed swap falls back to the lens that already worked.
      if (!swapped.ok) await openCamera(video, { facingMode: { ideal: 'environment' } });
    }
    if (want) localStorage.setItem(CAMERA_KEY, want);
  } catch { /* the browser's pick stays */ }

  return { ok: true, decoder: await prepareDecoder(), ...(await tuneTrack()) };
}

/** getUserMedia + attach + play, replacing whatever stream came before. */
async function openCamera(video, videoConstraints) {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoConstraints, ...RESOLUTION },
      audio: false,
    });
  } catch (e) {
    const reason = e.name === 'NotAllowedError'
      ? 'Camera permission was denied.'
      : `Camera unavailable: ${e.message}`;
    return { ok: false, reason };
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', '');   // iOS refuses to inline-play without it
  await video.play();
  return { ok: true };
}

const isBackCamera = (d) =>
  d.kind === 'videoinput' && /\b(back|rear|environment)\b/i.test(d.label ?? '');

/**
 * The main rear lens, by elimination.
 *
 * Specialist lenses say so in their labels — "Back Ultra Wide Camera",
 * "Back Telephoto Camera" — and the main camera is the rear one that is none of
 * those. Ties go to enumeration order, which on Android lists the main lens
 * first ("camera2 0, facing back"). A lens that already worked here wins over
 * the heuristic outright.
 */
function pickCamera(devices) {
  const backs = devices.filter(isBackCamera);
  if (!backs.length) return null;

  const remembered = localStorage.getItem(CAMERA_KEY);
  if (backs.some((d) => d.deviceId === remembered)) return remembered;

  const specialist = /ultra|wide[\s-]?angle|tele(photo)?|zoom|macro|depth|bokeh|infrared/i;
  return (backs.find((d) => !specialist.test(d.label)) ?? backs[0]).deviceId;
}

/**
 * Focus, zoom and torch on the live track, reporting what actually took.
 * Every part is optional equipment; a camera without it just reports so.
 */
async function tuneTrack() {
  const focus = await requestFocus();
  const track = videoTrack();
  const caps = track?.getCapabilities?.() ?? {};

  let zoom = null;
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const value = await setZoom(DEFAULT_ZOOM);
    zoom = {
      min: caps.zoom.min,
      max: caps.zoom.max,
      step: caps.zoom.step || 0.1,
      value: value ?? caps.zoom.min,
    };
  }

  let canSwitch = false;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices?.()) ?? [];
    canSwitch = devices.filter(isBackCamera).length > 1;
  } catch { /* switching just isn't offered */ }

  return { focus, zoom, torch: Boolean(caps.torch), canSwitch };
}

/** @returns {Promise<number|null>} the zoom that took, clamped to the lens's range. */
export async function setZoom(value) {
  const track = videoTrack();
  const caps = track?.getCapabilities?.() ?? {};
  if (!caps.zoom) return null;

  const v = Math.min(caps.zoom.max, Math.max(caps.zoom.min, Number(value) || caps.zoom.min));
  try {
    await track.applyConstraints({ advanced: [{ zoom: v }] });
  } catch {
    return null;
  }
  return track.getSettings?.()?.zoom ?? v;
}

/** @returns {Promise<boolean>} whether the torch is now on. */
export async function setTorch(on) {
  const track = videoTrack();
  if (!track?.getCapabilities?.()?.torch) return false;

  try {
    await track.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
  } catch {
    return false;
  }
  return Boolean(track.getSettings?.()?.torch ?? on);
}

/**
 * The next rear lens. The escape hatch for when the heuristic guessed wrong —
 * no label survey covers every phone, but a button that cycles lenses does.
 * The lens that ends up working is remembered and wins from then on.
 */
export async function switchCamera(video) {
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices?.()) ?? [];
  } catch { /* fall through to the length check */ }

  const backs = devices.filter(isBackCamera);
  if (backs.length < 2) return { ok: false, reason: 'This device has one rear camera.' };

  const current = videoTrack()?.getSettings?.()?.deviceId;
  const at = backs.findIndex((d) => d.deviceId === current);
  const next = backs[(at + 1) % backs.length];

  const opened = await openCamera(video, { deviceId: { exact: next.deviceId } });
  if (!opened.ok) {
    // Recover the session rather than leaving a black viewfinder.
    await openCamera(video, { facingMode: { ideal: 'environment' } });
    return { ok: false, reason: 'That lens would not open.', ...(await tuneTrack()) };
  }

  localStorage.setItem(CAMERA_KEY, next.deviceId);
  return { ok: true, ...(await tuneTrack()) };
}

export function stop(video) {
  stopDecoding();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (video) video.srcObject = null;

  try { zxingReader?.reset(); } catch { /* older builds differ */ }
  zxingReader = null;
}

const videoTrack = () => stream?.getVideoTracks?.()[0] ?? null;

/**
 * Ask the track for autofocus after the fact.
 *
 * `focusDistance` is NOT a hint — it is the manual-focus control, and setting it
 * takes the camera out of autofocus and pins it at that distance. This function
 * used to request continuous mode and then immediately set focusDistance to the
 * near limit, which overrode the autofocus it had just asked for and left every
 * frame fixed at minimum range. That is why Android never focused while the
 * camera app, which does nothing of the sort, focused fine.
 *
 * The applied mode is read back from getSettings() rather than assumed, because
 * applyConstraints resolves happily having satisfied nothing in `advanced`.
 *
 * @returns {Promise<'continuous'|'single-shot'|'unavailable'>}
 */
async function requestFocus() {
  const track = videoTrack();
  const modes = track?.getCapabilities?.().focusMode ?? [];

  // Continuous first; single-shot is still far better than a fixed lens.
  const wanted = ['continuous', 'single-shot'].find((m) => modes.includes(m));
  if (!wanted) return 'unavailable';

  try {
    await track.applyConstraints({ advanced: [{ focusMode: wanted }] });
  } catch {
    return 'unavailable';
  }

  const applied = track.getSettings?.().focusMode;
  return applied === 'continuous' || applied === 'single-shot' ? applied : 'unavailable';
}

/**
 * Focus on a point in the frame, in normalised 0–1 coordinates.
 *
 * This is what tapping the preview does in a camera app. `pointsOfInterest`
 * steers the existing autofocus rather than replacing it, so it composes with
 * continuous mode instead of fighting it the way focusDistance did.
 */
export async function focusAt(x, y) {
  const track = videoTrack();
  const caps = track?.getCapabilities?.() ?? {};

  // No point steering, but a tap can still mean "focus again": re-triggering
  // single-shot refocuses on centre frame, which is where the reticle says to
  // hold the barcode anyway.
  if (!caps.pointsOfInterest) {
    if (!caps.focusMode?.includes('single-shot')) return false;
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
      return true;
    } catch {
      return false;
    }
  }

  const point = { x: clamp01(x), y: clamp01(y) };

  try {
    await track.applyConstraints({ advanced: [{ pointsOfInterest: [point] }] });

    // A single-shot camera needs re-triggering to act on the new point;
    // continuous will pick it up on its own.
    if (caps.focusMode?.includes('single-shot')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [point] }] });
    }
    return true;
  } catch {
    return false;
  }
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * Decode a photo taken with the system camera app.
 *
 * `<input capture>` hands the shot to the real camera UI — tap-to-focus, macro,
 * the lot — and gives back a still. On iOS, where getUserMedia has no focus
 * control, this is simply the better instrument.
 */
export async function decodeImageFile(file) {
  if (!file) return null;

  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();

  if (typeof window.BarcodeDetector !== 'undefined') {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        const codes = await new window.BarcodeDetector({ formats }).detect(canvas);
        if (codes?.length) return codes[0].rawValue;
      }
    } catch { /* fall through to ZXing */ }
  }
  return decodeWithZxing(canvas);
}

async function prepareDecoder() {
  if (typeof window.BarcodeDetector !== 'undefined') {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        detector = new window.BarcodeDetector({ formats });
        return 'native';
      }
    } catch { /* fall through to ZXing */ }
  }
  return 'zxing';
}

// One canvas for the whole session. At ~8 decodes a second, allocating a
// 1920×1080 canvas per frame is pure garbage-collector pressure.
let frameCanvas = null;

function frameOf(video, maxWidth = Infinity) {
  if (!video?.videoWidth) return null;

  const scale = Math.min(1, maxWidth / video.videoWidth);
  frameCanvas ??= document.createElement('canvas');
  frameCanvas.width = Math.round(video.videoWidth * scale);
  frameCanvas.height = Math.round(video.videoHeight * scale);

  frameCanvas.getContext('2d')
    .drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
  return frameCanvas;
}

/**
 * Decode the current frame.
 * @returns {Promise<string|null>} the barcode, or null if this frame had none
 */
export async function capture(video) {
  if (detector) {
    const canvas = frameOf(video);
    if (!canvas) return null;
    try {
      const codes = await detector.detect(canvas);
      return codes?.[0]?.rawValue ?? null;
    } catch {
      return null;
    }
  }

  // ZXing decodes on the CPU, so the loop pays for every pixel. 1280 across a
  // filled frame is still far more than a barcode needs.
  const canvas = frameOf(video, 1280);
  return canvas ? decodeWithZxing(canvas, { allowSlowFallback: false }) : null;
}

/**
 * Read continuously until a barcode is found.
 *
 * Two matching consecutive reads are required before accepting. EAN and UPC
 * carry a check digit, but Code 39 and 128 do not — one bad frame there would
 * otherwise look up a barcode that was never on the packet.
 *
 * @returns {() => void} stop
 */
export function startDecoding(video, { onResult, onError } = {}) {
  stopDecoding();

  // A decode is async, so a tick can still be mid-flight when the sheet closes.
  // Without a generation to check, reopening the scanner sets the shared
  // `scanning` flag back to true and that orphaned tick resumes into the new
  // session — still holding the old session's callbacks.
  const mine = ++generation;
  const alive = () => scanning && generation === mine;
  scanning = true;

  const interval = detector ? 120 : 450;
  let lastCode = null;
  let agreed = 0;

  const tick = async () => {
    if (!alive()) return;

    // Nothing to read while backgrounded, and decoding there just burns battery.
    if (document.visibilityState !== 'visible') return schedule();

    let code = null;
    try {
      code = await capture(video);
    } catch (error) {
      if (!alive()) return;
      scanning = false;
      onError?.(error);
      return;
    }
    if (!alive()) return;          // closed while that frame was decoding

    if (code) {
      agreed = code === lastCode ? agreed + 1 : 1;
      lastCode = code;
      if (agreed >= 2) {
        scanning = false;
        onResult?.(code);
        return;
      }
    }
    schedule();
  };

  const schedule = () => {
    if (!alive()) return;
    scanTimer = setTimeout(tick, interval);
  };
  schedule();

  return stopDecoding;
}

export function stopDecoding() {
  scanning = false;
  generation++;
  clearTimeout(scanTimer);
  scanTimer = null;
}

async function decodeWithZxing(canvas, { allowSlowFallback = true } = {}) {
  const ZXing = await loadZXing();
  zxingReader ??= new ZXing.BrowserMultiFormatReader();

  // The decode entry point has moved between releases, so try what exists
  // rather than pinning to one name that may not be there. The data-URL route
  // re-encodes the whole frame as PNG — fine once for a photo, far too slow to
  // run every tick, so the loop opts out of it.
  const attempts = [() => zxingReader.decodeFromCanvas(canvas)];
  if (allowSlowFallback) {
    attempts.push(() => zxingReader.decodeFromImageUrl(canvas.toDataURL('image/png')));
  }

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result) return result.getText();
    } catch {
      // NotFoundException simply means this frame had no barcode.
    }
  }
  return null;
}

let zxingPromise = null;

function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);

  // Fetched on demand so Chromium users never pay for a library they don't use.
  zxingPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ZXING_URL;
    script.onload = () => {
      if (window.ZXing) resolve(window.ZXing);
      else reject(new Error('Barcode library loaded but did not initialise.'));
    };
    script.onerror = () => reject(new Error('Could not load the barcode library.'));
    document.head.appendChild(script);
  });

  return zxingPromise;
}
