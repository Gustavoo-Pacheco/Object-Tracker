import { type VideoMeta, capLongEdge } from '../video/loader';

export type VideoOptions = {
  stride: number;
  longEdge: number;
};

const RES_STOPS = [480, 720, 1080, Infinity] as const;
const RES_LABELS = ['480p', '720p', '1080p', 'Nativo'] as const;

export function showVideoOptionsModal(meta: VideoMeta): Promise<VideoOptions | null> {
  return new Promise(resolve => {
    const nativeLong = Math.max(meta.nativeW, meta.nativeH);

    // FPS pills: native (auto) + common lower values
    const fpsPills: number[] = [meta.fps];
    for (const f of [60, 30, 24, 15, 10]) {
      if (f < meta.fps) fpsPills.push(f);
    }

    // Default resolution: 1080p cap if native > 1080, otherwise native (no cap)
    const defaultSlider = nativeLong > 1080 ? 2 : RES_STOPS.length - 1;

    let selectedFpsIdx = 0; // 0 = first pill = native (auto)
    let sliderIdx = defaultSlider;

    const getStride = (): number =>
      Math.max(1, Math.round(meta.fps / fpsPills[selectedFpsIdx]));
    const getLongEdge = (): number => RES_STOPS[sliderIdx];
    const getEstFrames = (): number => {
      const total = Math.floor(meta.duration * meta.fps);
      return Math.ceil(total / getStride());
    };
    const getProcDims = (): { w: number; h: number } =>
      capLongEdge(meta.nativeW, meta.nativeH, getLongEdge());

    const formatDur = (s: number): string => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}m${sec.toString().padStart(2, '0')}s`;
    };

    const overlay = document.createElement('div');
    overlay.className = 'vo-overlay';
    overlay.innerHTML = `
      <div class="vo-card" role="dialog" aria-modal="true" aria-label="Opções de processamento">
        <h2 class="vo-title">Opções de processamento</h2>
        <div class="vo-info">
          <span class="vo-filename">${meta.name}</span>
          <span class="vo-meta">${formatDur(meta.duration)} · ${meta.nativeW}×${meta.nativeH} · ${meta.fps}fps</span>
        </div>

        <div class="vo-section">
          <p class="vo-label">FPS de processamento</p>
          <div class="vo-pills" role="group" aria-label="FPS de processamento">
            ${fpsPills.map((f, i) => `
              <button class="vo-pill" data-idx="${i}" type="button">
                ${i === 0 ? `Auto · ${f}fps` : `${f}fps`}
              </button>
            `).join('')}
          </div>
        </div>

        <div class="vo-section">
          <p class="vo-label">Velocidade vs Qualidade</p>
          <div class="vo-slider-wrap">
            <input type="range" class="vo-slider" min="0" max="${RES_STOPS.length - 1}" step="1" value="${sliderIdx}" aria-label="Resolução de processamento">
            <div class="vo-slider-labels">
              ${RES_LABELS.map((l, i) => `<span data-stop="${i}">${l}</span>`).join('')}
            </div>
          </div>
          <div class="vo-slider-ends">
            <span>Rápido</span>
            <span>Qualidade máxima</span>
          </div>
        </div>

        <div class="vo-estimate">
          <span class="vo-est-frames"></span>
          <span class="vo-est-dims"></span>
        </div>

        <div class="vo-actions">
          <button class="vo-btn-cancel" type="button">Cancelar</button>
          <button class="vo-btn-confirm" type="button">Continuar →</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const pillBtns = overlay.querySelectorAll<HTMLButtonElement>('[data-idx]');
    const sliderEl = overlay.querySelector<HTMLInputElement>('.vo-slider')!;
    const stopLabels = overlay.querySelectorAll<HTMLSpanElement>('[data-stop]');
    const estFramesEl = overlay.querySelector<HTMLSpanElement>('.vo-est-frames')!;
    const estDimsEl = overlay.querySelector<HTMLSpanElement>('.vo-est-dims')!;

    const updateDisplay = (): void => {
      pillBtns.forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.idx!) === selectedFpsIdx);
      });
      stopLabels.forEach((lbl, i) => lbl.classList.toggle('active', i === sliderIdx));

      const { w, h } = getProcDims();
      const frames = getEstFrames();
      const stride = getStride();
      estFramesEl.textContent = `~${frames.toLocaleString('pt-BR')} frames`;
      estDimsEl.textContent = `${w}×${h}px${stride > 1 ? ` · 1 a cada ${stride}` : ''}`;
    };

    updateDisplay();

    pillBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        selectedFpsIdx = parseInt(btn.dataset.idx!);
        updateDisplay();
      });
    });

    sliderEl.addEventListener('input', () => {
      sliderIdx = parseInt(sliderEl.value);
      updateDisplay();
    });

    const cancel = (): void => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(null);
    };

    const confirm = (): void => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve({ stride: getStride(), longEdge: getLongEdge() });
    };

    overlay.querySelector('.vo-btn-cancel')!.addEventListener('click', cancel);
    overlay.querySelector('.vo-btn-confirm')!.addEventListener('click', confirm);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') confirm();
    };
    document.addEventListener('keydown', onKey);

    // Focus confirm button for keyboard accessibility
    (overlay.querySelector('.vo-btn-confirm') as HTMLButtonElement).focus();
  });
}
