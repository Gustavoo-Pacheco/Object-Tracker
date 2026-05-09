import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { applyDom } from './i18n';
import { getState, subscribe, type Phase } from './state';
import { render, attachZoomPan, fitDisplaySize } from './ui/canvas';
import { loadVideo } from './video/loader';
import { FrameCache } from './video/cache';
import { mountNavigate } from './ui/phases/navigate';

applyDom();

const canvas      = document.getElementById('stage')      as HTMLCanvasElement;
const dropOverlay = document.getElementById('drop-overlay')!;
const fileInput   = document.getElementById('file')       as HTMLInputElement;
const stageWrap   = document.getElementById('stage-wrap')!;
const stageArea   = document.getElementById('stage-area')!;
const cvStatus    = document.getElementById('cv-status')!;
const navBar      = document.getElementById('nav-bar')!;

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

subscribe((s) => {
  cvStatus.textContent = s.status;

  if (s.video) dropOverlay.classList.add('hidden');
  else         dropOverlay.classList.remove('hidden');

  if (s.phase !== currentPhase) {
    unmountCurrent?.();
    unmountCurrent = undefined;
    currentPhase = s.phase;

    if (s.phase === 'navigate') {
      unmountCurrent = mountNavigate(navBar, (_idx) => {
        // step 5 will mount the origin phase here
      });
    }
  }

  queueRender();
});

subscribe((s) => { if (!s.video) cache.clear(); });

attachZoomPan(canvas);

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
