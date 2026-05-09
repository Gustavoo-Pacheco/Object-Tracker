# Step 6 — Tracker (OpenCV.js CSRT)

> **Goal**: Run the CSRT tracker frame-by-frame from `startFrame` to the end, recording `(frameIdx, t, cx, cy)` for each frame. Apply the same NCC + jump validation as `track.py`. Mark lost frames as `null` for later interpolation.

> **Pre-flight (don't skip):** before writing any code in this step, re-read `01-scaffold.md` §1.6.5 (aesthetic guardrails) and §1.7 (i18n discipline — PT-BR only), plus `../PLAN.md` §5 (constraints). Run the anti-patterns checklist against your planned output. If you find purple, `rounded-2xl`, glassmorphism, Inter/Roboto/Space Grotesk, hardcoded user-facing strings, or any other listed violation in your output, revert and redo before committing.


## 6.1 Loading OpenCV.js (lazy)

OpenCV.js is ~10 MB. Don't load it on page open. **The exact trigger** (on tracking-phase entry vs. on video upload in the background) is decided in step 1 §1.0 question 12 — apply the user's answer here.

### `src/tracker/opencv-loader.ts`

```ts
let cvPromise: Promise<typeof window.cv> | null = null;

export function loadOpenCV(): Promise<typeof window.cv> {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/opencv/opencv.js';
    script.async = true;
    script.onload = () => {
      // OpenCV.js sets cv.onRuntimeInitialized
      const cv = (window as any).cv;
      if (cv.then) {
        // Newer builds expose cv as a Promise
        cv.then(resolve);
      } else {
        cv.onRuntimeInitialized = () => resolve(cv);
      }
    };
    script.onerror = () => reject(new Error('Falha ao carregar OpenCV.js'));
    document.head.appendChild(script);
  });
  return cvPromise;
}
```

Show a loading indicator: "Carregando OpenCV (~10 MB)..." with a spinner. Cache works on repeat visits because Vercel/Netlify serve `opencv.js` and `opencv_js.wasm` with `Cache-Control: public, max-age=31536000, immutable` by default for hashed assets — but OpenCV's WASM has a fixed name, so add explicit headers in `vercel.json`/`netlify.toml`:

```json
// vercel.json
{
  "headers": [
    { "source": "/opencv/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] }
  ]
}
```

## 6.2 Wrapping CSRT

OpenCV.js exposes `cv.TrackerCSRT.create()`. Same API as Python — `init(image, bbox)` then `update(image)` returning `[ok, bbox]`.

```ts
// src/tracker/csrt.ts
import type { Mat, Rect, TrackerCSRT } from 'opencv-types';

export class CsrtTracker {
  private tracker: TrackerCSRT;
  private cv: any;
  constructor(cv: any) {
    this.cv = cv;
    this.tracker = new cv.TrackerCSRT();
  }
  init(frameMat: Mat, bbox: { x: number; y: number; w: number; h: number }) {
    const rect = new this.cv.Rect(bbox.x, bbox.y, bbox.w, bbox.h);
    this.tracker.init(frameMat, rect);
  }
  update(frameMat: Mat): { ok: boolean; bbox: { x: number; y: number; w: number; h: number } } {
    const out = this.tracker.update(frameMat);
    // OpenCV.js's update returns either { found, bbox } or [bool, bbox] depending on build version.
    // Test once and adapt; abstract here.
    if (Array.isArray(out)) {
      const [ok, rect] = out;
      return { ok, bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
    }
    const rect = out.bbox ?? out;
    return { ok: out.found ?? true, bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  }
  delete() { this.tracker.delete(); }
}
```

> ⚠️ **Verify the TrackerCSRT API surface against the actual OpenCV.js version vendored in step 1.** The contrib trackers have changed signature between 4.5 / 4.7 / 4.10. If `cv.TrackerCSRT` is undefined, the build doesn't include contrib modules and you'll need to rebuild OpenCV.js with the contrib flag, or use a community build like `opencv.js` from `https://github.com/TechStark/opencv-js` which ships contrib trackers.

If contrib is unavailable, fall back to **`cv.TrackerKCF`** as a v1 stopgap and document the gap loudly. Output schema is identical.

## 6.3 Frame → cv.Mat conversion

```ts
function imageBitmapToMat(cv: any, bm: ImageBitmap): any {
  const c = new OffscreenCanvas(bm.width, bm.height);
  const cx = c.getContext('2d')!;
  cx.drawImage(bm, 0, 0);
  const data = cx.getImageData(0, 0, bm.width, bm.height);
  const mat = cv.matFromImageData(data); // RGBA
  // CSRT expects 3-channel BGR
  const bgr = new cv.Mat();
  cv.cvtColor(mat, bgr, cv.COLOR_RGBA2BGR);
  mat.delete();
  return bgr;
}
```

**Always `delete()` Mats.** OpenCV.js does not garbage-collect WASM memory. Every `Mat` you create must be deleted, or the page leaks ~6 MB per frame and crashes after a few minutes on long videos.

Pattern:

```ts
const mat = imageBitmapToMat(cv, bm);
try {
  const { ok, bbox } = tracker.update(mat);
  // ... use result
} finally {
  mat.delete();
}
```

## 6.4 Validation (port of `_validate`)

```ts
// src/tracker/validate.ts
export type ValidateOpts = { nccThreshold: number; maxJumpRatio: number };

export function validate(
  frameMat: any,
  bbox: { x: number; y: number; w: number; h: number },
  prev: { cx: number; cy: number } | null,
  template: any,             // cv.Mat (grayscale)
  fw: number, fh: number,
  cv: any,
  opts: ValidateOpts,
): { valid: boolean; score: number } {
  const { x, y, w, h } = bbox;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > fw || y + h > fh) {
    return { valid: false, score: 0 };
  }
  if (prev) {
    const cx = x + w / 2, cy = y + h / 2;
    const dist = Math.hypot(cx - prev.cx, cy - prev.cy);
    if (dist > Math.hypot(fw, fh) * opts.maxJumpRatio) return { valid: false, score: 0 };
  }
  if (template && w >= 4 && h >= 4) {
    const region = frameMat.roi(new cv.Rect(x, y, w, h));
    const gray = new cv.Mat();
    cv.cvtColor(region, gray, cv.COLOR_BGR2GRAY);
    const resized = new cv.Mat();
    cv.resize(template, resized, new cv.Size(gray.cols, gray.rows));
    const result = new cv.Mat();
    cv.matchTemplate(gray, resized, result, cv.TM_CCOEFF_NORMED);
    const score = result.data32F[0];
    region.delete(); gray.delete(); resized.delete(); result.delete();
    return { valid: score >= opts.nccThreshold, score };
  }
  return { valid: true, score: 1 };
}
```

Defaults match `track.py`: `nccThreshold = 0.35`, `maxJumpRatio = 0.40`. Expose these in the panel as advanced settings (collapsed by default).

## 6.5 Tracking loop

```ts
// src/tracker/run.ts
import { getState, setState } from '../state';
import { CsrtTracker } from './csrt';
import { validate } from './validate';
import { t } from '../i18n';

export async function runTracking(cv: any, cache: FrameCache) {
  const s = getState();
  if (!s.video || !s.bbox || s.startFrame == null) return;
  const { fps, width: fw, height: fh, totalFrames } = s.video;

  // Init tracker on start frame
  const startBm = await cache.get(s.startFrame);
  if (!startBm) throw new Error('Start frame missing');
  const startMat = imageBitmapToMat(cv, startBm);

  const tracker = new CsrtTracker(cv);
  tracker.init(startMat, s.bbox);

  // Extract grayscale template
  const tplBgr = startMat.roi(new cv.Rect(s.bbox.x, s.bbox.y, s.bbox.w, s.bbox.h));
  const template = new cv.Mat();
  cv.cvtColor(tplBgr, template, cv.COLOR_BGR2GRAY);
  tplBgr.delete();

  const records: Record[] = [];
  let prev = { cx: s.bbox.x + s.bbox.w / 2, cy: s.bbox.y + s.bbox.h / 2 };

  // First frame is the init frame — record it as valid
  records.push([s.startFrame, +(s.startFrame / fps).toFixed(4), prev.cx, prev.cy, null, null]);
  startMat.delete();

  for (let i = s.startFrame + 1; i < totalFrames; i++) {
    const bm = await cache.get(i);
    if (!bm) { records.push([i, +(i / fps).toFixed(4), null, null, null, null]); continue; }
    const mat = imageBitmapToMat(cv, bm);
    try {
      const { ok, bbox } = tracker.update(mat);
      let valid = false;
      if (ok) {
        const v = validate(mat, bbox, prev, template, fw, fh, cv, { nccThreshold: 0.35, maxJumpRatio: 0.40 });
        valid = v.valid;
      }
      const t = +(i / fps).toFixed(4);
      if (valid) {
        const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
        prev = { cx, cy };
        records.push([i, t, cx, cy, null, null]);
      } else {
        records.push([i, t, null, null, null, null]);
      }
    } finally {
      mat.delete();
    }
    // progress update every 10 frames
    if (i % 10 === 0) {
      setState({ status: t('status.tracking', { done: i - s.startFrame, total: totalFrames - s.startFrame }) });
      await yieldToUI();
    }
  }

  template.delete();
  tracker.delete();
  setState({ records, phase: 'done', status: t('status.done') });
}

const yieldToUI = () => new Promise(r => setTimeout(r, 0));
```

## 6.6 Why not Web Workers?

On paper, Web Workers would be the right place to run OpenCV.js — they keep the UI responsive. In practice, OpenCV.js inside a Worker requires (a) a worker-friendly build, and (b) transferring `ImageBitmap` across the postMessage boundary. It's doable but doubles the integration complexity.

**v1 decision**: run on the main thread, yield to UI every 10 frames. The page stays responsive enough. **v2**: move to a Worker once the rest is stable.

## 6.7 UI during tracking

```
STEP 5: TRACKING
[████████░░] 312 / 600
Lost frames: 4
Elapsed: 12.3s
[ Cancel ]
```

Make Cancel actually work — set a flag in state, check it each loop iteration, clean up Mats, restore phase to `bbox` so the user can adjust and retry.

## Definition of done

- [ ] `cv.TrackerCSRT` (or KCF fallback with a visible warning) tracks across the video.
- [ ] Frames where the tracker fails or the validation rejects → `null` placeholders in `records`.
- [ ] No memory leaks: tracking a 1000-frame video twice in a row does not OOM the tab. Verify in DevTools Memory profiler.
- [ ] Progress updates visibly every 10 frames; UI doesn't freeze.
- [ ] Cancel button works at any point and cleans up cleanly.
- [ ] Records array has length = `totalFrames - startFrame`.
- [ ] Commit: `step 6: csrt tracker with validation`.
