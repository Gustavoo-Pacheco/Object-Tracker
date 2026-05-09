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
const cursorUi    = document.getElementById('cursor-ui')!;

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

// Setup panel stays mounted for the entire setup/origin/scale/bbox group.
// Tool phases (origin/scale/bbox) additionally mount their cursor UI over the canvas.
let unmountSetup: (() => void) | undefined;
let unmountTool: (() => void) | undefined;

function renderSetupPanel(s: AppState): void {
  const originDone = s.origin !== null;
  const scaleDone  = s.metresPerPixel !== null;
  const bboxDone   = s.bbox !== null;
  const allDone    = originDone && scaleDone && bboxDone;

  phaseUi.innerHTML = `
    <h2>${t('setup.title')}</h2>
    <ul class="setup-status">
      <li class="setup-item">
        <span class="setup-dot ${originDone ? 'done' : 'pending'}"></span>
        <span>${t('tool.axis')}</span>
        <span class="value">${originDone ? `(${s.origin!.x}, ${s.origin!.y})` : t('setup.not_set')}</span>
      </li>
      <li class="setup-item">
        <span class="setup-dot ${scaleDone ? 'done' : 'pending'}"></span>
        <span>${t('tool.scale')}</span>
        <span class="value">${scaleDone ? `${(s.metresPerPixel! * 1000).toFixed(3)} mm/px` : t('setup.not_set')}</span>
      </li>
      <li class="setup-item">
        <span class="setup-dot ${bboxDone ? 'done' : 'pending'}"></span>
        <span>${t('tool.bbox')}</span>
        <span class="value">${bboxDone ? `${s.bbox!.w}×${s.bbox!.h} px` : t('setup.not_set')}</span>
      </li>
    </ul>
    <button id="run-from-setup" ${allDone ? '' : 'disabled'}>${t('setup.run')}</button>
  `;

  phaseUi.querySelector('#run-from-setup')?.addEventListener('click', () => {
    setState({ phase: 'tracking' });
  });
}

function mountSetupGroup(): void {
  renderSetupPanel(getState());
  const unsub = subscribe((s) => {
    if (TOOL_PHASES.has(s.phase)) renderSetupPanel(s);
  });
  unmountSetup = () => { unsub(); phaseUi.innerHTML = ''; };
}

function unmountSetupGroup(): void {
  unmountSetup?.();
  unmountSetup = undefined;
  unmountTool?.();
  unmountTool = undefined;
  cursorUi.setAttribute('hidden', '');
  cursorUi.innerHTML = '';
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
    const wasInSetupGroup = TOOL_PHASES.has(currentPhase);
    const nowInSetupGroup = TOOL_PHASES.has(s.phase);
    currentPhase = s.phase;

    // Tear down previous non-setup-group phases
    if (!wasInSetupGroup) {
      unmountCurrent?.();
      unmountCurrent = undefined;
    }

    // Mount/unmount the setup panel group as a whole
    if (!wasInSetupGroup && nowInSetupGroup) {
      mountSetupGroup();
    } else if (wasInSetupGroup && !nowInSetupGroup) {
      unmountSetupGroup();
      unmountCurrent?.();
      unmountCurrent = undefined;
    }

    // Mount per-tool cursor UI
    if (nowInSetupGroup) {
      unmountTool?.();
      unmountTool = undefined;
      if (s.phase === 'origin') unmountTool = mountOrigin(canvas, cursorUi);
      else if (s.phase === 'scale') unmountTool = mountScale(canvas, cursorUi);
      else if (s.phase === 'bbox') unmountTool = mountBbox(canvas, cursorUi);
    }

    if (s.phase === 'navigate') {
      unmountCurrent = mountNavigate(navBar, (_idx) => {});
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
