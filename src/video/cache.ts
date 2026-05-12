import { getState } from '../state';

export class FrameCache {
  private map = new Map<number, ImageBitmap>();
  private max: number;
  private queue: Promise<ImageBitmap | null> = Promise.resolve(null);

  constructor(max = 60) { this.max = max; }

  get(idx: number): Promise<ImageBitmap | null> {
    if (this.map.has(idx)) {
      const bm = this.map.get(idx)!;
      this.map.delete(idx);
      this.map.set(idx, bm);
      return Promise.resolve(bm);
    }
    const next = this.queue.then(() => this.decode(idx));
    this.queue = next.catch(() => null) as Promise<ImageBitmap | null>;
    return next;
  }

  private decode(idx: number): Promise<ImageBitmap | null> {
    const s = getState();
    if (!s.video) return Promise.resolve(null);
    const video = document.getElementById('src') as HTMLVideoElement;
    const targetTime = idx / s.video.fps;
    // Display bitmaps are always at native (post-rotation) dims so that
    // render()'s sx/sy scaling — which maps processing coords to native
    // pixel space — samples the full frame correctly.
    const targetW = s.video.nativeW;
    const targetH = s.video.nativeH;
    return new Promise(resolve => {
      const onSeeked = () => {
        bitmapAtDisplaySize(video, targetW, targetH)
          .then(bm => {
            if (!bm) { resolve(null); return; }
            if (this.map.size >= this.max) {
              const oldest = this.map.keys().next().value!;
              this.map.get(oldest)!.close();
              this.map.delete(oldest);
            }
            this.map.set(idx, bm);
            resolve(bm);
          })
          .catch(() => resolve(null));
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.currentTime = targetTime;
    });
  }

  clear(): void {
    this.map.forEach(bm => bm.close());
    this.map.clear();
  }
}

// Produces an ImageBitmap whose dimensions match the video's *display* size
// (post-rotation), not the codec size. For files with rotation metadata the
// raw <video> bitmap can come back at codec dims with the rotated content
// pre-squashed into them — drawing it produces a flattened image. We
// re-render via WebCodecs VideoFrame (which respects displayWidth/Height) and
// then snapshot to a correctly-sized bitmap.
async function bitmapAtDisplaySize(
  video: HTMLVideoElement,
  w: number,
  h: number,
): Promise<ImageBitmap | null> {
  const VF = (globalThis as any).VideoFrame;
  if (typeof VF === 'function') {
    try {
      const vf = new VF(video);
      const bm = await createImageBitmap(vf);
      vf.close();
      if (bm.width === w && bm.height === h) return bm;
      // Re-fit to display dims if the bitmap came back at codec size.
      const fitted = await refitBitmap(bm, w, h);
      bm.close();
      return fitted;
    } catch { /* fall through */ }
  }
  try {
    const bm = await createImageBitmap(video);
    if (bm.width === w && bm.height === h) return bm;
    const fitted = await refitBitmap(bm, w, h);
    bm.close();
    return fitted;
  } catch {
    return null;
  }
}

async function refitBitmap(src: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
  const oc: any = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  oc.width = w; oc.height = h;
  const c2 = oc.getContext('2d');
  c2.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
  return await createImageBitmap(oc);
}
