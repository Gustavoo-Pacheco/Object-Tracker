# Step 5 — Phases 2-4: origin, scale, bbox

> **Goal**: Port `set_origin`, `set_scale`, `draw_bbox` from `track.py` to the canvas. After these, the app has everything the tracker needs.

> **Pre-flight (don't skip):** before writing any code in this step, re-read `01-scaffold.md` §1.6.5 (aesthetic guardrails) and §1.7 (i18n discipline — PT-BR only), plus `../PLAN.md` §5 (constraints). Run the anti-patterns checklist against your planned output. If you find purple, `rounded-2xl`, glassmorphism, Inter/Roboto/Space Grotesk, hardcoded user-facing strings, or any other listed violation in your output, revert and redo before committing.

## 5.0 Design questions for the user — ASK BEFORE BUILDING

> **Mandatory pause point.** Three phases (origin, scale, bbox) each have their own UI feedback. Before generating the canvas overlays in §§5.1-5.3 and the panel UIs, present these questions and **wait for answers**. Visual feedback during interaction shapes whether the tool feels precise or sloppy — these aren't minor decisions.

Ask the user:

### Origin (Phase 2)

1. **Crosshair style while choosing the origin.** The default proposal is two thin pink lines crossing the entire canvas (full vertical + full horizontal) following the cursor, with a 5px filled dot at the intersection. Options: (a) full crosshair (proposed), (b) short crosshair — only ~40px around the cursor (less visual noise but harder to align with distant features), (c) crosshair + a 1° rotated tick label showing the current pixel coords as the cursor moves. Recommendation: (a). Pink color matches the CLI tool, easy to spot.

2. **After clicking, before confirming:** should the cursor crosshair stay visible (so the user can see they hit the right spot) or be replaced with the small fixed-position axis indicator (X/Y arrows)? Recommendation: keep the full pink crosshair pinned at the click point until confirmed; show the small axis arrows only after confirm.

### Scale (Phase 3)

3. **Live pixel-distance readout while drawing the scale line.** As the user moves the second point, should the line show its current pixel length? Options: (a) yes, label at midpoint reading "234 px", (b) yes, in the panel sidebar in a numeric readout, (c) only after the line is finalized. Recommendation: (a) AND (b) — both. Inline label is for quick visual feedback; sidebar number is for precision.

4. **Metres input behavior.** Default proposal: text input accepting digits and one decimal point. Options: (a) free text input (proposed), (b) input with up/down spinner buttons (`±0.1` / `±0.01`), (c) input with sensible quick-buttons (`0.1m`, `0.5m`, `1m`, `2m`). Recommendation: (a) plus a placeholder like `Ex: 0.50` to suggest format.

5. **What happens if the user types a stupid value (negative, zero, or text)?** Options: (a) Confirm button disabled until valid; (b) accept anything and show error after click; (c) auto-correct (negate negatives, snap to 0.001 minimum). Recommendation: (a) — Confirm disabled until > 0.

### Bounding box (Phase 4)

6. **Bbox visual while drawing.** Default proposal: green rectangle (2px stroke) updating live as the user drags. Options: (a) plain green outline (proposed), (b) dashed green outline (animated marching-ants), (c) green outline + dimmed overlay outside the box (lets user see "what's inside"). Recommendation: (a) — solid green, clean.

7. **After release, before confirming:** show pixel dimensions (e.g. "84 × 52 px") near the box? Recommendation: yes, small label below the box in `var(--muted)`.

8. **Minimum bbox size.** A bbox under ~4×4 pixels won't track meaningfully. Options: (a) hard minimum of 8×8, refuse to confirm smaller (with error message), (b) warning but allow, (c) auto-expand to 8×8 with a "expanded to minimum size" hint. Recommendation: (a). Show error inline.

### Cross-phase

9. **Phase navigation.** Once the user confirms a phase, can they go back to revise the previous one? Options: (a) one-way: confirm = locked, redo from start, (b) breadcrumb bar at top of panel with clickable past phases, (c) "back" button in the panel always present. Recommendation: (b) — small breadcrumb like `frame ● origin ● scale ● bbox`, past steps clickable.

10. **Showing previously-set values during later phases.** When in phase 4 (bbox), should the user still see the origin axes and the scale line as ghosted overlays? Or hide them to reduce visual noise? Recommendation: keep origin axes visible (small pink/cyan in corner — already designed in step 2), hide the scale line.

After answers, document the chosen approach and proceed with §5.1.

Each phase is its own module under `src/ui/phases/`. They share a pattern:
- Mount sidebar UI describing what to do.
- Install canvas mouse/keyboard handlers specific to the phase.
- On confirm, write to state and advance `phase`.
- On unmount, remove all listeners.

## 5.1 Phase 2 — `origin.ts`

### Behavior

Cursor draws a pink crosshair (full vertical + full horizontal line + dot at intersection) over the entire canvas. Clicking fixes it. Pressing Enter confirms; the click position becomes the origin in original-frame coords.

### Implementation notes

- The pink color matches `track.py`: hot pink `(180, 105, 255)` BGR = CSS `rgb(255, 105, 180)`.
- Lines extend full width/height of the canvas (not just `AXIS_LEN`).
- Two states: cursor-hovering (preview) and click-fixed (with "0,0" label).

```ts
import { getState, setState } from '../../state';
import { dispToOrig } from '../canvas';
import { t } from '../../i18n';

// Pink crosshair = CSS var --pink (defined in styles.css), ~ rgb(244, 114, 182)
const PINK = 'rgb(244, 114, 182)';

export function mountOrigin(panel: HTMLElement, canvas: HTMLCanvasElement) {
  panel.innerHTML = `
    <h2>${t('phase2.title')}</h2>
    <p>${t('phase2.instruction')}</p>
    <p class="hint">Enter / R / Esc</p>
    <button id="confirm-origin" disabled>${t('phase2.confirm')}</button>
    <button class="secondary" id="redo-origin">${t('phase3.redo')}</button>
  `;

  let cursor: { x: number; y: number } | null = null;
  let clicked: { x: number; y: number } | null = null;

  const onMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    triggerRender();  // forces canvas redraw via state poke
  };
  const onClick = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    clicked = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    (panel.querySelector('#confirm-origin') as HTMLButtonElement).disabled = false;
    triggerRender();
  };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('click', onClick);

  // Provide an overlay-painter to canvas.ts via a registry (see 5.4)
  setOverlayPainter((ctx, dw, dh) => {
    const pt = clicked ?? cursor;
    if (!pt) return;
    ctx.strokeStyle = PINK;
    ctx.fillStyle = PINK;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pt.x, 0); ctx.lineTo(pt.x, dh); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, pt.y); ctx.lineTo(dw, pt.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText('Y', pt.x + 6, 18);
    ctx.fillText('X', dw - 22, pt.y - 6);
    if (clicked) ctx.fillText('0,0', pt.x + 6, pt.y - 8);
  });

  panel.querySelector('#confirm-origin')!.addEventListener('click', () => {
    if (!clicked) return;
    const s = getState();
    const orig = dispToOrig(clicked.x, clicked.y, s, canvas.width, canvas.height);
    setState({
      origin: { x: Math.round(orig.x), y: Math.round(orig.y) },
      phase: 'scale',
    });
  });
  panel.querySelector('#redo-origin')!.addEventListener('click', () => {
    clicked = null;
    (panel.querySelector('#confirm-origin') as HTMLButtonElement).disabled = true;
    triggerRender();
  });

  return () => {
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('click', onClick);
    clearOverlayPainter();
  };
}
```

## 5.2 Phase 3 — `scale.ts`

Two-click line + numeric input for metres. `set_scale` in `track.py` uses two states:
- `'line'` — clicking adds points 1 then 2.
- `'text'` — input field accepts metres, R goes back to line.

### UI in sidebar

```
STEP 3: SET SCALE
1) Click two points with a known distance.
2) Enter the distance in metres.
[ pixels: 0.0 ]
[ metres: ___________ ]
[ Confirm scale ]
[ Redo line ]
```

### Canvas overlay

- After point 1: pink dot at point 1.
- After point 2: pink line + dot at each end + "X.X px" label at midpoint.

### Math

```ts
const dpx = Math.hypot(p2.x - p1.x, p2.y - p1.y); // display pixels
// convert both endpoints to original-frame coords first, THEN measure
const o1 = dispToOrig(p1.x, p1.y, s, dw, dh);
const o2 = dispToOrig(p2.x, p2.y, s, dw, dh);
const opx = Math.hypot(o2.x - o1.x, o2.y - o1.y);  // original-frame pixels
const mpp = metres / opx;
setState({ metresPerPixel: mpp, phase: 'bbox' });
```

The `track.py` code is correct: convert to original-frame coords *before* measuring, otherwise the m/px depends on zoom level.

### Input validation

- Metres input accepts only digits, one decimal point. No exponential, no commas.
- Must be > 0. Disable confirm until a positive number is parsed.
- Show in panel: "Resultado: 1234.5 px = 0.50 m → 0.000405 m/px" so the user can sanity-check.

## 5.3 Phase 4 — `bbox.ts`

Click-drag rectangle. R to redo. Enter to confirm.

```ts
let p1: {x:number;y:number} | null = null;
let p2: {x:number;y:number} | null = null;
let drawing = false;

canvas.addEventListener('mousedown', (e) => {
  const r = canvas.getBoundingClientRect();
  p1 = p2 = { x: e.clientX - r.left, y: e.clientY - r.top };
  drawing = true;
});
canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const r = canvas.getBoundingClientRect();
  p2 = { x: e.clientX - r.left, y: e.clientY - r.top };
  triggerRender();
});
window.addEventListener('mouseup', () => { drawing = false; });
```

Overlay: green rectangle (`rgb(0, 255, 0)`).

On confirm, convert both corners to original-frame coords, snap to integer pixels, store as `{x, y, w, h}` with positive width/height (handle drag in any direction).

```ts
const o1 = dispToOrig(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), s, dw, dh);
const o2 = dispToOrig(Math.max(p1.x, p2.x), Math.max(p1.y, p2.y), s, dw, dh);
const x = Math.max(0, Math.round(o1.x));
const y = Math.max(0, Math.round(o1.y));
const w = Math.min(s.video.width  - x, Math.round(o2.x - o1.x));
const h = Math.min(s.video.height - y, Math.round(o2.y - o1.y));
if (w < 4 || h < 4) { /* show error: bbox too small */ return; }
setState({ bbox: { x, y, w, h }, phase: 'tracking' });
```

## 5.4 Overlay painter registry

Multiple modules need to draw over the canvas. Don't pass painters through state — they're not data. Add a tiny module:

```ts
// src/ui/overlay.ts
type Painter = (ctx: CanvasRenderingContext2D, dw: number, dh: number) => void;
let current: Painter | null = null;
export const setOverlayPainter = (p: Painter | null) => { current = p; };
export const clearOverlayPainter = () => { current = null; };
export const getOverlayPainter = () => current;
```

In `canvas.ts` `render()`, after `drawAxes`, call `getOverlayPainter()?.(ctx, dw, dh)`.

## 5.5 Zoom/pan still works

All three phases must keep zoom/pan active. The mouse handlers in this step take left-click; pan should be on right-click drag, or middle-click drag, or hold-Space-drag. Pick one and document it on the canvas as a hint. Recommendation: **hold Space + drag = pan** (matches creative apps users may already know). Wheel still zooms.

## Definition of done

- [ ] Phase 2: pink full-screen crosshair follows cursor; clicking fixes it; "Confirm origin" stores origin in original-frame coords.
- [ ] Phase 3: two-click line, metres input, m/px stored. Sanity readout in sidebar.
- [ ] Phase 4: click-drag green bbox; R redoes; minimum size enforced; bbox stored in original-frame coords.
- [ ] Phase transitions are clean — no leftover event listeners between phases.
- [ ] Zoom/pan continue to work in every phase (right-drag or Space+drag for pan).
- [ ] Esc returns to phase 1 from any of these phases.
- [ ] Commit: `step 5: phases 2-4 origin/scale/bbox`.
