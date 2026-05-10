import { getState, setState, triggerRender } from '../../state';
import { dispToOrig } from '../canvas';
import { setOverlayPainter, clearOverlayPainter } from '../overlay';
import { t } from '../../i18n';

const RED = '#ff0000';

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

export function mountOrigin(canvas: HTMLCanvasElement, cursorUi: HTMLElement): () => void {
  cursorUi.innerHTML = `
    <button id="confirm-origin">${t('phase2.confirm')}</button>
    <button class="secondary" id="redo-origin">${t('phase2.redo')}</button>
  `;
  cursorUi.setAttribute('hidden', '');

  let cursor: Pt | null = null;
  let clicked: Pt | null = null;

  function canvasPt(e: MouseEvent): Pt {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    };
  }

  const onMove = (e: MouseEvent): void => {
    if (clicked) return;
    cursor = canvasPt(e);
    triggerRender();
  };

  const onClick = (e: MouseEvent): void => {
    clicked = canvasPt(e);
    cursor = null;
    placeCursorUi(cursorUi, e.clientX, e.clientY);
    triggerRender();
  };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('click', onClick);

  setOverlayPainter((ctx, dw, dh) => {
    const pt = clicked ?? cursor;
    if (!pt) return;
    ctx.save();
    ctx.strokeStyle = RED;
    ctx.fillStyle   = RED;
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(pt.x, 0);  ctx.lineTo(pt.x, dh); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, pt.y);  ctx.lineTo(dw,   pt.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2); ctx.fill();
    if (clicked) {
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText('0,0', pt.x + 8, pt.y - 8);
    }
    ctx.restore();
  });

  cursorUi.querySelector('#confirm-origin')!.addEventListener('click', () => {
    if (!clicked) return;
    const s = getState();
    const orig = dispToOrig(clicked.x, clicked.y, s, canvas.width, canvas.height);
    setState({ origin: { x: Math.round(orig.x), y: Math.round(orig.y) }, phase: 'setup' });
  });

  cursorUi.querySelector('#redo-origin')!.addEventListener('click', () => {
    clicked = null;
    cursorUi.setAttribute('hidden', '');
    triggerRender();
  });

  const keyHandler = (e: KeyboardEvent): void => {
    if (getState().phase !== 'origin') return;
    if (e.key === 'Enter' && clicked) (cursorUi.querySelector('#confirm-origin') as HTMLButtonElement).click();
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
    cursor = null;
    clicked = null;
  };
}
