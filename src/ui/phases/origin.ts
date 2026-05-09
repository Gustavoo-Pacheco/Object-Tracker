import { getState, setState, triggerRender } from '../../state';
import { dispToOrig } from '../canvas';
import { setOverlayPainter, clearOverlayPainter } from '../overlay';
import { t } from '../../i18n';

// hot pink matching track.py (180, 105, 255) BGR → rgb(255, 105, 180); CSS var is close enough
const PINK = '#f472b6';

export function mountOrigin(panel: HTMLElement, canvas: HTMLCanvasElement): () => void {
  panel.innerHTML = `
    <h2>${t('phase2.title')}</h2>
    <p class="hint">${t('phase2.instruction')}</p>
    <div class="phase-actions">
      <button id="confirm-origin" disabled>${t('phase2.confirm')}</button>
      <button class="secondary" id="redo-origin">${t('phase2.redo')}</button>
    </div>
  `;

  // coords in canvas pixel space (not CSS px, not original-frame px)
  let cursor: { x: number; y: number } | null = null;
  let clicked: { x: number; y: number } | null = null;

  const confirmBtn = panel.querySelector('#confirm-origin') as HTMLButtonElement;

  function canvasPt(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  const onMove = (e: MouseEvent): void => {
    cursor = canvasPt(e);
    triggerRender();
  };

  const onClick = (e: MouseEvent): void => {
    clicked = canvasPt(e);
    confirmBtn.disabled = false;
    triggerRender();
  };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('click', onClick);

  setOverlayPainter((ctx, dw, dh) => {
    const pt = clicked ?? cursor;
    if (!pt) return;
    ctx.save();
    ctx.strokeStyle = PINK;
    ctx.fillStyle = PINK;
    ctx.lineWidth = 1;

    ctx.beginPath(); ctx.moveTo(pt.x, 0); ctx.lineTo(pt.x, dh); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, pt.y); ctx.lineTo(dw, pt.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2); ctx.fill();

    ctx.font = '13px ui-monospace, monospace';
    if (clicked) {
      ctx.fillText('0,0', pt.x + 8, pt.y - 8);
    }
    ctx.restore();
  });

  confirmBtn.addEventListener('click', () => {
    if (!clicked) return;
    const s = getState();
    const orig = dispToOrig(clicked.x, clicked.y, s, canvas.width, canvas.height);
    setState({ origin: { x: Math.round(orig.x), y: Math.round(orig.y) }, phase: 'setup' });
  });

  panel.querySelector('#redo-origin')!.addEventListener('click', () => {
    clicked = null;
    confirmBtn.disabled = true;
    triggerRender();
  });

  const keyHandler = (e: KeyboardEvent): void => {
    if (getState().phase !== 'origin') return;
    if (e.key === 'Enter' && clicked) confirmBtn.click();
    if (e.key === 'Escape') setState({ phase: 'setup' });
  };
  window.addEventListener('keydown', keyHandler);

  return () => {
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('keydown', keyHandler);
    clearOverlayPainter();
    cursor = null;
    clicked = null;
  };
}
