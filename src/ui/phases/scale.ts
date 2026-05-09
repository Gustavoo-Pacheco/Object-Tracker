import { getState, setState, triggerRender } from '../../state';
import { dispToOrig } from '../canvas';
import { setOverlayPainter, clearOverlayPainter } from '../overlay';
import { t } from '../../i18n';

const PINK = '#f472b6';

type Pt = { x: number; y: number }; // canvas pixel coords

export function mountScale(panel: HTMLElement, canvas: HTMLCanvasElement): () => void {
  panel.innerHTML = `
    <h2>${t('phase3.title')}</h2>
    <p id="scale-instruction" class="hint">${t('phase3.p1_hint')}</p>
    <div class="phase-readout" id="scale-readout" style="display:none">
      <span class="readout-label">${t('phase3.pixels')}</span>
      <span id="scale-px" class="tabular">—</span>
    </div>
    <div id="scale-input-wrap" style="display:none">
      <label class="field-label">${t('phase3.metres')}</label>
      <input type="text" id="scale-metres" placeholder="${t('phase3.metres_placeholder')}"
             inputmode="decimal" autocomplete="off" />
      <div id="scale-result" class="phase-readout" style="display:none"></div>
    </div>
    <div class="phase-actions">
      <button id="confirm-scale" disabled>${t('phase3.confirm')}</button>
      <button class="secondary" id="redo-scale">${t('phase3.redo')}</button>
    </div>
  `;

  let pts: Pt[] = [];   // 0, 1 or 2 points, canvas pixel coords
  let cursor: Pt | null = null;

  const instruction = panel.querySelector('#scale-instruction') as HTMLElement;
  const readout     = panel.querySelector('#scale-readout')     as HTMLElement;
  const scalePxEl   = panel.querySelector('#scale-px')          as HTMLElement;
  const inputWrap   = panel.querySelector('#scale-input-wrap')  as HTMLElement;
  const metresInput = panel.querySelector('#scale-metres')      as HTMLInputElement;
  const resultEl    = panel.querySelector('#scale-result')      as HTMLElement;
  const confirmBtn  = panel.querySelector('#confirm-scale')     as HTMLButtonElement;

  function canvasPt(e: MouseEvent): Pt {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function pixelDist(a: Pt, b: Pt): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function origDist(a: Pt, b: Pt): number {
    const s = getState();
    const o1 = dispToOrig(a.x, a.y, s, canvas.width, canvas.height);
    const o2 = dispToOrig(b.x, b.y, s, canvas.width, canvas.height);
    return Math.hypot(o2.x - o1.x, o2.y - o1.y);
  }

  function updateReadout(): void {
    if (pts.length < 2) return;
    const dpx = pixelDist(pts[0], pts[1]);
    scalePxEl.textContent = `${dpx.toFixed(1)} px`;
    readout.style.display = '';
    inputWrap.style.display = '';
    instruction.textContent = t('phase3.p2_done');
    validateInput();
  }

  function validateInput(): void {
    const v = parseFloat(metresInput.value.replace(',', '.'));
    if (!isFinite(v) || v <= 0 || pts.length < 2) {
      confirmBtn.disabled = true;
      resultEl.style.display = 'none';
      return;
    }
    const opx = origDist(pts[0], pts[1]);
    const mpp = v / opx;
    resultEl.textContent = `${v} m ÷ ${opx.toFixed(1)} px = ${mpp.toExponential(3)} m/px`;
    resultEl.style.display = '';
    confirmBtn.disabled = false;
  }

  const onMove = (e: MouseEvent): void => {
    cursor = canvasPt(e);
    triggerRender();
  };

  const onClick = (e: MouseEvent): void => {
    if (pts.length >= 2) return;
    pts.push(canvasPt(e));
    if (pts.length === 1) {
      instruction.textContent = t('phase3.p2_hint');
    } else {
      updateReadout();
    }
    triggerRender();
  };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('click', onClick);
  metresInput.addEventListener('input', validateInput);

  setOverlayPainter((ctx, _dw, _dh) => {
    ctx.save();
    ctx.strokeStyle = PINK;
    ctx.fillStyle = PINK;
    ctx.lineWidth = 1.5;

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
    setState({
      metresPerPixel: v / opx,
      scalePts: [o1, o2],
      phase: 'setup',
    });
  });

  panel.querySelector('#redo-scale')!.addEventListener('click', () => {
    pts = [];
    cursor = null;
    instruction.textContent = t('phase3.p1_hint');
    readout.style.display = 'none';
    inputWrap.style.display = 'none';
    metresInput.value = '';
    confirmBtn.disabled = true;
    triggerRender();
  });

  const keyHandler = (e: KeyboardEvent): void => {
    if (getState().phase !== 'scale') return;
    if (e.key === 'r' || e.key === 'R') (panel.querySelector('#redo-scale') as HTMLButtonElement).click();
    if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
    if (e.key === 'Escape') setState({ phase: 'setup' });
  };
  window.addEventListener('keydown', keyHandler);

  return () => {
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('keydown', keyHandler);
    clearOverlayPainter();
    pts = [];
    cursor = null;
  };
}
