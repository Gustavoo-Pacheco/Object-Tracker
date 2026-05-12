/**
 * Coordinate systems:
 *   Original frame  (fw × fh)  — raw video dimensions; origin/bbox stored here
 *   Display         (dw × dh)  — canvas pixel dimensions; overlay painters work here
 *
 * Conversion display → original:
 *   origX = pan.x + (dx / dw) * vw
 *   origY = pan.y + (dy / dh) * vh
 *
 * Conversion original → display (inverse):
 *   dx = ((ox - pan.x) / vw) * dw
 *   dy = ((oy - pan.y) / vh) * dh
 */

import { getState, setState, type AppState } from '../state';
import { getOverlayPainter } from './overlay';

const FALLBACK_MAX_W = 1280;
const FALLBACK_MAX_H = 720;

function stageAreaSize(): { w: number; h: number } {
  const el = document.getElementById('stage-area');
  if (!el) return { w: FALLBACK_MAX_W, h: FALLBACK_MAX_H };
  const r = el.getBoundingClientRect();
  // During first paint the container can briefly be 0×0; fall back so we
  // don't collapse the canvas to nothing.
  const w = r.width  > 0 ? r.width  : FALLBACK_MAX_W;
  const h = r.height > 0 ? r.height : FALLBACK_MAX_H;
  return { w, h };
}

export function fitDisplaySize(fw: number, fh: number): { dw: number; dh: number } {
  const { w: cw, h: ch } = stageAreaSize();
  const s = Math.min(cw / fw, ch / fh, 1);
  return { dw: Math.max(1, Math.round(fw * s)), dh: Math.max(1, Math.round(fh * s)) };
}

export function dispToOrig(
  dx: number, dy: number,
  s: AppState, dw: number, dh: number
): { x: number; y: number } {
  const vw = s.video!.width / s.zoom;
  const vh = s.video!.height / s.zoom;
  return {
    x: s.pan.x + (dx / dw) * vw,
    y: s.pan.y + (dy / dh) * vh,
  };
}

export function origToDisp(
  ox: number, oy: number,
  s: AppState, dw: number, dh: number
): { x: number; y: number } {
  const vw = s.video!.width / s.zoom;
  const vh = s.video!.height / s.zoom;
  return {
    x: ((ox - s.pan.x) / vw) * dw,
    y: ((oy - s.pan.y) / vh) * dh,
  };
}

// Phases where the user is past setup — show only the live tracking overlay,
// hide the calibration stick and the initial bbox.
const TRACKING_PHASES = new Set<AppState['phase']>(['tracking', 'done']);

export function render(canvas: HTMLCanvasElement, source: CanvasImageSource, s: AppState): void {
  if (!s.video) return;
  const ctx = canvas.getContext('2d')!;
  const { dw, dh } = fitDisplaySize(s.video.width, s.video.height);
  if (canvas.width !== dw || canvas.height !== dh) {
    canvas.width = dw;
    canvas.height = dh;
  }
  // Pin CSS box to buffer dims so aspect ratio is preserved exactly (the
  // stylesheet's max-width/max-height fallback can squash a portrait canvas
  // inside a flex-centered container otherwise).
  const cssW = `${dw}px`;
  const cssH = `${dh}px`;
  if (canvas.style.width !== cssW)  canvas.style.width  = cssW;
  if (canvas.style.height !== cssH) canvas.style.height = cssH;
  const vw = s.video.width / s.zoom;
  const vh = s.video.height / s.zoom;
  ctx.imageSmoothingEnabled = true;
  // drawImage source rect is in the *native* pixel space when sampling from a
  // <video> element, but s.pan / vw / vh live in our (possibly downscaled)
  // processing space. Scale up by native/logical so the same area is sampled.
  const sx = s.video.nativeW / s.video.width;
  const sy = s.video.nativeH / s.video.height;
  ctx.drawImage(source, s.pan.x * sx, s.pan.y * sy, vw * sx, vh * sy, 0, 0, dw, dh);

  const tracking = TRACKING_PHASES.has(s.phase);
  drawAxes(ctx, s, dw, dh, tracking);
  if (!tracking) {
    drawScaleLine(ctx, s, dw, dh);
    drawBbox(ctx, s, dw, dh);
  }
  getOverlayPainter()?.(ctx, dw, dh);
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  s: AppState, dw: number, dh: number,
  _tracking: boolean,
): void {
  if (!s.origin || !s.video) return;
  const { x: ox, y: oy } = origToDisp(s.origin.x, s.origin.y, s, dw, dh);

  const stroke = '#ff0000';
  const solid  = '#ff0000';

  ctx.save();

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.25;
  ctx.beginPath(); ctx.moveTo(0, oy);  ctx.lineTo(dw, oy);  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ox, 0);  ctx.lineTo(ox, dh);  ctx.stroke();

  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = solid;
  ctx.textAlign = 'left';
  ctx.fillText('+X', dw - 22, oy - 5);
  ctx.textAlign = 'center';
  ctx.fillText('+Y', ox + 2, 14);

  ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillText('0', ox + 6, oy - 6);

  ctx.restore();
}

