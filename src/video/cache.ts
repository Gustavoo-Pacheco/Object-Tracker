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
    return new Promise(resolve => {
      const onSeeked = () => {
        createImageBitmap(video)
          .then(bm => {
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
