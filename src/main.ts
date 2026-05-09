import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { applyDom } from './i18n';
import { getState, setState, subscribe } from './state';
import { render, attachZoomPan, fitDisplaySize } from './ui/canvas';
import { loadVideo } from './video/loader';
import { FrameCache } from './video/cache';

applyDom();

const canvas      = document.getElementById('stage') as HTMLCanvasElement;
const dropOverlay = document.getElementById('drop-overlay')!;
const fileInput   = document.getElementById('file') as HTMLInputElement;
const stageWrap   = document.getElementById('stage-wrap')!;
const cvStatus    = document.getElementById('cv-status')!;

const cache = new FrameCache();

// ── Render loop ───────────────────────────────────────────────
async function renderCurrent(): Promise<void> {
  const s = getState();
  if (!s.video) return;
  const bm = await cache.get(s.frameIdx);
  if (bm) render(canvas, bm, s);
}

subscribe(async (s) => {
  cvStatus.textContent = s.status;
  if (s.video) {
    dropOverlay.classList.add('hidden');
  } else {
    dropOverlay.classList.remove('hidden');
  }
  await renderCurrent();
});

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

// ── Resize: redraw when canvas layout changes ─────────────────
const ro = new ResizeObserver(() => renderCurrent());
ro.observe(stageWrap);

// ── Keyboard: set origin with 'O' (dev convenience) ──────────
window.addEventListener('keydown', (e) => {
  if (e.key === 'o' || e.key === 'O') {
    const s = getState();
    if (!s.video) return;
    setState({ origin: { x: s.video.width / 2, y: s.video.height / 2 } });
  }
});

// ── Initial canvas size ───────────────────────────────────────
const { dw, dh } = fitDisplaySize(1920, 1080);
canvas.width = dw;
canvas.height = dh;
