/**
 * camera.js — the camera inside the app, for progress photos and chat photos.
 *
 * The phone's camera app took two extra screens per photo: its own "use this
 * photo", then a save sheet. Here the viewfinder is a <video> on the page and
 * the shutter and a pose are the whole thing.
 *
 * The cost is the phone's processing. A camera app runs HDR, night mode and
 * noise reduction on its stills; a frame off the video stream gets far less of
 * that. In good light at the 1600px progress.js keeps, the difference is hard
 * to see; in a dim room it is grainier. Where the browser can take a real still
 * (ImageCapture, on Android Chrome) it does, which gets back most of it.
 */

/** Self-timer choices, seconds: off, a quick one, and long enough to walk back into frame. */
export const TIMERS = [0, 3, 10];

/** Whether this browser can show a camera in the page at all. */
export function supported() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Ask for the biggest frame the camera has. `ideal`, not `exact`: a camera
 * that can't do 4096 gives its best rather than refusing.
 */
export function constraints(facing, { audio = false } = {}) {
  return {
    audio,
    video: audio
      // Video: a phone-sized frame, not the sensor's biggest. A 4K stream would
      // make a 15-second clip tens of megabytes.
      ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } }
      : { facingMode: facing, width: { ideal: 4096 }, height: { ideal: 4096 } },
  };
}

export function open(facing, options) {
  return navigator.mediaDevices.getUserMedia(constraints(facing, options));
}

// ---- video clips (Messages) ------------------------------------------------------
//
// Recorded from the same in-page stream as the stills, so a clip never passes
// through the phone's camera app or its gallery either.

/** Longest clip, seconds. Short is the point, and it keeps uploads small. */
export const VIDEO_MAX_S = 15;
/** About 4–5 MB for a full clip, sound included. */
const VIDEO_BITRATE = 2_000_000;

/** Whether this browser can record the stream at all. */
export function canRecord() {
  return typeof globalThis.MediaRecorder === 'function';
}

/**
 * The container to record into: MP4 where the browser can (Safari only does
 * MP4, and it plays everywhere), else WebM (Android Chrome).
 */
export function recorderType() {
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return candidates.find((t) => globalThis.MediaRecorder?.isTypeSupported?.(t)) ?? '';
}

/** The file extension a recorded type is stored under. */
export function extensionFor(type) {
  return /mp4/i.test(type ?? '') ? 'mp4' : 'webm';
}

/**
 * Start recording. Returns { stop(), done } where both resolve to the clip as
 * a Blob; it stops on its own at VIDEO_MAX_S.
 */
export function record(stream, { maxMs = VIDEO_MAX_S * 1000 } = {}) {
  const type = recorderType();
  const recorder = new globalThis.MediaRecorder(stream, {
    ...(type ? { mimeType: type } : {}),
    videoBitsPerSecond: VIDEO_BITRATE,
  });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };

  const done = new Promise((resolve, reject) => {
    recorder.onstop = () => {
      if (!chunks.length) { reject(new Error('The camera recorded nothing.')); return; }
      const kind = String(recorder.mimeType || type || 'video/webm').split(';')[0];
      resolve(new Blob(chunks, { type: kind }));
    };
    recorder.onerror = (event) => reject(event?.error ?? new Error('Recording failed.'));
  });

  const limit = setTimeout(() => stop(), maxMs);
  function stop() {
    clearTimeout(limit);
    if (recorder.state !== 'inactive') recorder.stop();
    return done;
  }

  recorder.start(250);
  return { stop, done };
}

/** Stop every track, which is what turns the camera light off. */
export function close(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

/**
 * One still. The camera's own photo where the browser offers it, else the
 * frame on screen at the size the stream delivers. Saved the way the scene
 * looks, not mirrored: the preview is mirrored for the front camera only so
 * moving left moves left.
 */
export async function still(stream, video) {
  const track = stream?.getVideoTracks?.()[0];
  if (track && typeof globalThis.ImageCapture === 'function') {
    try {
      return await new globalThis.ImageCapture(track).takePhoto();
    } catch { /* some cameras refuse a still mid-stream: the frame below is the fallback */ }
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('The camera gave no picture.'))),
    'image/jpeg', 0.92,
  ));
}

/**
 * The words for a camera that wouldn't open, from the browser's error name.
 * A chat photo never offers the phone camera: its app keeps a copy in the
 * gallery, which is the one thing a message photo mustn't do.
 */
export function problem(error, purpose = 'progress') {
  const chat = purpose === 'chat';
  if (error?.name === 'NotAllowedError') {
    return chat ? 'Camera access is off for Plates. Allow it in the browser settings.'
      : 'Camera access is off for Plates. Allow it in the browser settings, or use the phone camera.';
  }
  if (error?.name === 'NotFoundError') return 'No camera found on this device.';
  return chat ? 'The camera wouldn’t start. Close it and try again.'
    : 'The camera wouldn’t start. Use the phone camera instead.';
}
