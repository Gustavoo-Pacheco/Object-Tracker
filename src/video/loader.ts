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

  const fps = await detectFps(video);

  await seekTo(video, 0);

  const totalFrames = Math.floor(video.duration * fps);

  setState({
    video: {
      fps,
      width: video.videoWidth,
      height: video.videoHeight,
      totalFrames,
      src: url,
    },
    frameIdx: 0,
    zoom: 1,
    pan: { x: 0, y: 0 },
    phase: 'navigate',
    status: t('status.loaded', {
      name: file.name,
      w: video.videoWidth,
      h: video.videoHeight,
      n: totalFrames,
      fps: fps.toFixed(1),
    }),
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
