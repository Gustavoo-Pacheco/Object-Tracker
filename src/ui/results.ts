// Renders the trajectory plot (WebGPU) + the data table + manages the
// post-processing controls (smoothing dropdown, Y-up flip) and CSV export.

import { getState, setState, subscribe, type TrackRecord } from '../state';
import { process, type Sample, type Smoothing } from '../postprocess';
import { renderPlot } from '../gpu/plot';
import { downloadCsv } from '../export';
import { t } from '../i18n';

const tableBody = (): HTMLTableSectionElement => document.getElementById('table-body') as HTMLTableSectionElement;
const tableEmpty = (): HTMLElement => document.getElementById('table-empty')!;
const plotMount = (): HTMLElement => document.getElementById('plot')!;

let rawSamples: Sample[] = [];
let smoothing: Smoothing = 'sg5';
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
        <option value="none">${t('results.smooth.none')}</option>
        <option value="ma5">${t('results.smooth.ma5')}</option>
        <option value="ma7">${t('results.smooth.ma7')}</option>
        <option value="sg5" selected>${t('results.smooth.sg5')}</option>
      </select>
      <label class="check-row"><input type="checkbox" id="yup-flip" checked> ${t('results.yup')}</label>
      <div class="phase-actions">
        <button id="export-csv">${t('export.download')}</button>
        <button id="restart" class="secondary">${t('results.restart')}</button>
      </div>
    </div>
  `;

  const sm = panel.querySelector('#smooth-mode') as HTMLSelectElement;
  sm.value = smoothing;
  sm.addEventListener('change', () => {
    smoothing = sm.value as Smoothing;
    recompute();
  });

  const yupChk = panel.querySelector('#yup-flip') as HTMLInputElement;
  yupChk.checked = yUp;
  yupChk.addEventListener('change', () => { yUp = yupChk.checked; recompute(); });

  panel.querySelector('#export-csv')!.addEventListener('click', () => {
    downloadCsv(getState().records, 'trajectory');
  });

  panel.querySelector('#restart')!.addEventListener('click', () => {
    rawSamples = [];
    setState({
      records: [],
      bbox: null,
      phase: 'setup',
    });
  });

  // Reactive updates whenever records change.
  ensurePlotCanvases();
  const unsub = subscribe((s) => {
    renderTable(s.records);
    if (s.records.length > 0) {
      const { gl, ax } = ensurePlotCanvases();
      renderPlot(gl, ax, s.records);
    }
  });

  // Initial render.
  renderTable(getState().records);
  if (getState().records.length > 0) {
    const { gl, ax } = ensurePlotCanvases();
    renderPlot(gl, ax, getState().records);
  }

  return () => { unsub(); };
}
