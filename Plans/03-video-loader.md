# Step 3 — Video loader + frame cache

> **Goal**: Upload an mp4 → know its dimensions, fps, and total frames → seek to any frame and get that frame as something the canvas can draw. LRU-cache decoded frames to keep scrubbing snappy.

> **Pre-flight (don't skip):** before writing any code in this step, re-read `01-scaffold.md` §1.7 (i18n discipline — PT-BR only) and `../PLAN.md` §5 (constraints). Status messages and error text go through `t()` and live in `i18n/pt-BR.json` — never hardcoded Portuguese in `.ts` files.

## 3.1 Why this is harder than it looks

Browsers don't expose an "extract frame N" API. We have to:

1. Set `video.currentTime = idx / fps`.
2. Wait for the `seeked` event.
3. Either draw the `<video>` element directly to canvas, or capture an `ImageBitmap`.

This is approximate — `currentTime` doesn't always land on the exact frame the user expects, especially for variable-frame-rate videos. For physics experiment videos (almost always constant fps mp4s) it's fine, but the UI must show the *requested* frame index, not back-compute from `currentTime`.

Also: getting `totalFrames` from a `<video>` element is not directly supported. We compute `Math.floor(duration * fps)` and accept ±1 frame error at the end.

## 3.2 `src/video/loader.ts`

```ts
import { setState, getState } from '../state';

export async function loadVideo(file: File): Promise<void> {
  const video = document.getElementById('src') as HTMLVideoElement;
  const url = URL.createObjectURL(file);
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Falha ao carregar vídeo'));
  });
  // Seek to 0 so the first frame is decoded
  video.currentTime = 0;
  await new Promise<void>(r => { video.onseeked = () => r(); });

  const fps = await detectFps(video, file);
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
    phase: 'navigate',
    status: `${file.name} carregado: ${video.videoWidth}×${video.videoHeight}, ${totalFrames} frames @ ${fps.toFixed(1)} fps`,
  });
}
```

### Detecting fps

There's no direct API. Three options, in order of preference:

1. **WebCodecs `VideoDecoder`** — gives exact frame metadata. Available in Chrome/Edge/Safari 16+, Firefox 130+. Best path.
2. **Heuristic via `requestVideoFrameCallback`** — count callbacks during a 1-second `play()`/`pause()` cycle. Approximate but works everywhere.
3. **Ask the user.** If detection fails, show a "Frame rate (fps)" input in the panel with a default of 30 and a "Detected: ?" hint.

```ts
async function detectFps(video: HTMLVideoElement, file: File): Promise<number> {
  if ('VideoDecoder' in window) {
    try { return await detectFpsWebCodecs(file); } catch { /* fall through */ }
  }
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    return await detectFpsRVFC(video);
  }
  return 30; // fallback; UI will let user override
}
```

Implement `detectFpsWebCodecs` by demuxing the file with `mp4box.js` (small library) to read the track's `samples` and compute fps from sample deltas. If you'd rather not pull in mp4box, skip option 1 and use option 2.

Either way: **expose a manual fps override input in the panel** (step 4), defaulting to detected value. Some users will know their camera's exact fps and want to type 240 or 1000.

## 3.3 `src/video/cache.ts`

LRU mirroring `FrameCache` in `track.py`. Cache `ImageBitmap` (decoded, GPU-friendly) by frame index.

```ts
import { getState } from '../state';

export class FrameCache {
  private map = new Map<number, ImageBitmap>();
  private max: number;
  constructor(max = 60) { this.max = max; }

  async get(idx: number): Promise<ImageBitmap | null> {
    if (this.map.has(idx)) {
      const bm = this.map.get(idx)!;
      this.map.delete(idx); this.map.set(idx, bm); // LRU bump
      return bm;
    }
    const bm = await this.decode(idx);
    if (!bm) return null;
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.get(oldest!)?.close();
      this.map.delete(oldest!);
    }
    this.map.set(idx, bm);
    return bm;
  }

  private async decode(idx: number): Promise<ImageBitmap | null> {
    const s = getState();
    if (!s.video) return null;
    const video = document.getElementById('src') as HTMLVideoElement;
    return new Promise(resolve => {
      const t = idx / s.video!.fps;
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        createImageBitmap(video).then(resolve).catch(() => resolve(null));
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.currentTime = t;
    });
  }

  clear() {
    this.map.forEach(bm => bm.close());
    this.map.clear();
  }
}
```

**Important**: only one `seek` can be in flight at a time on a given `<video>`. If `get(5)` is called while `get(3)` is still pending, the second seek cancels the first. Wrap with a queue:

```ts
private queue: Promise<unknown> = Promise.resolve();
async get(idx: number): Promise<ImageBitmap | null> {
  // serialize decodes
  const next = this.queue.then(() => this.getInternal(idx));
  this.queue = next.catch(() => {});
  return next;
}
```

## 3.4 Wire upload to canvas

In `main.ts`:

```ts
import { loadVideo } from './video/loader';
import { FrameCache } from './video/cache';
import { render } from './ui/canvas';
import { subscribe, getState } from './state';

const cache = new FrameCache();
const file = document.getElementById('file') as HTMLInputElement;
const canvas = document.getElementById('stage') as HTMLCanvasElement;

file.addEventListener('change', async () => {
  if (!file.files?.[0]) return;
  await loadVideo(file.files[0]);
  await renderCurrent();
});

subscribe(async (s) => {
  document.getElementById('status')!.textContent = s.status;
  await renderCurrent();
});

async function renderCurrent() {
  const s = getState();
  if (!s.video) return;
  const bm = await cache.get(s.frameIdx);
  if (bm) render(canvas, bm, s);
}
```

## 3.5 Test scenarios

- Load a 30 fps 1080p mp4 — frame seek to 0, 100, 1000, last frame; should be < 100ms cached.
- Load a 240 fps slow-mo clip — verify fps detection or fallback works.
- Load a webm — verify it plays.
- Try a `.mov` (QuickTime) — Safari handles it natively, Chrome may not. If it fails, fall back to the manual fps input gracefully.
- Drag the same video twice — verify the previous URL is revoked (`URL.revokeObjectURL`) before assigning the new one.

## Definition of done

- [ ] Uploading a video updates `state.video` with correct fps/width/height/totalFrames.
- [ ] `cache.get(idx)` reliably returns the right frame; rapid scrubbing doesn't deadlock.
- [ ] Frame cache caps at 60 entries; `ImageBitmap.close()` is called on eviction.
- [ ] FPS detection works for at least one of WebCodecs or RVFC; manual override input exists.
- [ ] `URL.revokeObjectURL` is called when a new video replaces an old one.
- [ ] Commit: `step 3: video loader + frame cache`.
