# Step 7 — Post-processing & CSV export

> **Goal**: Take the raw `records` array from step 6 and produce the same CSV format as `track.py`. Three transforms in order: interpolate gaps → trim edge NaNs → compute velocity → apply m/px and origin shift.

> **Pre-flight (don't skip):** before writing any code in this step, re-read `01-scaffold.md` §1.6.5 (aesthetic guardrails) and §1.7 (i18n discipline — PT-BR only), plus `../PLAN.md` §5 (constraints). Run the anti-patterns checklist against your planned output. If you find purple, `rounded-2xl`, glassmorphism, Inter/Roboto/Space Grotesk, hardcoded user-facing strings, or any other listed violation in your output, revert and redo before committing.

## 7.0 Design questions for the user — ASK BEFORE BUILDING

> **Mandatory pause point.** §§7.1–7.5 are pure logic (no UI) — proceed with those freely. Before generating the Results panel and Export options UI in §7.8, present these questions and **wait for answers**. The export UI is the last thing the user sees in the workflow; it should feel deliberate.

§§7.1–7.5 (interpolation, velocity, scaling, pipeline) and §7.6 (export module logic) can be implemented without questions — they're pure data transformations. Pause here, before §7.8.

Ask the user:

1. **Default open state of the Export options panel.** When the user reaches Results, should the Export controls be (a) always expanded showing all options, (b) collapsed showing only the active preset name with a "Customize" disclosure, or (c) a small "Export" button that opens a modal/popover? Recommendation: (a) — the user is here specifically to export. Hiding controls now makes them feel hidden.

2. **Format presentation.** Two formats (CSV, TXT). Options: (a) radio buttons stacked vertically, (b) a segmented control (two pills side-by-side), (c) a dropdown. Recommendation: (b) — segmented control feels more like a setting, less like a form.

3. **Column picker layout.** Seven columns to pick. Options: (a) vertical list of checkboxes (clear, takes space), (b) horizontal chip-style (compact: each column is a small toggleable pill), (c) two-column grid of checkboxes. Recommendation: (b) chip-style — feels like tags, very dense, scannable. Active chips have `var(--accent)` background; inactive have `var(--surface-2)`.

4. **Preset behavior.** Two presets (CLI-compatible, Spreadsheet). Options: (a) preset chips at the top — clicking sets all options below; (b) a small "Preset: X" line below the controls that auto-detects which preset matches; (c) both. Recommendation: (c) — preset chips at top for quick switching, auto-detect line below confirming "you're on Custom now."

5. **The CLI compatibility warning** appears when user diverges from default. Tone options: (a) amber/yellow inline text — informational, "FYI you've moved away from CLI default", (b) red-ish warning — "this won't work with make_report.py", (c) icon-only with hover tooltip. Recommendation: (a). The user knows what they're doing; don't scold.

6. **"Save as default" link.** Where should it sit visually? Options: (a) small text link next to the Preset readout, (b) a small button below the Download button, (c) auto-save silently and tell the user nothing. Recommendation: (a) — explicit, unobtrusive, confirming flash on click.

7. **Download button text.** Default proposal: `Baixar (drop_track.csv)` — filename in parens updates live with format. Options: (a) keep proposed, (b) split into a button + filename below ("Download" big, filename small underneath), (c) icon-only download button next to filename text. Recommendation: (a).

8. **What happens after download?** Options: (a) nothing — user stays on Results, can re-download with different settings, (b) brief toast "Downloaded drop_track.csv", (c) auto-advance to a "Done — analyse another video?" state. Recommendation: (b). 1.5s toast at the bottom of the panel, not a popup.

9. **Restart tracking button.** Should it (a) just reset to phase 1 (file picker), (b) reset to phase 4 (bbox) keeping origin and scale, or (c) ask "what do you want to redo?" with options. Recommendation: (c) — three sub-options: "Pick a different video", "Redo bbox only", "Start over completely". Adds a click but saves repeated origin/scale work.

After answers, build §7.8 according to the chosen design.

## 7.1 Interpolation (port of `_interpolate_records`)

Linear interpolation across `null` gaps that have valid neighbors on both sides. Edge gaps stay `null`.

```ts
// src/post/interpolate.ts
import type { Record } from '../state';

export function interpolate(records: Record[]): Record[] {
  const out = records.map(r => [...r] as Record);
  const n = out.length;
  let i = 0;
  while (i < n) {
    if (out[i][2] === null) {
      const gapStart = i;
      while (i < n && out[i][2] === null) i++;
      const gapEnd = i; // first valid index after gap (or n)
      const prevI = gapStart - 1;
      const nextI = gapEnd;
      if (prevI < 0 || nextI >= n) continue; // edge gap, leave as null
      const px = out[prevI][2]!, py = out[prevI][3]!;
      const nx = out[nextI][2]!, ny = out[nextI][3]!;
      const len = gapEnd - gapStart;
      for (let j = 0; j < len; j++) {
        const t = (j + 1) / (len + 1);
        out[gapStart + j][2] = +(px + t * (nx - px)).toFixed(3);
        out[gapStart + j][3] = +(py + t * (ny - py)).toFixed(3);
      }
    } else {
      i++;
    }
  }
  return out;
}
```

## 7.2 Trim edge NaNs (port of `_trim_edge_nans`)

```ts
// src/post/trim.ts
export function trimEdgeNaNs(records: Record[]): Record[] {
  let start = 0;
  while (start < records.length && records[start][2] === null) start++;
  let end = records.length - 1;
  while (end >= start && records[end][2] === null) end--;
  return records.slice(start, end + 1);
}
```

## 7.3 Velocity (port of `_compute_velocity`)

Central differences with one-sided fallback at edges. NaN positions → NaN velocities.

```ts
// src/post/velocity.ts
export function computeVelocity(records: Record[]): Record[] {
  const n = records.length;
  return records.map((rec, i) => {
    const [fi, t, x, y] = rec;
    if (x === null) return [fi, t, x, y, null, null];

    let xPrev = null, yPrev = null, dtPrev = null;
    let xNext = null, yNext = null, dtNext = null;

    if (i > 0 && records[i - 1][2] !== null) {
      xPrev = records[i - 1][2]; yPrev = records[i - 1][3];
      dtPrev = t - records[i - 1][1];
    }
    if (i < n - 1 && records[i + 1][2] !== null) {
      xNext = records[i + 1][2]; yNext = records[i + 1][3];
      dtNext = records[i + 1][1] - t;
    }

    let vx: number | null, vy: number | null;
    if (xPrev !== null && xNext !== null) {
      const span = dtPrev! + dtNext!;
      vx = (xNext - xPrev) / span;
      vy = (yNext! - yPrev!) / span;
    } else if (xNext !== null) {
      vx = (xNext - x!) / dtNext!;
      vy = (yNext! - y!) / dtNext!;
    } else if (xPrev !== null) {
      vx = (x! - xPrev) / dtPrev!;
      vy = (y! - yPrev!) / dtPrev!;
    } else {
      vx = vy = null;
    }
    return [fi, t,
            +x!.toFixed(3), +y!.toFixed(3),
            vx === null ? null : +vx.toFixed(3),
            vy === null ? null : +vy.toFixed(3)];
  });
}
```

## 7.4 Apply scale and origin

This step converts pixel coordinates (still in image space, not yet shifted to origin or scaled to metres) into the world coords the CSV expects.

**Important — match `track.py` order of operations**:

In `track.py`, the recorded `cx, cy` after origin shift is `wx = cx - origin_x`, `wy = -(cy - origin_y)`. That happens at record-time (during the loop). Velocity is computed in pixel-shift space. Then the whole record (x, y, vx, vy) is multiplied by `mpp`.

So in our port:

1. Step 6 records raw pixel `cx, cy` (no shift, no scale).
2. After step 6, we **first** shift: `wx = cx - originX`, `wy = -(cy - originY)`.
3. Then interpolate (works on shifted px values — same numerics either way since linear).
4. Then trim.
5. Then compute velocity (in shifted px / s).
6. Then scale: multiply x, y, vx, vy by `mpp`. Time is unchanged.

```ts
// src/post/world.ts
export function shiftToOrigin(records: Record[], origin: {x:number;y:number}): Record[] {
  return records.map(([fi, t, x, y, vx, vy]) => [
    fi, t,
    x === null ? null : x - origin.x,
    y === null ? null : -(y - origin.y),
    vx, vy,
  ] as Record);
}

export function applyScale(records: Record[], mpp: number): Record[] {
  const s = (v: number | null) => v === null ? null : +(v * mpp).toFixed(6);
  return records.map(([fi, t, x, y, vx, vy]) => [fi, t, s(x), s(y), s(vx), s(vy)] as Record);
}
```

## 7.5 Pipeline

```ts
// src/post/pipeline.ts
import { shiftToOrigin } from './world';
import { interpolate } from './interpolate';
import { trimEdgeNaNs } from './trim';
import { computeVelocity } from './velocity';
import { applyScale } from './world';

export function postProcess(raw: Record[], origin: {x:number;y:number}, mpp: number): Record[] {
  const shifted = shiftToOrigin(raw, origin);
  const interp = interpolate(shifted);
  const trimmed = trimEdgeNaNs(interp);
  const withV = computeVelocity(trimmed);
  return applyScale(withV, mpp);
}
```

## 7.6 Configurable export

Users get to choose what they download. Three independent axes:

1. **Format**: CSV (`.csv`) or plain text (`.txt`, tab-separated).
2. **Columns**: any subset of `frame, time, x, y, vx, vy, speed`.
3. **Header row**: include or omit.

The default preset is **`track.py`-compatible**: CSV, no header, columns `time,x,y,vx,vy`. That preset matches the Python CLI byte-for-byte and is the one verified in §7.7. Anything else the user picks is a deliberate departure — the round-trip test in §7.7 only applies to the default.

### Export options type

```ts
// src/export/options.ts
export type ColumnKey = 'frame' | 'time' | 'x' | 'y' | 'vx' | 'vy' | 'speed';

export type ExportOptions = {
  format: 'csv' | 'txt';
  columns: ColumnKey[];     // order matters — that's the column order in the file
  includeHeader: boolean;
};

export const DEFAULT_OPTIONS: ExportOptions = {
  format: 'csv',
  columns: ['time', 'x', 'y', 'vx', 'vy'],
  includeHeader: false,
};

export const COLUMN_META: Record<ColumnKey, { header: string; decimals: number; compute?: 'speed' }> = {
  frame:  { header: 'frame',           decimals: 0 },
  time:   { header: 'tempo (s)',       decimals: 4 },
  x:      { header: 'x (m)',           decimals: 6 },
  y:      { header: 'y (m)',           decimals: 6 },
  vx:     { header: 'vx (m/s)',        decimals: 6 },
  vy:     { header: 'vy (m/s)',        decimals: 6 },
  speed:  { header: 'velocidade (m/s)', decimals: 6, compute: 'speed' },
};
```

### Builder

```ts
// src/export/build.ts
import type { Record } from '../state';
import type { ExportOptions, ColumnKey } from './options';
import { COLUMN_META } from './options';

const SEP = { csv: ',', txt: '\t' } as const;

function valueFor(rec: Record, key: ColumnKey): number | null {
  switch (key) {
    case 'frame': return rec[0];
    case 'time':  return rec[1];
    case 'x':     return rec[2];
    case 'y':     return rec[3];
    case 'vx':    return rec[4];
    case 'vy':    return rec[5];
    case 'speed': {
      const vx = rec[4], vy = rec[5];
      if (vx === null || vy === null) return null;
      return Math.hypot(vx, vy);
    }
  }
}

export function buildExport(records: Record[], opts: ExportOptions): string {
  const sep = SEP[opts.format];
  const lines: string[] = [];

  if (opts.includeHeader) {
    const headers = opts.columns.map(c => COLUMN_META[c].header);
    lines.push(headers.join(sep));
  }

  for (const rec of records) {
    const cells = opts.columns.map(c => {
      const v = valueFor(rec, c);
      if (v === null) return '';
      const dp = COLUMN_META[c].decimals;
      return dp === 0 ? String(v) : v.toFixed(dp);
    });
    lines.push(cells.join(sep));
  }

  return lines.join('\n') + '\n';
}
```

**Notes:**
- `frame` and `time` are never `null` in trimmed records, but the formatter handles `null` defensively anyway in case the post-process pipeline changes.
- `speed = √(vx² + vy²)` — computed on-the-fly so it always agrees with vx/vy in the same row.
- TXT format uses **tab** as the separator (not space) so values can contain spaces in the future without ambiguity. Tab is the convention for `.txt` data exports in scientific tools (e.g. Logger Pro, Tracker).
- Header text is Portuguese (per `COLUMN_META`). Future EN release will switch on locale; for v1 it's a single string per column.

### Download

```ts
// src/export/download.ts
import type { ExportOptions } from './options';
import { buildExport } from './build';
import type { Record } from '../state';

export function downloadExport(stem: string, records: Record[], opts: ExportOptions) {
  const content = buildExport(records, opts);
  const ext = opts.format;
  const mime = opts.format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8';
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${stem}_track.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

Filename: `<video-stem>_track.<ext>` — `.csv` for the default, `.txt` for tab-separated.

### CLI compatibility note

The default options reproduce `track.py` byte-for-byte. Anything the user changes (adding `frame` or `speed`, enabling headers, switching to `.txt`) breaks compatibility with downstream tools that assume the original schema — including `make_report.py`. Surface this in the UI (§7.8). It's a feature, not a bug: the user is choosing to depart from the default.

## 7.7 Verification: round-trip against `track.py` (default preset only)

This is the single most important quality check in the project. Before declaring step 7 done:

1. Pick a sample video (commit to repo as `samples/drop.mp4`, ~2 MB).
2. Run `python track.py samples/drop.mp4` with a known origin/scale/bbox. Save the CSV.
3. Run the web app on the same video, choosing the **same** origin/scale/bbox visually.
4. Use the **default export options** (CSV, no header, `time,x,y,vx,vy`).
5. Diff the two CSVs.

The verification only applies to the default preset. Custom column selections, headers, or `.txt` output are deliberate departures from the CLI schema — those are the user's choice and not subject to the round-trip test.

You will see small differences (sub-pixel) because:
- Browser video decoding may produce slightly different pixel values vs OpenCV's video decoder.
- Float64 arithmetic order may differ.

**Acceptable tolerance**: positions within 1 pixel, velocities within 5%. Anything beyond means a logic bug, not a rounding issue.

Document this verification in `samples/README.md` with the diff command:

```bash
diff <(cut -d, -f1 samples/drop_track.csv) <(cut -d, -f1 samples/drop_track_web.csv)
```

## 7.8 Results UI with export options

After tracking finishes, the panel shows results + a collapsible "Export options" block. The block is **collapsed by default** showing the active preset summary; expanding it reveals the controls. Default = compatible-with-CLI; the user changes things only if they want to.

### Mockup

```
RESULTS
Frames tracked:      584
Frames interpolated: 4
Frames lost:         0
Total: 588 (of 600)

EXPORT
Format:    (•) CSV   ( ) TXT (tab-separated)
Columns:   [✓] time   [✓] x   [✓] y   [✓] vx   [✓] vy
           [ ] frame  [ ] speed (m/s)
Headers:   [ ] Include header row

Preset: ▾ track.py compatible
        · Save current as default

[ Download (drop_track.csv) ]    ← updates filename live as format changes
[ Restart tracking ]
```

The "Preset" line is the persistent display. Two built-in presets:
- **`track.py` compatible** (default) — CSV, no header, `time,x,y,vx,vy`.
- **Spreadsheet-friendly** — CSV, with header, `frame,time,x,y,vx,vy,speed`. For pasting into Excel / Google Sheets / Numbers without writing a header by hand.

User-modified settings show as **"Preset: Custom"** and the "Save current as default" link persists their choice via `localStorage` (key: `tracker.exportOptions`).

### Implementation

```ts
// src/ui/phases/results.ts
import { getState, setState } from '../../state';
import { t } from '../../i18n';
import { downloadExport } from '../../export/download';
import { DEFAULT_OPTIONS, ColumnKey, ExportOptions } from '../../export/options';

const STORAGE_KEY = 'tracker.exportOptions';
const COLUMNS: ColumnKey[] = ['frame', 'time', 'x', 'y', 'vx', 'vy', 'speed'];

const PRESETS: { id: string; labelKey: string; opts: ExportOptions }[] = [
  { id: 'cli',         labelKey: 'export.preset.cli',
    opts: { format: 'csv', columns: ['time','x','y','vx','vy'], includeHeader: false } },
  { id: 'spreadsheet', labelKey: 'export.preset.spreadsheet',
    opts: { format: 'csv', columns: ['frame','time','x','y','vx','vy','speed'], includeHeader: true } },
];

function loadStored(): ExportOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return DEFAULT_OPTIONS;
}

