/**
 * Coordinate systems:
 *   Original frame  (fw × fh)  — raw video dimensions; origin/bbox stored here
 *   Display         (dw × dh)  — canvas CSS pixels; mouse events arrive here
 *   Viewport        (vw × vh)  — slice of the original frame currently visible
 *                               vw = fw/zoom, vh = fh/zoom
 *
 * Conversion display → original:
 *   origX = pan.x + (dx / dw) * vw
 *   origY = pan.y + (dy / dh) * vh
 */

import { getState, setState, type AppState } from '../state';

const MAX_DISP_W = 1280;
const MAX_DISP_H = 720;
const AXIS_LEN = 40;

export function fitDisplaySize(fw: number, fh: number): { dw: number; dh: number } {
  const s = Math.min(MAX_DISP_W / fw, MAX_DISP_H / fh, 1);
  return { dw: Math.round(fw * s), dh: Math.round(fh * s) };
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

export function render(canvas: HTMLCanvasElement, source: CanvasImageSource, s: AppState): void {
  if (!s.video) return;
  const ctx = canvas.getContext('2d')!;
  const { dw, dh } = fitDisplaySize(s.video.width, s.video.height);
  if (canvas.width !== dw || canvas.height !== dh) {
    canvas.width = dw;
    canvas.height = dh;
  }
  const vw = s.video.width / s.zoom;
  const vh = s.video.height / s.zoom;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, s.pan.x, s.pan.y, vw, vh, 0, 0, dw, dh);
  drawAxes(ctx, s, dw, dh);
}

function drawAxes(ctx: CanvasRenderingContext2D, s: AppState, dw: number, dh: number): void {
  if (!s.origin || !s.video) return;
  const vw = s.video.width / s.zoom;
  const vh = s.video.height / s.zoom;
  const ox = ((s.origin.x - s.pan.x) / vw) * dw;
  const oy = ((s.origin.y - s.pan.y) / vh) * dh;

  ctx.strokeStyle = 'rgb(0, 220, 220)';
  ctx.fillStyle   = 'rgb(0, 220, 220)';
  ctx.lineWidth   = 2;

  // X axis →
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + AXIS_LEN, oy); ctx.stroke();
  arrowhead(ctx, ox + AXIS_LEN, oy, 0);
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText('X', ox + AXIS_LEN + 4, oy + 5);

  // Y axis ↑ (up = positive, matches CLI's y-flip)
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - AXIS_LEN); ctx.stroke();
  arrowhead(ctx, ox, oy - AXIS_LEN, -Math.PI / 2);
  ctx.fillText('Y', ox + 4, oy - AXIS_LEN - 4);

  // origin dot
  ctx.beginPath(); ctx.arc(ox, oy, 3, 0, Math.PI * 2); ctx.fill();
}

function arrowhead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number): void {
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

export function attachZoomPan(canvas: HTMLCanvasElement): void {
  let dragging = false;
  let dragStart = { mx: 0, my: 0, px: 0, py: 0 };

  // Wheel → zoom toward cursor
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    zoomAt(dx, dy, e.deltaY < 0 ? 1.15 : 1 / 1.15, canvas.width, canvas.height);
  }, { passive: false });

  // Drag → pan
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
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

  // Keyboard zoom/pan
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
        const pan = clampPan(s.pan.x - panStep.x, s.pan.y, s.zoom, s.video.width, s.video.height);
        setState({ pan });
        break;
      }
      case 'ArrowRight': case 'l': case 'L': {
        const pan = clampPan(s.pan.x + panStep.x, s.pan.y, s.zoom, s.video.width, s.video.height);
        setState({ pan });
        break;
      }
      case 'ArrowUp': case 'i': case 'I': {
        const pan = clampPan(s.pan.x, s.pan.y - panStep.y, s.zoom, s.video.width, s.video.height);
        setState({ pan });
        break;
      }
      case 'ArrowDown': case 'k': case 'K': {
        const pan = clampPan(s.pan.x, s.pan.y + panStep.y, s.zoom, s.video.width, s.video.height);
        setState({ pan });
        break;
      }
    }
  });
}
