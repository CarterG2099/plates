/**
 * scanner.js — barcode capture.
 *
 * Capture-to-decode, not a continuous decode loop: you frame the barcode and
 * tap, and exactly one frame is decoded. That avoids the one genuinely untested
 * thing in this stack (sustained decoding in an installed iOS PWA), doesn't
 * drain the battery while you hunt for the barcode, and is steadier in bad
 * pantry light because you can hold the shot.
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

/**
 * Decode the current frame.
 * @returns {Promise<string|null>} the barcode, or null if this frame had none
 */
export async function capture(video) {
  if (!video?.videoWidth) return null;

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  if (detector) {
    try {
      const codes = await detector.detect(canvas);
      return codes?.[0]?.rawValue ?? null;
    } catch {
      return null;
    }
  }
  return decodeWithZxing(canvas);
}

async function decodeWithZxing(canvas) {
  const ZXing = await loadZXing();
  zxingReader ??= new ZXing.BrowserMultiFormatReader();

  // The decode entry point has moved between releases, so try what exists
  // rather than pinning to one name that may not be there.
  const attempts = [
    () => zxingReader.decodeFromCanvas(canvas),
    () => zxingReader.decodeFromImageUrl(canvas.toDataURL('image/png')),
  ];

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