export function mountResults(panel: HTMLElement) {
  const s = getState();
  let opts: ExportOptions = loadStored();

  function activePresetId(): string | null {
    for (const p of PRESETS) {
      if (
        p.opts.format === opts.format &&
        p.opts.includeHeader === opts.includeHeader &&
        p.opts.columns.length === opts.columns.length &&
        p.opts.columns.every((c, i) => c === opts.columns[i])
      ) return p.id;
    }
    return null;
  }

  function render() {
    const tracked = s.records.filter(r => r[2] !== null).length;
    const lost = s.records.filter(r => r[2] === null).length;
    const stem = (s.video?.src ?? 'track').split('/').pop()!.replace(/\.[^.]+$/, '');
    const filename = `${stem}_track.${opts.format}`;
    const presetId = activePresetId();
    const presetLabel = presetId
      ? t(PRESETS.find(p => p.id === presetId)!.labelKey)
      : t('export.preset.custom');

    panel.innerHTML = `
      <h2>${t('results.title')}</h2>
      <ul class="kv">
        <li><span>${t('results.tracked')}</span><span class="tabular">${tracked}</span></li>
        <li><span>${t('results.lost')}</span><span class="tabular">${lost}</span></li>
        <li><span>${t('results.total')}</span><span class="tabular">${s.records.length}</span></li>
      </ul>

      <h2>${t('export.title')}</h2>

      <fieldset class="opt-group">
        <legend>${t('export.format')}</legend>
        <label><input type="radio" name="fmt" value="csv" ${opts.format==='csv'?'checked':''}> CSV (.csv)</label>
        <label><input type="radio" name="fmt" value="txt" ${opts.format==='txt'?'checked':''}> TXT (.txt, tab)</label>
      </fieldset>

      <fieldset class="opt-group">
        <legend>${t('export.columns')}</legend>
        ${COLUMNS.map(c => `
          <label>
            <input type="checkbox" data-col="${c}" ${opts.columns.includes(c)?'checked':''}>
            <span class="tabular">${c}</span>
          </label>`).join('')}
        <p class="hint">${t('export.columns_hint')}</p>
      </fieldset>

      <fieldset class="opt-group">
        <label><input type="checkbox" id="opt-header" ${opts.includeHeader?'checked':''}>
          ${t('export.include_header')}</label>
      </fieldset>

      <p class="preset-line">
        ${t('export.preset_label')}: <strong>${presetLabel}</strong>
        <a href="#" id="save-default">· ${t('export.save_default')}</a>
      </p>

      ${presetId === 'cli' ? '' : `<p class="hint warning">${t('export.cli_warning')}</p>`}

      <button id="download">${t('export.download', { filename })}</button>
      <button class="secondary" id="restart">${t('results.restart')}</button>
    `;

    // wire format
    panel.querySelectorAll<HTMLInputElement>('input[name="fmt"]').forEach(r => {
      r.addEventListener('change', () => { opts.format = r.value as 'csv'|'txt'; render(); });
    });
    // wire columns — preserve the canonical column order, not click order
    panel.querySelectorAll<HTMLInputElement>('input[data-col]').forEach(cb => {
      cb.addEventListener('change', () => {
        const col = cb.dataset.col as ColumnKey;
        if (cb.checked) {
          if (!opts.columns.includes(col)) {
            // re-insert in canonical order
            opts.columns = COLUMNS.filter(c => opts.columns.includes(c) || c === col);
          }
        } else {
          opts.columns = opts.columns.filter(c => c !== col);
        }
        render();
      });
    });
    // header toggle
    (panel.querySelector('#opt-header') as HTMLInputElement).addEventListener('change', e => {
      opts.includeHeader = (e.target as HTMLInputElement).checked;
      render();
    });
    // save default
    panel.querySelector('#save-default')!.addEventListener('click', e => {
      e.preventDefault();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(opts));
      // small confirmation flash
      (panel.querySelector('#save-default') as HTMLElement).textContent = '· ✓';
      setTimeout(render, 1200);
    });
    // download
    panel.querySelector('#download')!.addEventListener('click', () => {
      if (opts.columns.length === 0) return;  // disabled-ish UX would be better but at least don't crash
      downloadExport(stem, s.records, opts);
    });
    // restart
    panel.querySelector('#restart')!.addEventListener('click', () => {
      setState({ phase: 'navigate', records: [], bbox: null, startFrame: null });
    });
  }

  render();
}
```

### Validation rules

- **At least one column required** — if user unchecks all columns, the Download button visually disables (use `:disabled` styling) and shows an inline error: `t('export.errors.no_columns')`.
- **Column order is canonical** — checking columns in any order produces the same canonical order in the output: `frame,time,x,y,vx,vy,speed`. Users who want a custom order can post-process; this isn't worth a drag-handle UI in v1.
- **Speed without vx/vy** is allowed — speed is computed from the underlying records, not from the displayed columns. A user can export just `time,speed` if they want.

### CSS additions for `styles.css`

```css
.opt-group {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 10px 12px;
  margin: 0 0 10px;
}
.opt-group legend {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--muted);
  padding: 0 6px;
}
.opt-group label { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
.opt-group input[type="radio"], .opt-group input[type="checkbox"] { accent-color: var(--accent); }

.kv { list-style: none; padding: 0; margin: 0 0 16px; }
.kv li { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--line); }
.kv li span:first-child { color: var(--muted); }

