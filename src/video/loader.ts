import { setState } from '../state';
import { t } from '../i18n';

let currentObjectUrl: string | null = null;

export function clearVideo(): void {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  (document.getElementById('src') as HTMLVideoElement).src = '';
}

export async function loadVideo(file: File, onBeforeLoad?: () => void): Promise<void> {
  onBeforeLoad?.();

  const video = document.getElementById('src') as HTMLVideoElement;

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  const url = URL.createObjectURL(file);
  currentObjectUrl = url;
  video.src = url;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error(t('errors.video_load')));
  });

  // Some containers (notably MediaRecorder WebMs and certain MP4s) report
  // duration as Infinity or 0 on loadedmetadata. Force the browser to walk
  // to the end so it computes the real duration, then seek back to 0.
  await ensureFiniteDuration(video);

  const fps = await detectFps(video);

  await seekTo(video, 0);

  const totalFrames = Math.floor(video.duration * fps);

  // Cap processing resolution at 1920px long edge. Decoding cost stays the
  // same (browser always decodes natively), but every frame readback,
  // template-matching pass, and overlay paint becomes cheaper — most of the
  // visible "lag" when scrubbing 4K video comes from the per-frame readback
  // and downstream work, not the decode itself.
  const { w: procW, h: procH } = capLongEdge(video.videoWidth, video.videoHeight, 1920);

  setState({
    video: {
      fps,
      width: procW,
      height: procH,
      nativeW: video.videoWidth,
      nativeH: video.videoHeight,
      totalFrames,
      src: url,
    },
    frameIdx: 0,
    zoom: 1,
    pan: { x: 0, y: 0 },
    phase: 'navigate',
    status: t('status.loaded', {
      name: file.name,
      w: procW,
      h: procH,
      n: totalFrames,
      fps: fps.toFixed(1),
    }),
  });
}

// Caps the longest edge at `maxEdge` while preserving aspect ratio. Returns
// the original dimensions if both edges are already within the cap. Rounds
// to even integers — some downstream paths (e.g. WebGPU's bytesPerRow align)
// behave better on even widths.
function capLongEdge(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { w, h };
  const scale = maxEdge / long;
  const nw = Math.max(2, Math.round((w * scale) / 2) * 2);
  const nh = Math.max(2, Math.round((h * scale) / 2) * 2);
  return { w: nw, h: nh };
}

// Forces the browser to resolve a real duration for containers that report
// Infinity/0 on loadedmetadata (MediaRecorder WebMs, some MP4s). Seeks far
// past the end — the browser clamps currentTime to the real duration and
// fires durationchange with the resolved value.
async function ensureFiniteDuration(video: HTMLVideoElement): Promise<void> {
  if (isFinite(video.duration) && video.duration > 0) return;
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      video.removeEventListener('durationchange', onChange);
      resolve();
    };
    const onChange = (): void => {
      if (isFinite(video.duration) && video.duration > 0) finish();
    };
    video.addEventListener('durationchange', onChange);
    video.currentTime = 1e9;
    setTimeout(finish, 3000);
  });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise(resolve => {
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = time;
  });
}

async function detectFps(video: HTMLVideoElement): Promise<number> {
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    try { return await detectFpsRVFC(video); } catch { /* fall through */ }
  }
  return 30;
}

const COMMON_FPS = [24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120, 240];

function snapFps(fps: number): number {
  return COMMON_FPS.reduce((prev, cur) =>
    Math.abs(cur - fps) < Math.abs(prev - fps) ? cur : prev
  );
}

function detectFpsRVFC(video: HTMLVideoElement): Promise<number> {
  return new Promise((resolve, reject) => {
    const N = 10;
    const timestamps: number[] = [];
    let rafId = 0;
    let settled = false;

    const settle = (result: number | Error) => {
      if (settled) return;
      settled = true;
      video.cancelVideoFrameCallback(rafId);
      video.pause();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const onFrame = (now: DOMHighResTimeStamp, _meta: VideoFrameCallbackMetadata) => {
      timestamps.push(now);
      if (timestamps.length < N) {
        rafId = video.requestVideoFrameCallback(onFrame);
        return;
      }
      let sum = 0;
      for (let i = 1; i < timestamps.length; i++) sum += timestamps[i] - timestamps[i - 1];
      const avg = sum / (timestamps.length - 1);
      if (avg <= 0) { settle(new Error('bad delta')); return; }
      settle(snapFps(1000 / avg));
    };

    rafId = video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => settle(new Error('play failed')));

    setTimeout(() => settle(new Error('timeout')), 5000);
  });
}
