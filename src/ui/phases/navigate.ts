import { getState, setState, subscribe } from '../../state';
import { t } from '../../i18n';
import { clearVideo } from '../../video/loader';

export function mountNavigate(
  bar: HTMLElement,
  onConfirm: (idx: number) => void,
): () => void {
  const s = getState();
  if (!s.video) return () => {};

  const { totalFrames } = s.video;
  const maxIdx = totalFrames - 1;

  bar.innerHTML = `
    <input type="range" id="nav-scrub" min="0" max="${maxIdx}" value="0" />
    <div class="nav-controls">
      <div class="jump-group">
        <button class="icon-btn" id="btn-back-step">«</button>
        <button class="icon-btn" id="btn-back-1">‹</button>
        <div class="nav-step-wrap">
          <span class="nav-step-label">${t('phase1.step_label')}</span>
          <input type="number" id="nav-step" min="1" max="999" value="10"
                 class="tabular nav-step-input" />
        </div>
        <button class="icon-btn" id="btn-fwd-1">›</button>
        <button class="icon-btn" id="btn-fwd-step">»</button>
      </div>
      <div class="nav-readout">
        <span class="nav-time tabular" id="nav-frame-time">0.00 s</span>
        <span class="nav-sep">·</span>
        <span class="nav-frame tabular" id="nav-frame-num">0 / ${maxIdx}</span>
      </div>
      <button id="nav-confirm" class="nav-confirm-btn">${t('phase1.confirm')}</button>
    </div>
  `;

  bar.removeAttribute('hidden');

  const scrub     = bar.querySelector('#nav-scrub')      as HTMLInputElement;
  const frameTime = bar.querySelector('#nav-frame-time') as HTMLElement;
  const frameNum  = bar.querySelector('#nav-frame-num')  as HTMLElement;
  const stepInput = bar.querySelector('#nav-step')       as HTMLInputElement;

  function getStep(): number {
    return Math.max(1, parseInt(stepInput.value, 10) || 10);
  }

  function jump(delta: number): void {
    const cur = getState();
    if (!cur.video) return;
    const next = clamp(cur.frameIdx + delta, 0, cur.video.totalFrames - 1);
    setState({ frameIdx: next });
  }

  function confirmCurrent(): void {
    const cur = getState();
    setState({ startFrame: cur.frameIdx, phase: 'setup' });
    onConfirm(cur.frameIdx);
  }

  bar.querySelector('#btn-back-step')!.addEventListener('click', () => jump(-getStep()));
  bar.querySelector('#btn-back-1')!   .addEventListener('click', () => jump(-1));
  bar.querySelector('#btn-fwd-1')!    .addEventListener('click', () => jump(1));
  bar.querySelector('#btn-fwd-step')! .addEventListener('click', () => jump(getStep()));
  scrub.addEventListener('input', () => setState({ frameIdx: parseInt(scrub.value, 10) }));
  bar.querySelector('#nav-confirm')!  .addEventListener('click', confirmCurrent);

  const keyHandler = (e: KeyboardEvent): void => {
    if (getState().phase !== 'navigate') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    switch (e.key) {
      case 'ArrowLeft':  case 'a': case 'A': e.preventDefault(); jump(-1);         break;
      case 'ArrowRight': case 'd': case 'D': e.preventDefault(); jump(1);          break;
      case 'ArrowUp':    case 'w': case 'W': e.preventDefault(); jump(getStep());  break;
      case 'ArrowDown':  case 's': case 'S': e.preventDefault(); jump(-getStep()); break;
      case 'Enter': case ' ':                e.preventDefault(); confirmCurrent(); break;
      case 'Escape':                         cancelToIdle();                        break;
    }
  };
  window.addEventListener('keydown', keyHandler);

  const unsub = subscribe((cur) => {
    if (!cur.video) return;
    const timeSec = cur.frameIdx / cur.video.fps;
    if (scrub.value !== String(cur.frameIdx)) scrub.value = String(cur.frameIdx);
    frameTime.textContent = `${timeSec.toFixed(2)} s`;
    frameNum.textContent  = `${cur.frameIdx} / ${cur.video.totalFrames - 1}`;
  });

  return () => {
    window.removeEventListener('keydown', keyHandler);
    unsub();
    bar.setAttribute('hidden', '');
    bar.innerHTML = '';
  };
}

function cancelToIdle(): void {
  clearVideo();
  setState({
    phase: 'idle',
    video: null,
    frameIdx: 0,
    zoom: 1,
    pan: { x: 0, y: 0 },
    origin: null,
    scalePts: null,
    metresPerPixel: null,
    bbox: null,
    startFrame: null,
    records: [],
    status: t('status.empty'),
  });
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));