function drawScaleLine(ctx: CanvasRenderingContext2D, s: AppState, dw: number, dh: number): void {
  if (!s.scalePts || !s.video) return;
  const a = origToDisp(s.scalePts[0].x, s.scalePts[0].y, s, dw, dh);
  const b = origToDisp(s.scalePts[1].x, s.scalePts[1].y, s, dw, dh);
  ctx.save();
  ctx.strokeStyle = '#1d4ed8';
  ctx.fillStyle = '#1d4ed8';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(a.x, a.y, 3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawBbox(ctx: CanvasRenderingContext2D, s: AppState, dw: number, dh: number): void {
  if (!s.bbox || !s.video) return;
  const tl = origToDisp(s.bbox.x, s.bbox.y, s, dw, dh);
  const br = origToDisp(s.bbox.x + s.bbox.w, s.bbox.y + s.bbox.h, s, dw, dh);
  ctx.save();
  ctx.strokeStyle = '#008000';
  ctx.fillStyle = '#008000';
  ctx.lineWidth = 2;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  const cx = (tl.x + br.x) / 2;
  const cy = (tl.y + br.y) / 2;
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function clampPan(panX: number, panY: number, zoom: number, fw: number, fh: number) {
  const vw = fw / zoom;
  const vh = fh / zoom;
  return {
    x: Math.max(0, Math.min(panX, fw - vw)),
    y: Math.max(0, Math.min(panY, fh - vh)),
  };
}

function zoomAt(dx: number, dy: number, factor: number, dw: number, dh: number): void {
  const s = getState();
  if (!s.video) return;
  const orig = dispToOrig(dx, dy, s, dw, dh);
  const newZoom = Math.max(1, Math.min(s.zoom * factor, 30));
  const vw = s.video.width / newZoom;
  const vh = s.video.height / newZoom;
  const pan = clampPan(
    orig.x - (dx / dw) * vw,
    orig.y - (dy / dh) * vh,
    newZoom, s.video.width, s.video.height
  );
  setState({ zoom: newZoom, pan });
}

const TOOL_PHASES = new Set(['setup', 'origin', 'scale', 'bbox']);

export function attachZoomPan(canvas: HTMLCanvasElement): void {
  let dragging = false;
  let dragStart = { mx: 0, my: 0, px: 0, py: 0 };
  let spaceHeld = false;

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  window.addEventListener('keydown', e => { if (e.code === 'Space') spaceHeld = true; });
  window.addEventListener('keyup',   e => { if (e.code === 'Space') spaceHeld = false; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const dy = (e.clientY - rect.top)  * (canvas.height / rect.height);
    zoomAt(dx, dy, e.deltaY < 0 ? 1.15 : 1 / 1.15, canvas.width, canvas.height);
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    const phase = getState().phase;
    const inToolPhase = TOOL_PHASES.has(phase);
    // right-click always pans; left-click pans only outside tool phases or when Space held
    const shouldPan = e.button === 2 || (e.button === 0 && (!inToolPhase || spaceHeld));
    if (!shouldPan) return;
    const s = getState();
    dragging = true;
    dragStart = { mx: e.clientX, my: e.clientY, px: s.pan.x, py: s.pan.y };
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const s = getState();
    if (!s.video) return;
    const { dw, dh } = fitDisplaySize(s.video.width, s.video.height);
    const vw = s.video.width / s.zoom;
    const vh = s.video.height / s.zoom;
    const dx = (dragStart.mx - e.clientX) / dw * vw;
    const dy = (dragStart.my - e.clientY) / dh * vh;
    const pan = clampPan(dragStart.px + dx, dragStart.py + dy, s.zoom, s.video.width, s.video.height);
    setState({ pan });
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  window.addEventListener('keydown', (e) => {
    const s = getState();
    if (!s.video) return;
    const { dw, dh } = fitDisplaySize(s.video.width, s.video.height);
    const PAN_PX = 80;
    const vw = s.video.width / s.zoom;
    const vh = s.video.height / s.zoom;
    const panStep = { x: PAN_PX / dw * vw, y: PAN_PX / dh * vh };

    switch (e.key) {
      case '+': case '=':
        zoomAt(dw / 2, dh / 2, 1.15, dw, dh);
        break;
      case '-':
        zoomAt(dw / 2, dh / 2, 1 / 1.15, dw, dh);
        break;
      case 'ArrowLeft': case 'j': case 'J': {
        if (e.key === 'ArrowLeft' && (s.phase === 'navigate' || s.phase === 'done')) break;
        const pan = clampPan(s.pan.x - panStep.x, s.pan.y, s.zoom, s.video.width, s.video.height);
        setState({ pan });
        break;
      }
      case 'ArrowRight': case 'l': case 'L': {
        if (e.key === 'ArrowRight' && (s.phase === 'navigate' || s.phase === 'done')) break;
        const pan = clampPan(s.pan.x + panStep.x, s.pan.y, s.zoom, s.video.width, s.video.height);
        setState({ pan });
        break;
      }
      case 'ArrowUp': case 'i': case 'I': {
        if (e.key === 'ArrowUp' && (s.phase === 'navigate' || s.phase === 'done')) break;
        const pan = clampPan(s.pan.x, s.pan.y - panStep.y, s.zoom, s.video.width, s.video.height);
        setState({ pan });
        break;
      }
      case 'ArrowDown': case 'k': case 'K': {
        if (e.key === 'ArrowDown' && (s.phase === 'navigate' || s.phase === 'done')) break;
        const pan = clampPan(s.pan.x, s.pan.y + panStep.y, s.zoom, s.video.width, s.video.height);
        setState({ pan });
        break;
      }
    }
  });
}
