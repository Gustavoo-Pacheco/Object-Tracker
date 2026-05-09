import { getState, setState, triggerRender } from '../../state';
import { dispToOrig } from '../canvas';
import { setOverlayPainter, clearOverlayPainter } from '../overlay';
import { t } from '../../i18n';

const RED = '#ef4444';

type Pt = { x: number; y: number };

function placeCursorUi(el: HTMLElement, clientX: number, clientY: number): void {
  const area = el.parentElement!.getBoundingClientRect();
  const OFF = 16;
  let x = clientX - area.left + OFF;
  let y = clientY - area.top  + OFF;
  if (x + 210 > area.width)  x = clientX - area.left - 210 - OFF;
  if (y + 100 > area.height) y = clientY - area.top  - 100 - OFF;
  el.style.left = `${Math.max(0, x)}px`;
  el.style.top  = `${Math.max(0, y)}px`;
  el.removeAttribute('hidden');
}

export function mountScale(canvas: HTMLCanvasElement, cursorUi: HTMLElement): () => void {
  cursorUi.innerHTML = `
    <input type="text" id="scale-metres" placeholder="${t('phase3.metres_placeholder')}"
           inputmode="decimal" autocomplete="off" />
    <div class="cursor-actions">
      <button id="confirm-scale" disabled>${t('phase3.confirm')}</button>
      <button class="secondary" id="redo-scale">${t('phase3.redo')}</button>
    </div>
  `;
  cursorUi.setAttribute('hidden', '');

  const metresInput = cursorUi.querySelector('#scale-metres') as HTMLInputElement;
  const confirmBtn  = cursorUi.querySelector('#confirm-scale') as HTMLButtonElement;

  let pts: Pt[] = [];
  let cursor: Pt | null = null;

  function canvasPt(e: MouseEvent): Pt {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    };
  }

  function validateInput(): void {
    if (pts.length < 2) { confirmBtn.disabled = true; return; }
    const v = parseFloat(metresInput.value.replace(',', '.'));
    confirmBtn.disabled = !isFinite(v) || v <= 0;
  }

  const onMove = (e: MouseEvent): void => {
    if (pts.length >= 2) return;
    cursor = canvasPt(e);
    triggerRender();
  };

  const onClick = (e: MouseEvent): void => {
    if (pts.length >= 2) return;
    pts.push(canvasPt(e));
    if (pts.length === 2) {
      cursor = null;
      placeCursorUi(cursorUi, e.clientX, e.clientY);
      setTimeout(() => metresInput.focus(), 0);
    }
    triggerRender();
  };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('click', onClick);
  metresInput.addEventListener('input', validateInput);

  setOverlayPainter((ctx) => {
    ctx.save();
    ctx.strokeStyle = RED;
    ctx.fillStyle   = RED;
    ctx.lineWidth   = 1.5;
    if (pts.length >= 1) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 4, 0, Math.PI * 2); ctx.fill();
    }
    if (pts.length === 1 && cursor) {
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(cursor.x, cursor.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(cursor.x, cursor.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    if (pts.length >= 2) {
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
      ctx.beginPath(); ctx.arc(pts[1].x, pts[1].y, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  });

  confirmBtn.addEventListener('click', () => {
    if (pts.length < 2) return;
    const v = parseFloat(metresInput.value.replace(',', '.'));
    if (!isFinite(v) || v <= 0) return;
    const s = getState();
    const o1 = dispToOrig(pts[0].x, pts[0].y, s, canvas.width, canvas.height);
    const o2 = dispToOrig(pts[1].x, pts[1].y, s, canvas.width, canvas.height);
    const opx = Math.hypot(o2.x - o1.x, o2.y - o1.y);
    setState({ metresPerPixel: v / opx, scalePts: [o1, o2], phase: 'setup' });
  });

  cursorUi.querySelector('#redo-scale')!.addEventListener('click', () => {
    pts = [];
    cursor = null;
    metresInput.value = '';
    confirmBtn.disabled = true;
    cursorUi.setAttribute('hidden', '');
    triggerRender();
  });

  const keyHandler = (e: KeyboardEvent): void => {
    if (getState().phase !== 'scale') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') (cursorUi.querySelector('#redo-scale') as HTMLButtonElement).click();
    if (e.key === 'Escape') setState({ phase: 'setup' });
  };
  window.addEventListener('keydown', keyHandler);

  return () => {
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('keydown', keyHandler);
    clearOverlayPainter();
    cursorUi.setAttribute('hidden', '');
    cursorUi.innerHTML = '';
    pts = [];
    cursor = null;
  };
}
