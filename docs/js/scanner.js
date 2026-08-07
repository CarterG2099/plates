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
 * Open the rear camera into `video`.
 * @returns {Promise<{ok: true, decoder: string} | {ok: false, reason: string}>}
 */
export async function start(video) {
  if (!isSupported()) {
    return { ok: false, reason: 'Camera needs a secure connection (https).' };
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },      // barcodes are small; resolution is what decodes them
        height: { ideal: 1080 },
        // A getUserMedia stream does NOT inherit the camera app's autofocus.
        // Without asking, many devices hand back a fixed-focus stream, which is
        // why a barcode that the system camera nails stays blurred here.
        focusMode: 'continuous',
      },
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

  const focus = await requestFocus();
  return { ok: true, decoder: await prepareDecoder(), focus };
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

/**
 * Ask the track for continuous autofocus after the fact.
 *
 * The initial constraint is advisory and widely ignored; applying it to the live
 * track is what actually engages autofocus where the platform supports it. iOS
 * Safari exposes no focus control at all — hence the camera-app fallback.
 *
 * @returns {Promise<'continuous'|'unavailable'>}
 */
async function requestFocus() {
  const track = stream?.getVideoTracks?.()[0];
  const caps = track?.getCapabilities?.() ?? {};

  const advanced = [];
  if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
  // Macro-ish: bias toward the near end of the focus range for a barcode in hand.
  if (caps.focusDistance) advanced.push({ focusDistance: caps.focusDistance.min });

  if (!advanced.length) return 'unavailable';

  try {
    await track.applyConstraints({ advanced });
    return 'continuous';
  } catch {
    return 'unavailable';
  }
}

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
