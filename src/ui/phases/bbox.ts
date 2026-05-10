import { getState, setState, triggerRender } from '../../state';
import { dispToOrig } from '../canvas';
import { setOverlayPainter, clearOverlayPainter } from '../overlay';
import { t } from '../../i18n';

const GREEN = '#008000';
const MIN_PX = 8;

type Pt = { x: number; y: number };

function placeCursorUi(el: HTMLElement, clientX: number, clientY: number): void {
  const area = el.parentElement!.getBoundingClientRect();
  const OFF = 16;
  let x = clientX - area.left + OFF;
  let y = clientY - area.top  + OFF;
  if (x + 200 > area.width)  x = clientX - area.left - 200 - OFF;
  if (y +  80 > area.height) y = clientY - area.top  -  80 - OFF;
  el.style.left = `${Math.max(0, x)}px`;
  el.style.top  = `${Math.max(0, y)}px`;
  el.removeAttribute('hidden');
}

export function mountBbox(canvas: HTMLCanvasElement, cursorUi: HTMLElement): () => void {
  cursorUi.innerHTML = `
    <p id="bbox-error" class="cursor-error" style="display:none">${t('errors.bbox_too_small')}</p>
    <div class="cursor-actions">
      <button id="confirm-bbox" disabled>${t('phase4.confirm')}</button>
      <button class="secondary" id="redo-bbox">${t('phase4.redo')}</button>
    </div>
  `;
  cursorUi.setAttribute('hidden', '');

  const errorEl   = cursorUi.querySelector('#bbox-error')   as HTMLElement;
  const confirmBtn = cursorUi.querySelector('#confirm-bbox') as HTMLButtonElement;

  let p1: Pt | null = null;
  let p2: Pt | null = null;
  let drawing = false;

  function canvasPt(e: MouseEvent): Pt {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    };
  }

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    p1 = p2 = canvasPt(e);
    drawing = true;
    confirmBtn.disabled = true;
    errorEl.style.display = 'none';
    cursorUi.setAttribute('hidden', '');
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!drawing) return;
    p2 = canvasPt(e);
    triggerRender();
  };

  const onMouseUp = (e: MouseEvent): void => {
    if (!drawing) return;
    drawing = false;
    if (!p1 || !p2) return;
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);
    const tooSmall = w < MIN_PX || h < MIN_PX;
    errorEl.style.display = tooSmall ? '' : 'none';
    confirmBtn.disabled = tooSmall;
    placeCursorUi(cursorUi, e.clientX, e.clientY);
    triggerRender();
  };

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  setOverlayPainter((ctx) => {
    if (!p1 || !p2) return;
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);
    ctx.save();
    ctx.strokeStyle = GREEN;
    ctx.fillStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });

  confirmBtn.addEventListener('click', () => {
    if (!p1 || !p2) return;
    const s = getState();
    const dw = canvas.width;
    const dh = canvas.height;
    const o1 = dispToOrig(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), s, dw, dh);
    const o2 = dispToOrig(Math.max(p1.x, p2.x), Math.max(p1.y, p2.y), s, dw, dh);
    const x  = Math.max(0, Math.round(o1.x));
    const y  = Math.max(0, Math.round(o1.y));
    const bw = Math.min(s.video!.width  - x, Math.round(o2.x - o1.x));
    const bh = Math.min(s.video!.height - y, Math.round(o2.y - o1.y));
    if (bw < 4 || bh < 4) return;
    setState({ bbox: { x, y, w: bw, h: bh }, phase: 'setup' });
  });

  cursorUi.querySelector('#redo-bbox')!.addEventListener('click', () => {
    p1 = p2 = null;
    drawing = false;
    errorEl.style.display = 'none';
    confirmBtn.disabled = true;
    cursorUi.setAttribute('hidden', '');
    triggerRender();
  });

  const keyHandler = (e: KeyboardEvent): void => {
    if (getState().phase !== 'bbox') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') (cursorUi.querySelector('#redo-bbox') as HTMLButtonElement).click();
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
    cursorUi.setAttribute('hidden', '');
    cursorUi.innerHTML = '';
    p1 = p2 = null;
    drawing = false;
  };
}
