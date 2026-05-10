import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { applyDom } from './i18n';
import { getState, setState, subscribe, type AppState, type Phase } from './state';
import { render, attachZoomPan, fitDisplaySize } from './ui/canvas';
import { loadVideo, clearVideo } from './video/loader';
import { FrameCache } from './video/cache';
import { mountNavigate } from './ui/phases/navigate';
import { mountOrigin } from './ui/phases/origin';
import { mountScale } from './ui/phases/scale';
import { mountBbox } from './ui/phases/bbox';
import { mountTracking } from './ui/phases/tracking';
import { mountResults, mountColumnToggles } from './ui/results';
import { mountSplitters } from './ui/splitters';
import { t } from './i18n';

applyDom();

// ── Theme (light/dark) ────────────────────────────────────────
const THEME_KEY = 'ot.theme';
type Theme = 'light' | 'dark';
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}
const storedTheme = (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'dark';
applyTheme(storedTheme);
document.getElementById('btn-theme')?.addEventListener('click', () => {
  const next: Theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
});

const canvas      = document.getElementById('stage')      as HTMLCanvasElement;
const dropOverlay = document.getElementById('drop-overlay')!;
const fileInput   = document.getElementById('file')       as HTMLInputElement;
const stageWrap   = document.getElementById('stage-wrap')!;
const stageArea   = document.getElementById('stage-area')!;
const cvStatus    = document.getElementById('cv-status')!;
const navBar      = document.getElementById('nav-bar')!;
const phaseUi     = document.getElementById('phase-ui')!;
const cursorUi    = document.getElementById('cursor-ui')!;

const toolAxisBtn  = document.getElementById('tool-axis')        as HTMLButtonElement;
const toolScaleBtn = document.getElementById('tool-scale')       as HTMLButtonElement;
const toolBboxBtn  = document.getElementById('tool-bbox')        as HTMLButtonElement;
const resetFrameBtn = document.getElementById('btn-reset-frame') as HTMLButtonElement;
const changeVideoBtn = document.getElementById('btn-change-video') as HTMLButtonElement;

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
const SETUP_PANEL_PHASES = new Set<Phase>(['navigate', 'setup', 'origin', 'scale', 'bbox']);
const NAV_BAR_PHASES = new Set<Phase>(['navigate', 'done']);

let unmountNavBar: (() => void) | undefined;

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
    if (getState().frameStride !== 1) setState({ frameStride: 1 });
    setState({ phase: 'tracking' });
  });
}

