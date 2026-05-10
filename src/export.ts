// CSV export: configurable subset of [frame, time, x, y, vx, vy].
// Trigger via downloadCsv(records, baseName, columns).

import type { TrackRecord } from './state';

export type CsvCol = 'frame' | 'time' | 'x' | 'y' | 'vx' | 'vy';
const ALL_COLS: CsvCol[] = ['frame', 'time', 'x', 'y', 'vx', 'vy'];
const COL_INDEX: Record<CsvCol, 0 | 1 | 2 | 3 | 4 | 5> = {
  frame: 0, time: 1, x: 2, y: 3, vx: 4, vy: 5,
};

export function buildCsv(records: TrackRecord[], columns: CsvCol[] = ALL_COLS): string {
  const cols = columns.length ? columns : ALL_COLS;
  const head = cols.join(',');
  const fmt = (v: number | null): string => v == null ? '' : Number.isInteger(v) ? String(v) : v.toFixed(6);
  const rows = records.map(r => cols.map(c => {
    const i = COL_INDEX[c];
    const v = r[i];
    if (c === 'frame') return String(v);
    if (c === 'time') return (v as number).toFixed(6);
    return fmt(v as number | null);
  }).join(','));
  return head + '\n' + rows.join('\n') + '\n';
}

export function downloadCsv(records: TrackRecord[], baseName = 'trajectory', columns?: CsvCol[]): void {
  const csv = buildCsv(records, columns);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}.csv`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
