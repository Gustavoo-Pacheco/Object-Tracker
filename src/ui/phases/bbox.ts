import { getState, setState, triggerRender } from '../../state';
import { dispToOrig } from '../canvas';
import { setOverlayPainter, clearOverlayPainter } from '../overlay';
import { t } from '../../i18n';

const GREEN = '#4ade80';
const MIN_PX = 8;

type Pt = { x: number; y: number };

export function mountBbox(panel: HTMLElement, canvas: HTMLCanvasElement): () => void {
  panel.innerHTML = `
    <h2>${t('phase4.title')}</h2>
    <p class="hint">${t('phase4.instruction')}</p>
    <div id="bbox-size" class="phase-readout" style="display:none"></div>
    <p id="bbox-error" class="phase-error" style="display:none">${t('errors.bbox_too_small')}</p>
    <div class="phase-actions">
      <button id="confirm-bbox" disabled>${t('phase4.confirm')}</button>
      <button class="secondary" id="redo-bbox">${t('phase4.redo')}</button>
    </div>
  `;

  let p1: Pt | null = null;
  let p2: Pt | null = null;
  let drawing = false;

  const sizeEl    = panel.querySelector('#bbox-size')    as HTMLElement;
  const errorEl   = panel.querySelector('#bbox-error')   as HTMLElement;
  const confirmBtn = panel.querySelector('#confirm-bbox') as HTMLButtonElement;

  function canvasPt(e: MouseEvent): Pt {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function dispSize(): { w: number; h: number } | null {
    if (!p1 || !p2) return null;
    return {
      w: Math.abs(p2.x - p1.x),
      h: Math.abs(p2.y - p1.y),
    };
  }

  function updateUI(): void {
    const sz = dispSize();
    if (!sz) return;
    sizeEl.textContent = `${Math.round(sz.w)} × ${Math.round(sz.h)} px`;
    sizeEl.style.display = '';
    const tooSmall = sz.w < MIN_PX || sz.h < MIN_PX;
    errorEl.style.display = tooSmall ? '' : 'none';
    confirmBtn.disabled = tooSmall;
  }

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    p1 = p2 = canvasPt(e);
    drawing = true;
    confirmBtn.disabled = true;
    sizeEl.style.display = 'none';
    errorEl.style.display = 'none';
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!drawing) return;
    p2 = canvasPt(e);
    triggerRender();
  };

  const onMouseUp = (): void => {
    if (!drawing) return;
    drawing = false;
    updateUI();
    triggerRender();
  };

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  setOverlayPainter((ctx, _dw, _dh) => {
    if (!p1 || !p2) return;
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);
    ctx.save();
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    if (!drawing && w > 0 && h > 0) {
      const label = `${Math.round(w)} × ${Math.round(h)} px`;
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(74, 222, 128, 0.7)';
      ctx.fillText(label, x, y + h + 14);
    }
    ctx.restore();
  });

  confirmBtn.addEventListener('click', () => {
    if (!p1 || !p2) return;
    const s = getState();
    const dw = canvas.width;
    const dh = canvas.height;
    const o1 = dispToOrig(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), s, dw, dh);
    const o2 = dispToOrig(Math.max(p1.x, p2.x), Math.max(p1.y, p2.y), s, dw, dh);
    const x = Math.max(0, Math.round(o1.x));
    const y = Math.max(0, Math.round(o1.y));
    const bw = Math.min(s.video!.width  - x, Math.round(o2.x - o1.x));
    const bh = Math.min(s.video!.height - y, Math.round(o2.y - o1.y));
    if (bw < 4 || bh < 4) return;
    setState({ bbox: { x, y, w: bw, h: bh }, phase: 'setup' });
  });

  panel.querySelector('#redo-bbox')!.addEventListener('click', () => {
    p1 = p2 = null;
    drawing = false;
    sizeEl.style.display = 'none';
    errorEl.style.display = 'none';
    confirmBtn.disabled = true;
    triggerRender();
  });

  const keyHandler = (e: KeyboardEvent): void => {
    if (getState().phase !== 'bbox') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') (panel.querySelector('#redo-bbox') as HTMLButtonElement).click();
    if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
    if (e.key === 'Escape') setState({ phase: 'setup' });
  };
  window.addEventListener('keydown', keyHandler);

  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keydown', keyHandler);
    clearOverlayPainter();
    p1 = p2 = null;
    drawing = false;
  };
}