function mountSetupGroup(): void {
  renderSetupPanel(getState());
  const unsub = subscribe((s) => {
    if (SETUP_PANEL_PHASES.has(s.phase)) renderSetupPanel(s);
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
  const toolsEnabled = TOOL_PHASES.has(s.phase) || s.phase === 'navigate';
  toolAxisBtn.disabled  = !toolsEnabled;
  toolScaleBtn.disabled = !toolsEnabled;
  toolBboxBtn.disabled  = !toolsEnabled;
  // Reset-frame button: visible whenever a video is loaded and we're past the
  // initial navigate phase (i.e., the user has selected at least one tool).
  if (resetFrameBtn) {
    const showReset = !!s.video && s.phase !== 'navigate' && s.phase !== 'idle'
      && s.phase !== 'tracking' && s.phase !== 'done';
    resetFrameBtn.toggleAttribute('hidden', !showReset);
  }
  if (changeVideoBtn) {
    changeVideoBtn.toggleAttribute('hidden', !s.video);
  }

  // Active + done indicators on toolbar buttons
  toolAxisBtn.classList.toggle('active', s.phase === 'origin');
  toolScaleBtn.classList.toggle('active', s.phase === 'scale');
  toolBboxBtn.classList.toggle('active', s.phase === 'bbox');
  toolAxisBtn.classList.toggle('done',  s.origin !== null && s.phase !== 'origin');
  toolScaleBtn.classList.toggle('done', s.metresPerPixel !== null && s.phase !== 'scale');
  toolBboxBtn.classList.toggle('done',  s.bbox !== null && s.phase !== 'bbox');

  if (s.phase !== currentPhase) {
    const wasInPanelGroup = SETUP_PANEL_PHASES.has(currentPhase);
    const nowInPanelGroup = SETUP_PANEL_PHASES.has(s.phase);
    const nowInToolGroup  = TOOL_PHASES.has(s.phase);
    const wasInNavBar     = NAV_BAR_PHASES.has(currentPhase);
    const nowInNavBar     = NAV_BAR_PHASES.has(s.phase);
    currentPhase = s.phase;

    // Tear down tracking/results panels when leaving them.
    if (!wasInPanelGroup) {
      unmountCurrent?.();
      unmountCurrent = undefined;
    }

    // Mount/unmount the setup panel group as a whole
    if (!wasInPanelGroup && nowInPanelGroup) {
      mountSetupGroup();
    } else if (wasInPanelGroup && !nowInPanelGroup) {
      unmountSetupGroup();
      unmountCurrent?.();
      unmountCurrent = undefined;
    }

    // Mount per-tool cursor UI
    if (nowInToolGroup) {
      unmountTool?.();
      unmountTool = undefined;
      if (s.phase === 'origin') unmountTool = mountOrigin(canvas, cursorUi);
      else if (s.phase === 'scale') unmountTool = mountScale(canvas, cursorUi);
      else if (s.phase === 'bbox') unmountTool = mountBbox(canvas, cursorUi);
    } else {
      unmountTool?.();
      unmountTool = undefined;
      cursorUi.setAttribute('hidden', '');
      cursorUi.innerHTML = '';
    }

    // Nav bar lives across both 'navigate' and 'done' phases. Mount on entry
    // to either, unmount when leaving the group.
    if (!wasInNavBar && nowInNavBar) {
      unmountNavBar = mountNavigate(navBar);
    } else if (wasInNavBar && !nowInNavBar) {
      unmountNavBar?.();
      unmountNavBar = undefined;
    }

    if (s.phase === 'tracking') {
      unmountCurrent = mountTracking(phaseUi);
    } else if (s.phase === 'done') {
      unmountCurrent = mountResults(phaseUi);
    }
  }

  // Skip cache-driven render during 'tracking' — the tracking loop owns the
  // <video> element (seeks it for each frame) and renders the canvas itself.
  // Going through FrameCache here would race with readFrame() and cause the
  // visible frames to jitter forward/backward.
  if (s.phase !== 'tracking') queueRender();
});

subscribe((s) => { if (!s.video) cache.clear(); });

attachZoomPan(canvas);
mountSplitters();
mountColumnToggles();

// ── Toolbar tool button clicks ────────────────────────────────
function captureStartFrameIfNavigating(): { startFrame?: number } {
  const cur = getState();
  return cur.phase === 'navigate' ? { startFrame: cur.frameIdx } : {};
}
toolAxisBtn.addEventListener('click', () => {
  setState({ origin: null, phase: 'origin', ...captureStartFrameIfNavigating() });
});
toolScaleBtn.addEventListener('click', () => {
  setState({ metresPerPixel: null, scalePts: null, phase: 'scale', ...captureStartFrameIfNavigating() });
});
toolBboxBtn.addEventListener('click', () => {
  setState({ bbox: null, phase: 'bbox', ...captureStartFrameIfNavigating() });
});
if (resetFrameBtn) {
  resetFrameBtn.addEventListener('click', () => {
    setState({
      phase: 'navigate',
      origin: null,
      scalePts: null,
      metresPerPixel: null,
      bbox: null,
      startFrame: null,
      records: [],
      trackedBboxes: null,
      status: '',
    });
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

changeVideoBtn?.addEventListener('click', () => {
  fileInput.value = '';
  cache.clear();
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
    trackedBboxes: null,
    status: t('status.empty'),
  });
});

// ── Example videos ───────────────────────────────────────
const examplesBtn  = document.getElementById('btn-examples') as HTMLButtonElement | null;
const examplesMenu = document.getElementById('examples-menu') as HTMLUListElement | null;
if (examplesBtn && examplesMenu) {
  examplesBtn.addEventListener('click', e => {
    e.stopPropagation();
    examplesMenu.hidden = !examplesMenu.hidden;
  });
  document.addEventListener('click', e => {
    if (!examplesMenu.hidden && !examplesMenu.contains(e.target as Node) && e.target !== examplesBtn) {
      examplesMenu.hidden = true;
    }
  });
  examplesMenu.querySelectorAll<HTMLButtonElement>('.example-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const src  = btn.dataset.src!;
      const name = btn.dataset.name ?? src.split('/').pop()!;
      examplesMenu.hidden = true;
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const file = new File([blob], name, { type: blob.type || 'video/mp4' });
        await handleVideoFile(file);
      } catch (err) {
        cvStatus.textContent = err instanceof Error ? err.message : String(err);
      }
    });
  });
}

new ResizeObserver(queueRender).observe(stageArea);

const { dw, dh } = fitDisplaySize(1920, 1080);
canvas.width  = dw;
canvas.height = dh;
