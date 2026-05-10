// CSV export: frame, time, x, y (in metres, origin-shifted, Y-up).
// Trigger via downloadCsv(records, baseName).

import type { TrackRecord } from './state';

export function buildCsv(records: TrackRecord[]): string {
  const head = 'frame,time,x,y';
  const fmt = (v: number | null): string => v == null ? '' : Number.isInteger(v) ? String(v) : v.toFixed(6);
  const rows = records.map(([frame, t, x, y]) => `${frame},${t.toFixed(6)},${fmt(x)},${fmt(y)}`);
  return head + '\n' + rows.join('\n') + '\n';
}

export function downloadCsv(records: TrackRecord[], baseName = 'trajectory'): void {
  const csv = buildCsv(records);
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
