# Step 2 — State module + canvas renderer

> **Goal**: A single source of truth for app state, and a canvas that renders frames with zoom/pan/axes overlay matching the CLI's behavior.

> **Pre-flight (don't skip):** before writing any code in this step, re-read `01-scaffold.md` §1.6.5 (aesthetic guardrails) and §1.7 (i18n discipline — PT-BR only), plus `../PLAN.md` §5 (constraints). Run the anti-patterns checklist against your planned output. If you find purple, `rounded-2xl`, glassmorphism, Inter/Roboto/Space Grotesk, hardcoded user-facing strings, or any other listed violation in your output, revert and redo before committing.


## 2.1 `src/state.ts`

Single mutable object + a tiny pub/sub. No external state library.

```ts
export type Phase = 'idle' | 'navigate' | 'origin' | 'scale' | 'bbox' | 'tracking' | 'done';

export type Record = [
  number,         // frame index
  number,         // time (s)
  number | null,  // x (m, from origin)
  number | null,  // y (m, flipped)
  number | null,  // vx (m/s)
  number | null,  // vy (m/s)
];

export type AppState = {
  phase: Phase;
  video: { fps: number; width: number; height: number; totalFrames: number; src: string } | null;
  frameIdx: number;
  zoom: number;
  pan: { x: number; y: number };       // top-left of viewport in original-frame coords
  origin: { x: number; y: number } | null;
  metresPerPixel: number | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  startFrame: number | null;
  records: Record[];
  status: string;
};

const state: AppState = {
  phase: 'idle',
  video: null,
  frameIdx: 0,
  zoom: 1,
  pan: { x: 0, y: 0 },
  origin: null,
  metresPerPixel: null,
  bbox: null,
  startFrame: null,
  records: [],
  status: 'Upload a video to begin',
};

type Listener = (s: AppState) => void;
const listeners = new Set<Listener>();

export const getState = () => state;
export const setState = (patch: Partial<AppState>) => {
  Object.assign(state, patch);
  listeners.forEach(l => l(state));
};
export const subscribe = (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn); };
```

Note: this is intentionally simple. If you reach for Redux/Zustand/etc you've over-engineered.

## 2.2 `src/ui/canvas.ts`

The canvas is the heart of the app. It must:

- Render the current frame (passed in as `ImageBitmap` or `HTMLVideoElement`).
- Apply zoom + pan via CSS-pixel-aware transform.
- Draw the axes overlay (origin pink crosshair when set).
- Draw phase-specific overlays (delegated to phase modules in step 5).

### Coordinate systems (write a comment block at the top of the file)

There are three:
- **Original frame** (`fw × fh`): the raw video dimensions. Origin and bbox are stored in these coords.
- **Display** (`dw × dh`): the size of the canvas in CSS pixels. Mouse events arrive in these coords.
- **Viewport** (`vw × vh = fw/zoom × fh/zoom`): the slice of the original frame currently visible.

Conversion:
```ts
function dispToOrig(dx: number, dy: number, s: AppState, dw: number, dh: number) {
  const vw = s.video!.width / s.zoom;
  const vh = s.video!.height / s.zoom;
  return {
    x: s.pan.x + (dx / dw) * vw,
    y: s.pan.y + (dy / dh) * vh,
  };
}
```

### Render loop

```ts
const MAX_DISP_W = 1280;
const MAX_DISP_H = 720;

export function fitDisplaySize(fw: number, fh: number) {
  const s = Math.min(MAX_DISP_W / fw, MAX_DISP_H / fh, 1);
  return { dw: Math.round(fw * s), dh: Math.round(fh * s) };
}

export function render(canvas: HTMLCanvasElement, source: CanvasImageSource, s: AppState) {
  if (!s.video) return;
  const ctx = canvas.getContext('2d')!;
  const { dw, dh } = fitDisplaySize(s.video.width, s.video.height);
  if (canvas.width !== dw || canvas.height !== dh) {
    canvas.width = dw; canvas.height = dh;
  }
  const vw = s.video.width / s.zoom;
  const vh = s.video.height / s.zoom;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, s.pan.x, s.pan.y, vw, vh, 0, 0, dw, dh);
  drawAxes(ctx, s, dw, dh);
}
```

### Axes overlay (matches `_draw_axes` in track.py)

```ts
const AXIS_LEN = 40;
function drawAxes(ctx: CanvasRenderingContext2D, s: AppState, dw: number, dh: number) {
  if (!s.origin || !s.video) return;
  // origin is in original-frame coords — convert to display
  const vw = s.video.width / s.zoom;
  const vh = s.video.height / s.zoom;
  const ox = ((s.origin.x - s.pan.x) / vw) * dw;
  const oy = ((s.origin.y - s.pan.y) / vh) * dh;
  ctx.strokeStyle = 'rgb(0, 220, 220)';
  ctx.fillStyle = 'rgb(0, 220, 220)';
  ctx.lineWidth = 2;

  // X axis
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + AXIS_LEN, oy); ctx.stroke();
  arrowhead(ctx, ox + AXIS_LEN, oy, 0);
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText('X', ox + AXIS_LEN + 4, oy + 5);

  // Y axis (up = positive)
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - AXIS_LEN); ctx.stroke();
  arrowhead(ctx, ox, oy - AXIS_LEN, -Math.PI / 2);
  ctx.fillText('Y', ox + 4, oy - AXIS_LEN - 4);

  // origin dot
  ctx.beginPath(); ctx.arc(ox, oy, 3, 0, Math.PI * 2); ctx.fill();
}

function arrowhead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number) {
  const len = 8;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-len, -len / 2);
  ctx.lineTo(-len,  len / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
```

## 2.3 Zoom/pan handlers

Mouse wheel zooms toward cursor. Drag pans (left mouse button). Keys `+`/`-` zoom from center, `IJKL` and arrows pan by 80 display pixels.

```ts
export function attachZoomPan(canvas: HTMLCanvasElement) {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    zoomAt(dx, dy, e.deltaY < 0 ? 1.15 : 1 / 1.15, canvas.width, canvas.height);
  }, { passive: false });

  // ... drag pan, keyboard handlers (mirror _zoom_pan_keys + _cb_nav)
}

function zoomAt(dx: number, dy: number, factor: number, dw: number, dh: number) {
  const s = getState();
  if (!s.video) return;
  const orig = dispToOrig(dx, dy, s, dw, dh);
  const newZoom = Math.max(1, Math.min(s.zoom * factor, 30));
  const vw = s.video.width / newZoom;
  const vh = s.video.height / newZoom;
  let panX = orig.x - (dx / dw) * vw;
  let panY = orig.y - (dy / dh) * vh;
  panX = Math.max(0, Math.min(panX, s.video.width  - vw));
  panY = Math.max(0, Math.min(panY, s.video.height - vh));
  setState({ zoom: newZoom, pan: { x: panX, y: panY } });
}
```

Match `_clamp_pan` exactly — clamping to `[0, fw - vw]` × `[0, fh - vh]`.

## 2.4 Test harness for this step

Hardcode a test image (not a video) into the canvas. Confirm zoom/pan works smoothly before moving to step 3. A 1920×1080 photo of anything (say `public/test.jpg`) — load it with `createImageBitmap`, call `render` whenever state changes.

## Definition of done

- [ ] `state.ts` exports `getState`, `setState`, `subscribe` and works with TypeScript strict mode.
- [ ] `canvas.ts` renders a test image with correct fit-to-window sizing matching `_disp_size` (max 1280×720).
- [ ] Mouse wheel zoom is smooth and centers on cursor.
- [ ] Drag pan works; arrow/IJKL keyboard pan works (80 px steps).
- [ ] Pan is clamped — you cannot pan past the frame edges.
- [ ] When `origin` is set in state, the pink axes overlay draws at the correct position and stays correct under zoom/pan.
- [ ] Commit: `step 2: state + canvas with zoom/pan/axes`.
