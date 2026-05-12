import { setState } from '../state';
import { t } from '../i18n';

let currentObjectUrl: string | null = null;

export type VideoMeta = {
  fps: number;
  nativeW: number;
  nativeH: number;
  duration: number;
  name: string;
  url: string;
};

export function clearVideo(): void {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  (document.getElementById('src') as HTMLVideoElement).src = '';
}

export async function loadVideoMeta(file: File): Promise<VideoMeta> {
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

  // Probe the actual rendered frame dimensions. For files with rotation
  // metadata (e.g. portrait phone videos), some browsers report the
  // pre-rotation size in videoWidth/Height while the decoded frame
  // (what drawImage / createImageBitmap actually produces) is rotated.
  // Trusting the bitmap here keeps the entire pipeline (display, tracking,
  // bbox/origin coords) in one consistent coordinate system.
  const { w, h } = await probeFrameSize(video);

  return { fps, nativeW: w, nativeH: h, duration: video.duration, name: file.name, url };
}

export function applyVideoSettings(meta: VideoMeta, maxLongEdge: number): void {
  const { w: procW, h: procH } = capLongEdge(meta.nativeW, meta.nativeH, maxLongEdge);
  const totalFrames = Math.floor(meta.duration * meta.fps);

  setState({
    video: {
      fps: meta.fps,
      width: procW,
      height: procH,
      // Native dims are the *display* dims (uncapped). These are what the
      // FrameCache bitmaps and drawImage sample from — keeping them post-
      // rotation means src rects line up with rotated phone-recorded videos.
      nativeW: meta.nativeW,
      nativeH: meta.nativeH,
      totalFrames,
      src: meta.url,
    },
    frameIdx: 0,
    zoom: 1,
    pan: { x: 0, y: 0 },
    phase: 'navigate',
    status: t('status.loaded', {
      name: meta.name,
      w: procW,
      h: procH,
      n: totalFrames,
      fps: meta.fps.toFixed(1),
    }),
  });
}

// Caps the longest edge at `maxEdge` while preserving aspect ratio. Returns
// the original dimensions if both edges are already within the cap. Rounds
// to even integers — some downstream paths (e.g. WebGPU's bytesPerRow align)
// behave better on even widths.
export function capLongEdge(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { w, h };
  const scale = maxEdge / long;
  const nw = Math.max(2, Math.round((w * scale) / 2) * 2);
  const nh = Math.max(2, Math.round((h * scale) / 2) * 2);
  return { w: nw, h: nh };
}

async function probeFrameSize(video: HTMLVideoElement): Promise<{ w: number; h: number }> {
  // Preferred: WebCodecs VideoFrame exposes displayWidth/displayHeight
  // (post-rotation, the dimensions the video is meant to be presented at),
  // which is exactly what we need for portrait phone videos whose
  // videoWidth/Height report the pre-rotation codec dims.
  const VF = (globalThis as any).VideoFrame;
  if (typeof VF === 'function') {
    try {
      const vf = new VF(video);
      const w = vf.displayWidth ?? vf.codedWidth;
      const h = vf.displayHeight ?? vf.codedHeight;
      vf.close();
      if (w > 0 && h > 0) return { w, h };
    } catch { /* fall through */ }
  }
  try {
    const bm = await createImageBitmap(video);
    const w = bm.width;
    const h = bm.height;
    bm.close();
    if (w > 0 && h > 0) return { w, h };
  } catch { /* fall through */ }
  return { w: video.videoWidth, h: video.videoHeight };
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
