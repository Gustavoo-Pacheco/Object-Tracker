// Renders the trajectory plot (WebGPU) + the data table + manages the
// post-processing controls (smoothing dropdown, Y-up flip) and CSV export.

import { getState, setState, subscribe, type TrackRecord } from '../state';
import { process, type Sample, type Smoothing } from '../postprocess';
import { renderPlot, type PlotView } from '../gpu/plot';
import { downloadCsv } from '../export';
import { t } from '../i18n';
import { setOverlayPainter, clearOverlayPainter } from './overlay';
import { origToDisp } from './canvas';

const tableBody = (): HTMLTableSectionElement => document.getElementById('table-body') as HTMLTableSectionElement;
const tableEmpty = (): HTMLElement => document.getElementById('table-empty')!;
const plotMount = (): HTMLElement => document.getElementById('plot')!;

let rawSamples: Sample[] = [];
let smoothing: Smoothing = 'none';
let yUp = true;

export function setRawSamples(samples: Sample[]): void {
  rawSamples = samples;
  recompute();
}

export function clearResults(): void {
  rawSamples = [];
  setState({ records: [] });
  renderTable([]);
  ensurePlotCanvases();
  const empty = plotMount().querySelector('.plot-empty') as HTMLElement | null;
  if (empty) empty.style.display = '';
}

function recompute(): void {
  const s = getState();
  if (!s.origin || !s.metresPerPixel || rawSamples.length === 0) return;
  const records = process(rawSamples, {
    origin: s.origin,
    metresPerPixel: s.metresPerPixel,
    smoothing,
    yUp,
  });
  setState({ records });
}

// Full image extent in world metres, matching postprocess.ts conventions:
//   x = (px - origin.x) * mpp
//   y = yUp ? (origin.y - py) * mpp : (py - origin.y) * mpp
function imageView(): PlotView | null {
  const s = getState();
  if (!s.video || !s.origin || !s.metresPerPixel) return null;
  const { width: W, height: H } = s.video;
  const ox = s.origin.x, oy = s.origin.y, k = s.metresPerPixel;
  const minX = (0 - ox) * k;
  const maxX = (W - ox) * k;
  let minY: number, maxY: number;
  if (yUp) {
    minY = (oy - H) * k;
    maxY = (oy - 0) * k;
  } else {
    minY = (0 - oy) * k;
    maxY = (H - oy) * k;
  }
  return { minX, maxX, minY, maxY };
}

function drawPlot(gl: HTMLCanvasElement, ax: HTMLCanvasElement, recs: TrackRecord[]): void {
  const view = imageView();
  if (!view) return;
  const empty = plotMount().querySelector('.plot-empty') as HTMLElement | null;
  if (empty) empty.style.display = 'none';
  renderPlot(gl, ax, recs, view);
}

function ensurePlotCanvases(): { gl: HTMLCanvasElement; ax: HTMLCanvasElement } {
  const mount = plotMount();
  let gl = mount.querySelector('canvas.plot-gl') as HTMLCanvasElement | null;
  let ax = mount.querySelector('canvas.plot-ax') as HTMLCanvasElement | null;
  if (!gl) {
    gl = document.createElement('canvas');
    gl.className = 'plot-gl';
    mount.appendChild(gl);
  }
  if (!ax) {
    ax = document.createElement('canvas');
    ax.className = 'plot-ax';
    mount.appendChild(ax);
  }
  return { gl, ax };
}

