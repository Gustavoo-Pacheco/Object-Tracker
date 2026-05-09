# Step 8 — Live trajectory plot (uPlot)

> **Goal**: A trajectory plot in the bottom panel that updates live as the tracker progresses, and stays usable after tracking is done. Three-tab view: Trajetória (x vs y), vx(t), vy(t) — same as the Excel report sheets.

> **Pre-flight (don't skip):** before writing any code in this step, re-read `01-scaffold.md` §1.6.5 (aesthetic guardrails) and §1.7 (i18n discipline — PT-BR only), plus `../PLAN.md` §5 (constraints). Run the anti-patterns checklist against your planned output. If you find purple, `rounded-2xl`, glassmorphism, Inter/Roboto/Space Grotesk, hardcoded user-facing strings, or any other listed violation in your output, revert and redo before committing.

## 8.0 Design questions for the user — ASK BEFORE BUILDING

> **Mandatory pause point.** §8.1 (library choice) and §8.2 (basic tab structure) can be implemented straight. Before generating the plot config, color choices, and tab UX in §§8.3–8.5, present these questions and **wait for answers**. Plot styling either reinforces or breaks the scientific-tool aesthetic.

Ask the user:

1. **Tab labels.** Default proposal: three tabs labeled `Trajetória` / `vx(t)` / `vy(t)`. Options: (a) text only (proposed), (b) text + tiny icon (e.g. ↗ for trajectory, sine wave for vx/vy), (c) just `Posição` / `Vel. X` / `Vel. Y`. Recommendation: (a) — math notation is more precise; users analyzing physics know `vx(t)`.

2. **Should there be a fourth "all velocities" tab?** Showing vx and vy on the same chart with a shared time axis. Useful for spotting correlation between axes. Options: (a) no, three tabs is enough for v1, (b) yes, add a 4th tab `v(t)` with both series + a legend. Recommendation: (b) — small win, one extra tab, very valuable for analysis.

3. **Trajectory plot style.** Default proposal: scatter points only, `var(--accent)` blue, no connecting line. Matches the Excel report. Options: (a) scatter (proposed), (b) line connecting points (smoother, but implies continuity that NaN gaps don't have), (c) line + scatter overlay. Recommendation: (a). Connecting lines lie about interpolated points.

4. **Velocity plot style.** Default proposal: solid line, no dots. Options: (a) line (proposed), (b) line + small dots at each sample point (shows where data actually is), (c) shaded area below the curve to zero. Recommendation: (b) — dots emphasize that this is sampled data, not continuous.

5. **Colors.** vx and vy need to be visually distinct. Current proposal: vx in `var(--accent)` blue (`#3B82F6`), vy in `var(--pink)` (`#F472B6`). Options: (a) blue + pink (proposed — high contrast on dark, matches existing palette), (b) blue + green, (c) two shades of blue (looks more "professional" but hard to tell apart). Recommendation: (a).

6. **Grid lines.** Options: (a) horizontal + vertical (full grid, scientific paper feel), (b) horizontal only (less noise, focuses on values), (c) none — only axis ticks. Recommendation: (b).

7. **Cursor / hover behavior.** When the user hovers over the plot, should they see (a) a vertical line at the cursor with the value at that x position, (b) just the closest data point highlighted with its `(x, y)` value in a tooltip, (c) both, (d) nothing — pure static plot. Recommendation: (b). uPlot's built-in cursor.

8. **Live updates during tracking.** The plot updates every ~10 frames as tracking runs. Options: (a) just update silently, (b) brief flash/pulse on the latest point as it lands (visual feedback that work is happening), (c) animate the whole curve in (slow, expensive). Recommendation: (a) — silent updates. The status text in the panel ("Rastreando: 312/600") is the progress indicator.

9. **Empty state — before any data exists.** Default mockup says muted text "No data yet. Track a video to see results." Options: (a) one line of muted text (proposed), (b) ASCII-art placeholder axes drawn faintly to suggest what the plot will look like, (c) hide the plot section entirely until data exists. Recommendation: (a) PT version: "Nenhum dado ainda. Conclua o rastreamento."

10. **Export plot as image?** v1 doesn't include this. Should it? Options: (a) no, defer to v2, (b) yes, add a small "Export PNG" button on each tab. Recommendation: (a) — defer. Easy to add in v2 via `canvas.toDataURL()`.

After answers, build §§8.3–8.5 with the agreed choices.

## 8.1 Why uPlot

- ~40 KB minified (vs ~80 KB Chart.js, ~500 KB Plotly).
- Optimized for incremental updates — `setData()` is fast even with 10 000 points.
- Renders to canvas, not SVG — important for live updates.
- API is low-level but small. Three options worth of charts is < 200 lines of code.

Install: `npm install uplot`.

## 8.2 Layout

The plot area in `index.html` becomes a tabbed view:

```html
<section id="plot">
  <nav class="plot-tabs">
    <button class="active" data-tab="traj" data-i18n="plot.tab.trajectory">Trajectory</button>
    <button data-tab="vx">vx(t)</button>
    <button data-tab="vy">vy(t)</button>
  </nav>
  <div id="plot-area"></div>
</section>
```

Switching tabs destroys the current uPlot instance and creates a new one with the appropriate config. uPlot is light enough that this is fine.

## 8.3 `src/plot/trajectory.ts`

```ts
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Record } from '../state';
import { t } from '../i18n';

type TabKey = 'traj' | 'vx' | 'vy';

let chart: uPlot | null = null;
let currentTab: TabKey = 'traj';

const colors = {
  trajectory: '#3B82F6',  // matches --accent
  vx: '#3B82F6',
  vy: '#F472B6',          // matches --pink for visual contrast
};

export function mountPlot(area: HTMLElement, tabs: NodeListOf<HTMLButtonElement>) {
  tabs.forEach(btn => btn.addEventListener('click', () => {
    tabs.forEach(b => b.classList.toggle('active', b === btn));
    currentTab = btn.dataset.tab as TabKey;
    redraw(area, []);  // will be re-fed with current records by caller
  }));
}

export function update(area: HTMLElement, records: Record[]) {
  redraw(area, records);
}

function redraw(area: HTMLElement, records: Record[]) {
  if (chart) { chart.destroy(); chart = null; }
  area.innerHTML = '';
  const valid = records.filter(r => r[2] !== null);
  if (valid.length < 2) return;

  if (currentTab === 'traj') {
    const xs = valid.map(r => r[2] as number);
    const ys = valid.map(r => r[3] as number);
    chart = new uPlot({
      width: area.clientWidth,
      height: area.clientHeight,
      scales: { x: { time: false }, y: { auto: true } },
      axes: [{ label: t('plot.axis.x') }, { label: t('plot.axis.y') }],
      series: [
        {},
        { stroke: colors.trajectory, points: { show: true, size: 4 }, paths: () => null },
      ],
    }, [xs, ys] as any, area);
  } else {
    const ts = valid.map(r => r[1]);
    const vs = valid.map(r => r[currentTab === 'vx' ? 4 : 5] as number).map(v => v ?? NaN);
    chart = new uPlot({
      width: area.clientWidth,
      height: area.clientHeight,
      scales: { x: { time: false }, y: { auto: true } },
      axes: [{ label: t('plot.axis.t') }, { label: currentTab === 'vx' ? t('plot.axis.vx') : t('plot.axis.vy') }],
      series: [
        {},
        { stroke: currentTab === 'vx' ? colors.vx : colors.vy, width: 2 },
      ],
    }, [ts, vs] as any, area);
  }
}
```

## 8.4 Live updates during tracking

In step 6's tracking loop, after every batch of 10 frames, also call:

```ts
plot.update(area, postProcess(currentRecords.slice(), origin, mpp));
```

Note: post-processing on a partial dataset means the trailing edge will have `null` velocity for the last point. Fine — uPlot draws gaps for NaN.

Performance check: tracking 1000 frames updates the plot 100 times. Each update destroys + recreates uPlot. Profile and switch to `chart.setData(...)` for incremental updates if needed:

```ts
if (chart) { chart.setData([xs, ys] as any); }
else { /* create */ }
```

## 8.5 Plot styling

Match the minimal scientific theme:
Match the dark theme:
- Background uses `var(--surface-1)` (panel/plot share the same dark surface).
- Light text on grid axes via `var(--fg)`/`var(--muted)`.
- Subtle gridlines via `var(--line)`.
- Tabular monospace for axis tick labels.
- No legend (single series each).
- Title above the canvas (in the tab area), not inside the chart.

Override uPlot CSS in `styles.css`:

```css
.uplot { font-family: var(--mono); color: var(--fg); }
.u-axis { color: var(--muted); }
.u-axis text { fill: var(--muted); }
.u-grid { stroke: var(--line); }
.u-cursor-pt { stroke: var(--accent); }
.plot-tabs { display: flex; border-bottom: 1px solid var(--line); padding: 0 12px; }
.plot-tabs button {
  background: transparent; border: 0; padding: 10px 14px;
  cursor: pointer; color: var(--muted); font-size: 12px;
  border-bottom: 2px solid transparent; border-radius: 0;
}
.plot-tabs button:hover { color: var(--fg); background: transparent; }
.plot-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
#plot-area { padding: 8px 12px; }
```

## 8.6 Resize handling

uPlot doesn't auto-resize. Add a `ResizeObserver`:

```ts
const ro = new ResizeObserver(() => {
  if (chart) chart.setSize({ width: area.clientWidth, height: area.clientHeight });
});
ro.observe(area);
```

## Definition of done

- [ ] After tracking, switching tabs renders all three views correctly.
- [ ] Trajectory shows scatter points (not connected line) — matches Excel report's `Trajectory` sheet.
- [ ] vx(t) is blue (`#3B82F6`, matches `--accent`), vy(t) is pink (`#F472B6`, matches `--pink`) for visual contrast on dark background.
- [ ] Plot updates live during tracking (at least every 10 frames).
- [ ] Resizing the window resizes the plot smoothly.
- [ ] Commit: `step 8: live trajectory plot with uplot`.
