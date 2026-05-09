import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { applyDom } from './i18n';
import { getState, setState, subscribe } from './state';
import { render, attachZoomPan, fitDisplaySize } from './ui/canvas';

applyDom();

const canvas    = document.getElementById('stage') as HTMLCanvasElement;
const dropOverlay = document.getElementById('drop-overlay')!;
const fileInput   = document.getElementById('file') as HTMLInputElement;
const stageWrap   = document.getElementById('stage-wrap')!;

// ── Test image harness (step 2) ───────────────────────────────
// Creates a 1920×1080 synthetic image to verify zoom/pan/axes
// before video loading (step 3) replaces this.
let testBitmap: ImageBitmap | null = null;

async function loadTestImage(): Promise<void> {
  const W = 1920, H = 1080;
  const off = new OffscreenCanvas(W, H);
  const ctx2 = off.getContext('2d')!;

  // Background gradient
  const grad = ctx2.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1a2035');
  grad.addColorStop(1, '#0d1520');
  ctx2.fillStyle = grad;
  ctx2.fillRect(0, 0, W, H);

  // Grid lines every 120 px
  ctx2.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx2.lineWidth = 1;
  for (let x = 0; x <= W; x += 120) {
    ctx2.beginPath(); ctx2.moveTo(x, 0); ctx2.lineTo(x, H); ctx2.stroke();
  }
  for (let y = 0; y <= H; y += 120) {
    ctx2.beginPath(); ctx2.moveTo(0, y); ctx2.lineTo(W, y); ctx2.stroke();
  }

  // Label corners
  ctx2.fillStyle = 'rgba(255,255,255,0.3)';
  ctx2.font = '20px ui-monospace, monospace';
  ctx2.fillText('1920×1080  test image', 20, 36);
  ctx2.fillText('TL', 12, H - 12);
  ctx2.fillText('TR', W - 36, H - 12);

  // Center dot
  ctx2.fillStyle = '#f472b6';
  ctx2.beginPath(); ctx2.arc(W / 2, H / 2, 6, 0, Math.PI * 2); ctx2.fill();

  testBitmap = await createImageBitmap(off);

  setState({
    video: { fps: 30, width: W, height: H, totalFrames: 1, src: 'test' },
  });
  dropOverlay.classList.add('hidden');
}

// ── Render loop ───────────────────────────────────────────────
function draw(): void {
  const s = getState();
  if (!s.video || !testBitmap) return;
  render(canvas, testBitmap, s);
}

subscribe(draw);
attachZoomPan(canvas);

// Keyboard: set test origin at center on 'O'
window.addEventListener('keydown', (e) => {
  if (e.key === 'o' || e.key === 'O') {
    const s = getState();
    if (!s.video) return;
    setState({ origin: { x: s.video.width / 2, y: s.video.height / 2 } });
  }
});

// Resize: redraw when canvas layout changes
const ro = new ResizeObserver(draw);
ro.observe(stageWrap);

// ── Drag-and-drop / file picker (placeholder until step 3) ───
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

function handleVideoFile(file: File): void {
  // replaced in step 3 (video loader)
  const cvStatus = document.getElementById('cv-status')!;
  cvStatus.textContent = `${file.name} carregado`;
  dropOverlay.classList.add('hidden');
}

// ── Boot ──────────────────────────────────────────────────────
// Size canvas to default before test image loads
const { dw, dh } = fitDisplaySize(1920, 1080);
canvas.width = dw;
canvas.height = dh;

loadTestImage();
