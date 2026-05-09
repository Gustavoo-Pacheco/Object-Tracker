import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { applyDom } from './i18n';

applyDom();

// ── Canvas placeholder ────────────────────────────────────────
const canvas = document.getElementById('stage') as HTMLCanvasElement;
canvas.width = 640;
canvas.height = 360;
const ctx = canvas.getContext('2d')!;
ctx.fillStyle = '#0b0d10';
ctx.fillRect(0, 0, canvas.width, canvas.height);

// ── Drag-and-drop on stage ────────────────────────────────────
const dropOverlay = document.getElementById('drop-overlay')!;
const fileInput   = document.getElementById('file') as HTMLInputElement;
const stageWrap   = document.getElementById('stage-wrap')!;

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

function handleVideoFile(file: File) {
  // placeholder — replaced in step 3 (video loader)
  const cvStatus = document.getElementById('cv-status')!;
  cvStatus.textContent = `${file.name} carregado`;
  dropOverlay.classList.add('hidden');
}
