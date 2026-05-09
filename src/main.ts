import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { applyDom } from './i18n';
import { getState, setState, subscribe, type AppState, type Phase } from './state';
import { render, attachZoomPan, fitDisplaySize } from './ui/canvas';
import { loadVideo } from './video/loader';
import { FrameCache } from './video/cache';
import { mountNavigate } from './ui/phases/navigate';
import { mountOrigin } from './ui/phases/origin';
import { mountScale } from './ui/phases/scale';
import { mountBbox } from './ui/phases/bbox';
import { t } from './i18n';

applyDom();

const canvas      = document.getElementById('stage')      as HTMLCanvasElement;
const dropOverlay = document.getElementById('drop-overlay')!;
const fileInput   = document.getElementById('file')       as HTMLInputElement;
const stageWrap   = document.getElementById('stage-wrap')!;
const stageArea   = document.getElementById('stage-area')!;
const cvStatus    = document.getElementById('cv-status')!;
const navBar      = document.getElementById('nav-bar')!;
const phaseUi     = document.getElementById('phase-ui')!;

const toolAxisBtn  = document.getElementById('tool-axis')  as HTMLButtonElement;
const toolScaleBtn = document.getElementById('tool-scale') as HTMLButtonElement;
const toolBboxBtn  = document.getElementById('tool-bbox')  as HTMLButtonElement;
const runBtn       = document.getElementById('btn-run')    as HTMLButtonElement;

const cache = new FrameCache();

// ── Render with rAF debounce ──────────────────────────────────
let rafQueued = false;
function queueRender(): void {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(async () => {
    rafQueued = false;
    const s = getState();
    if (!s.video) return;
    const bm = await cache.get(s.frameIdx);
    if (bm) render(canvas, bm, s);
  });
}

// ── Phase router ──────────────────────────────────────────────
let currentPhase: Phase = 'idle';
let unmountCurrent: (() => void) | undefined;

const TOOL_PHASES = new Set<Phase>(['setup', 'origin', 'scale', 'bbox']);

function mountSetup(): () => void {
  function renderSetup(s: AppState): void {
    const originDone = s.origin !== null;
    const scaleDone  = s.metresPerPixel !== null;
    const bboxDone   = s.bbox !== null;
    const allDone    = originDone && scaleDone && bboxDone;

    phaseUi.innerHTML = `
      <h2>${t('setup.title')}</h2>
      <p class="hint">${t('setup.hint')}</p>
      <ul class="setup-status">
        <li class="setup-item">
          <span class="setup-dot ${originDone ? 'done' : 'pending'}"></span>
          <span>${t('tool.axis')}</span>
          <span class="value">${originDone
            ? `(${s.origin!.x}, ${s.origin!.y})`
            : t('setup.not_set')}</span>
        </li>
        <li class="setup-item">
          <span class="setup-dot ${scaleDone ? 'done' : 'pending'}"></span>
          <span>${t('tool.scale')}</span>
          <span class="value">${scaleDone
            ? s.metresPerPixel!.toExponential(3) + ' m/px'
            : t('setup.not_set')}</span>
        </li>
        <li class="setup-item">
          <span class="setup-dot ${bboxDone ? 'done' : 'pending'}"></span>
          <span>${t('tool.bbox')}</span>
          <span class="value">${bboxDone
            ? `${s.bbox!.w}×${s.bbox!.h} px`
            : t('setup.not_set')}</span>
        </li>
      </ul>
      <button id="run-from-setup" ${allDone ? '' : 'disabled'}>${t('setup.run')}</button>
    `;

    phaseUi.querySelector('#run-from-setup')?.addEventListener('click', () => {
      setState({ phase: 'tracking' });
    });
  }

  const unsub = subscribe((s) => {
    if (s.phase === 'setup') renderSetup(s);
  });

  renderSetup(getState());

  return () => {
    unsub();
    phaseUi.innerHTML = '';
  };
}

subscribe((s) => {
  cvStatus.textContent = s.status;

  if (s.video) dropOverlay.classList.add('hidden');
  else         dropOverlay.classList.remove('hidden');

  // Enable/disable toolbar tool buttons
  const toolsEnabled = TOOL_PHASES.has(s.phase);
  toolAxisBtn.disabled  = !toolsEnabled;
  toolScaleBtn.disabled = !toolsEnabled;
  toolBboxBtn.disabled  = !toolsEnabled;
  if (runBtn) runBtn.disabled = !(s.origin && s.metresPerPixel && s.bbox);

  // Active + done indicators on toolbar buttons
  toolAxisBtn.classList.toggle('active', s.phase === 'origin');
  toolScaleBtn.classList.toggle('active', s.phase === 'scale');
  toolBboxBtn.classList.toggle('active', s.phase === 'bbox');
  toolAxisBtn.classList.toggle('done',  s.origin !== null && s.phase !== 'origin');
  toolScaleBtn.classList.toggle('done', s.metresPerPixel !== null && s.phase !== 'scale');
  toolBboxBtn.classList.toggle('done',  s.bbox !== null && s.phase !== 'bbox');

  if (s.phase !== currentPhase) {
    unmountCurrent?.();
    unmountCurrent = undefined;
    currentPhase = s.phase;

    if (s.phase === 'navigate') {
      unmountCurrent = mountNavigate(navBar, (_idx) => {});
    } else if (s.phase === 'setup') {
      unmountCurrent = mountSetup();
    } else if (s.phase === 'origin') {
      unmountCurrent = mountOrigin(phaseUi, canvas);
    } else if (s.phase === 'scale') {
      unmountCurrent = mountScale(phaseUi, canvas);
    } else if (s.phase === 'bbox') {
      unmountCurrent = mountBbox(phaseUi, canvas);
    }
  }

  queueRender();
});

subscribe((s) => { if (!s.video) cache.clear(); });

attachZoomPan(canvas);

// ── Toolbar tool button clicks ────────────────────────────────
toolAxisBtn.addEventListener('click', () => {
  setState({ origin: null, phase: 'origin' });
});
toolScaleBtn.addEventListener('click', () => {
  setState({ metresPerPixel: null, scalePts: null, phase: 'scale' });
});
toolBboxBtn.addEventListener('click', () => {
  setState({ bbox: null, phase: 'bbox' });
});
if (runBtn) {
  runBtn.addEventListener('click', () => {
    const s = getState();
    if (s.origin && s.metresPerPixel && s.bbox) setState({ phase: 'tracking' });
  });
}

// ── Video file handling ───────────────────────────────────────
async function handleVideoFile(file: File): Promise<void> {
  try {
    await loadVideo(file, () => cache.clear());
  } catch (err) {
    cvStatus.textContent = err instanceof Error ? err.message : String(err);
  }
}

stageWrap.addEventListener('dragover', e => {
  e.preventDefault();
  dropOverlay.classList.add('drag-active');
});
stageWrap.addEventListener('dragleave', () => {
  dropOverlay.classList.remove('drag-active');
});
stageWrap.addEventListener('drop', e => {
  e.preventDefault();
  dropOverlay.classList.remove('drag-active');
  const file = e.dataTransfer?.files[0];
  if (file) handleVideoFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) handleVideoFile(fileInput.files[0]);
});

new ResizeObserver(queueRender).observe(stageArea);

const { dw, dh } = fitDisplaySize(1920, 1080);
canvas.width  = dw;
canvas.height = dh;
