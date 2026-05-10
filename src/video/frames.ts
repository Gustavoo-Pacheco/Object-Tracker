// Sequential frame iterator for the loaded <video>: seeks to each frame index,
// awaits the seeked event, then returns RGBA pixels via the WebGPU pipeline
// (with Canvas2D fallback). Designed to be driven by the tracking loop.

import { framePixels } from '../gpu/device';

export type Frame = { idx: number; t: number; pixels: Uint8Array; w: number; h: number };

export async function readFrame(
  video: HTMLVideoElement,
  idx: number,
  fps: number,
): Promise<Frame> {
  const t = idx / fps;
  await seek(video, t);
  const w = video.videoWidth;
  const h = video.videoHeight;
  const pixels = await framePixels(video, w, h);
  return { idx, t, pixels, w, h };
}

// Half a frame at 240 fps — small enough to detect any real index change,
// large enough to absorb floating-point noise from prior seeks.
const SEEK_EPS = 1 / 480;

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    // If we're already on the target frame, resolve immediately.
    // Do NOT wait on requestVideoFrameCallback here: paused videos never
    // composite new frames, so rVFC would never fire and the tracking loop
    // would hang on the very first readFrame().
    if (Math.abs(video.currentTime - time) < SEEK_EPS && video.readyState >= 2) {
      resolve();
      return;
    }
    let done = false;
    const onSeeked = (): void => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
    // Safety: some browsers swallow the seeked event if the new currentTime
    // resolves to the same media time. Resolve after a short grace period.
    setTimeout(() => onSeeked(), 250);
  });
}