.preset-line { font-size: 13px; color: var(--muted); margin: 8px 0; }
.preset-line strong { color: var(--fg); font-weight: 500; }
.preset-line a { color: var(--accent); text-decoration: none; }
.preset-line a:hover { text-decoration: underline; }

.hint.warning { color: #fbbf24; }   /* amber for the CLI-incompatible warning */
```

### i18n keys

All `export.*` and `results.*` keys are already defined in `i18n/pt-BR.json` (see step 1 §1.7). No new keys needed for this step. If you find yourself wanting to add a new user-facing string here, add it to `pt-BR.json` first and reference via `t()`.

## Definition of done

- [ ] `postProcess(raw, origin, mpp)` produces records identical in structure to `track.py` output.
- [ ] **Default preset** (CSV, no header, `time,x,y,vx,vy`) is byte-identical to a reference Python CSV — verify with sample video per §7.7.
- [ ] **Format toggle** works: switching to TXT changes separator to tab and extension to `.txt`. Filename in the Download button updates live.
- [ ] **Column picker** works: any subset of `frame, time, x, y, vx, vy, speed` exports correctly with values in canonical order. Speed = `√(vx² + vy²)`.
- [ ] **Header toggle** works: when on, first line is `tempo (s),x (m),...` (Portuguese, per `COLUMN_META`).
- [ ] **Preset detection** works: changing options away from the CLI preset shows "Custom"; matching the spreadsheet preset shows that label.
- [ ] **Save as default** persists to `localStorage` and survives reload.
- [ ] **CLI compatibility warning** appears (amber `hint.warning`) when active options ≠ `cli` preset.
- [ ] **Empty column selection** disables the Download button and shows the inline error.
- [ ] Download button works in Chrome, Firefox, Safari for both `.csv` and `.txt`.
- [ ] All UI strings come from `t()` — no hardcoded Portuguese in `results.ts` or `export/*.ts`.
- [ ] Counters in the panel match the actual record counts.
- [ ] Commit: `step 7: post-process pipeline + configurable export`.