function renderTable(records: TrackRecord[]): void {
  const tb = tableBody();
  const empty = tableEmpty();
  if (records.length === 0) {
    tb.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  // Show first 200 + last 50 to keep DOM small. (Full data is in state for export.)
  const head = records.slice(0, 200);
  const tail = records.length > 250 ? records.slice(-50) : [];
  const rows: string[] = [];
  const fmt = (v: number | null): string => v == null ? '—' : v.toFixed(3);
  for (const r of head) rows.push(rowHtml(r, fmt));
  if (tail.length) rows.push(`<tr class="row-skip"><td colspan="5">… ${records.length - 250} rows …</td></tr>`);
  for (const r of tail) rows.push(rowHtml(r, fmt));
  tb.innerHTML = rows.join('');
}

function rowHtml(r: TrackRecord, fmt: (v: number | null) => string): string {
  const lost = r[2] == null || r[3] == null;
  return `<tr class="${lost ? 'lost' : ''}"><td>${r[1].toFixed(3)}</td><td>${fmt(r[2])}</td><td>${fmt(r[3])}</td><td>${fmt(r[4])}</td><td>${fmt(r[5])}</td></tr>`;
}

// ── Mount: post-process controls in the side panel + reactive renders ──
export function mountResults(panel: HTMLElement): () => void {
  panel.innerHTML = `
    <h2>${t('results.title')}</h2>
    <div class="results-controls">
      <label class="field-label" for="smooth-mode">${t('results.smoothing')}</label>
      <select id="smooth-mode">
        <option value="none" selected>${t('results.smooth.none')}</option>
        <option value="ma5">${t('results.smooth.ma5')}</option>
        <option value="ma7">${t('results.smooth.ma7')}</option>
        <option value="sg5">${t('results.smooth.sg5')}</option>
      </select>
      <label class="check-row"><input type="checkbox" id="yup-flip" checked> ${t('results.yup')}</label>
      <fieldset class="export-options">
        <legend>${t('export.frequency')}</legend>
        <label class="stride-row">
          <input type="radio" name="export-mode" value="every" checked>
          <span>${t('export.every_frame')}</span>
        </label>
        <label class="stride-row">
          <input type="radio" name="export-mode" value="interval">
          <span>${t('export.every_n')}</span>
          <input type="number" id="export-n" min="2" step="1" value="2" disabled>
          <span class="stride-unit">${t('export.unit')}</span>
        </label>
      </fieldset>
      <div class="phase-actions">
        <button id="export-csv">${t('export.download')}</button>
        <button id="restart" class="secondary">${t('results.restart')}</button>
      </div>
    </div>
  `;

  smoothing = 'none';
  const sm = panel.querySelector('#smooth-mode') as HTMLSelectElement;
  sm.value = smoothing;
  sm.addEventListener('change', () => {
    smoothing = sm.value as Smoothing;
    recompute();
  });

  const yupChk = panel.querySelector('#yup-flip') as HTMLInputElement;
  yupChk.checked = yUp;
  yupChk.addEventListener('change', () => { yUp = yupChk.checked; recompute(); });

  const exportN = panel.querySelector('#export-n') as HTMLInputElement;
  const exportRadios = panel.querySelectorAll<HTMLInputElement>('input[name="export-mode"]');
  exportRadios.forEach(r => r.addEventListener('change', () => {
    const mode = (panel.querySelector('input[name="export-mode"]:checked') as HTMLInputElement).value;
    exportN.disabled = mode !== 'interval';
  }));

  panel.querySelector('#export-csv')!.addEventListener('click', () => {
    const mode = (panel.querySelector('input[name="export-mode"]:checked') as HTMLInputElement).value;
    let records = getState().records;
    if (mode === 'interval') {
      const n = Math.max(2, Math.floor(Number(exportN.value) || 2));
      records = records.filter((_, i) => i % n === 0);
    }
    downloadCsv(records, 'trajectory');
  });

  panel.querySelector('#restart')!.addEventListener('click', () => {
    rawSamples = [];
    plotMount().innerHTML = '';
    setState({
      records: [],
      trackedBboxes: null,
      startFrame: null,
      phase: 'navigate',
    });
  });

  // Per-frame tracked-bbox overlay: while scrubbing through the video in the
  // done phase, draw the recorded bbox for the current frame.
  setOverlayPainter((ctx, dw, dh) => {
    const s = getState();
    if (!s.trackedBboxes) return;
    const bb = s.trackedBboxes.get(s.frameIdx);
    if (!bb) return;
    const tl = origToDisp(bb.x, bb.y, s, dw, dh);
    const br = origToDisp(bb.x + bb.w, bb.y + bb.h, s, dw, dh);
    const cx = (tl.x + br.x) / 2;
    const cy = (tl.y + br.y) / 2;
    ctx.save();
    ctx.strokeStyle = '#a3e635';
    ctx.lineWidth = 2;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.fillStyle = '#a3e635';
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b0d10';
    ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });

  // Reactive updates whenever records change.
  ensurePlotCanvases();
  const unsub = subscribe((s) => {
    renderTable(s.records);
    if (s.records.length > 0) {
      const { gl, ax } = ensurePlotCanvases();
      drawPlot(gl, ax, s.records);
    }
  });

  // Initial render.
  renderTable(getState().records);
  if (getState().records.length > 0) {
    const { gl, ax } = ensurePlotCanvases();
    drawPlot(gl, ax, getState().records);
  }

  // Re-render the plot when the panel/plot area is resized via splitters.
  const onResize = (): void => {
    const recs = getState().records;
    if (recs.length === 0) return;
    const { gl, ax } = ensurePlotCanvases();
    drawPlot(gl, ax, recs);
  };
  window.addEventListener('resize', onResize);

  return () => {
    clearOverlayPainter();
    unsub();
    window.removeEventListener('resize', onResize);
  };
}
