# Object-Tracker Web App — Deployment Plan

> **For Claude Code.** Read this document end-to-end before starting work. Each numbered step has a companion file in `steps/` with full execution detail. Do not skip the design/decisions section — it encodes trade-offs that affect every later step.

> ## ⚠️ Mandatory pre-flight (do before EVERY step)
>
> Before generating any code, layout, or CSS in any step from 2 onward:
>
> 1. **Re-read `steps/01-scaffold.md` §1.6.5 (Aesthetic guardrails).** This is the non-negotiable visual style guide. Run the anti-patterns checklist mentally against your planned output before writing it.
> 2. **Re-read `steps/01-scaffold.md` §1.7 (i18n discipline).** All user-facing strings go through `t()` and live in `i18n/pt-BR.json`. v1 ships PT-BR only.
> 3. **Re-read `PLAN.md` §5 (Constraints).** The CSV schema and Y-axis flip and validation defaults are sacred.
> 4. **For steps that produce visible layout (1, 4, 5, 7, 8): STOP and read the §X.0 "Design questions for the user" block at the top of that step file. Ask the questions, wait for the user's answers, and only then start building.** Inferring defaults instead of asking is a violation. The user wants to be involved in visual decisions.
>
> If a step's output violates §1.6.5, §1.7, or skips the design questions, the step is not done — revert and redo. These are not suggestions.

---

## 0. Context

The repo currently contains a Python CLI:

- `track.py` — opens a video, lets the user scrub to a frame, set an origin, set a scale (m/px), draw a bounding box, then runs OpenCV's CSRT tracker frame-by-frame. Emits `<video>_track.csv` with columns `time, x, y, vx, vy` (no header) and an annotated `.mp4` next to it.
- `make_report.py` — reads that CSV and produces a multi-sheet `.xlsx` (Data, Trajectory, vx(t), vy(t)).

The README has been corrected: the web version uses **the same CLI tracker (CSRT)**, not ONNX. We port CSRT to the browser via OpenCV.js (WASM build of OpenCV).

The web app must:

- Run **entirely in the browser** — no backend.
- Be **free** to host (Vercel/Netlify static deploy).
- Be **runnable locally** (clone repo → `npm run dev`, or open built `dist/index.html`).
- Reproduce the CLI's output: per-frame `(x, y, vx, vy)` in metres, CSV export.
- Show a live trajectory plot in the browser.

---

## 1. Decisions (locked — change here if any are wrong before executing)

These are the choices Claude Code should follow unless overridden. One-line rationale per row.

| Area | Choice | Why |
|---|---|---|
| **Tracker** | OpenCV.js `cv.TrackerCSRT` (WASM) | Same algorithm as `track.py` → same output. No model files, no retraining. |
| **Framework** | **Vanilla TypeScript + Vite** | One page (video + canvas overlay + sidebar). React/Vue would triple bundle size for no gain. |
| **Plot library** | **uPlot** (~40 KB) | Lightest fast option for live `(x,y)` trajectory rendering. Chart.js as fallback if uPlot's API is awkward. |
| **CSV export** | Native `Blob` + `URL.createObjectURL` | Trivial, zero dependencies. |
| **Video decoding** | `<video>` element + seeking | Browsers decode mp4/webm natively. No ffmpeg.wasm needed. |
| **Hosting** | **Vercel** (or Netlify — see step 8) | Free static tier, auto-deploy on `git push`, custom domain free. |
| **Local run** | `npm run dev` (Vite) + built `dist/` is plain static HTML | Works offline once cloned. |
| **UI language** | **PT-BR only** (v1) | User's audience is Brazilian; ship one language well. EN added in v2 if demand appears — i18n architecture stays in place to make the future addition trivial. |
| **Style** | **Modern dark mode** — near-black background, light text, one accent (`#3B82F6`), monospaced numbers | Developer-tool aesthetic, easier on the eyes for long sessions analyzing video. |
| **Build tool** | **Claude Code** for implementation | Confirmed by user. 15-25 files across HTML/TS/CSS/build/CI; WASM glue needs iteration; want commits as you go. |

### Decision flags (flip here if needed before Claude Code starts)

```yaml
tracker: opencv-js-csrt
framework: vanilla-typescript-vite
plot_library: uplot          # alternatives: chart.js
hosting: vercel              # alternatives: netlify, github-pages
ui_language: pt-BR          # PT-BR only in v1; i18n module stays in place for future EN addition
design_style: dark-mode      # near-black bg, light fg, single accent
excel_export_v1: false       # CSV only in v1; xlsx deferred to v2
live_preview_v1: false       # tracker runs, plot updates after each frame, but no per-frame video preview window
```

---

## 2. v1 scope (what ships)

Confirmed must-haves:

1. **Video upload** — drag/drop or file picker, accepts `.mp4`/`.webm`/`.mov`.
2. **Frame scrubbing** — slider + arrow keys (±1) + W/S (±10), zoom + pan on the canvas.
3. **Set origin** — click to place (0,0), pink crosshair preview matches CLI.
4. **Set scale** — click two points, type metres, get m/px.
5. **Draw bbox** — click-drag rectangle, R to redo.
6. **Run tracker** — OpenCV.js CSRT, frame-by-frame, with the same NCC + jump validation as `track.py`.
7. **Live trajectory plot** — uPlot showing `(x, y)` updating as frames are tracked.
8. **CSV export** — download `<filename>_track.csv` with the same `time, x, y, vx, vy` schema.

### Explicitly OUT of v1

- Excel export (deferred — see v2 in step 9).
- Annotated video output (`_tracked.mp4`) — browsers can't easily encode mp4. Deferred to v2 with WebCodecs.
- Live per-frame video preview during tracking — too much DOM churn; we just update the plot and a progress bar.
- Multi-language UI.
- Dark mode.
- Tracker selection (always CSRT).

---

## 3. Architecture overview

```
index.html
└─ <video id="src" hidden>           ← decodes uploaded file
└─ <canvas id="stage">               ← shows current frame + overlays (axes, bbox, scale line, origin)
└─ <aside id="panel">                ← controls: upload, scrub, phase buttons, run, export
└─ <div id="plot">                   ← uPlot trajectory

src/
├─ main.ts                  Bootstraps app, wires phases together
├─ state.ts                 Single source of truth (current phase, frame, origin, scale, bbox, records)
├─ video/loader.ts          Load video file, expose seekToFrame(idx), getFrameImageData()
├─ video/cache.ts           LRU frame cache (matches FrameCache in track.py)
├─ ui/canvas.ts             Render frame + overlays, handle zoom/pan, mouse events
├─ ui/phases/navigate.ts    Phase 1: scrub to start frame
├─ ui/phases/origin.ts      Phase 2: click origin
├─ ui/phases/scale.ts       Phase 3: two-point + metres input
├─ ui/phases/bbox.ts        Phase 4: drag bbox
├─ tracker/opencv-loader.ts Lazy-load OpenCV.js WASM
├─ tracker/csrt.ts          Wrap cv.TrackerCSRT, frame-by-frame loop
├─ tracker/validate.ts      NCC + jump checks (port of _validate in track.py)
├─ post/interpolate.ts      Linear interpolation across NaN gaps (port of _interpolate_records)
├─ post/velocity.ts         Central differences (port of _compute_velocity)
├─ post/scale.ts            Apply m/px and shift to origin
├─ export/options.ts        ExportOptions type, presets, column metadata
├─ export/build.ts          buildExport(records, opts) → string
├─ export/download.ts       downloadExport(stem, records, opts) — Blob + click
├─ ui/phases/results.ts     Results panel + export options UI
├─ plot/trajectory.ts       uPlot setup + live update
├─ i18n/index.ts            t(key) function, dictionary loader
├─ i18n/pt-BR.json          Portuguese strings (v1 ships PT-BR only)
└─ styles.css               Dark theme (CSS variables, single source)

public/
└─ opencv/opencv.js + opencv_js.wasm   ← vendored, ~10 MB, lazy-loaded

vite.config.ts
tsconfig.json
package.json
.github/workflows/deploy.yml   (Vercel auto-deploys on push, but a CI lint/typecheck is still nice)
```

### Single-state model

All app state lives in one mutable object in `state.ts`. Each phase mutates it; the canvas + plot subscribe to changes. This avoids prop-drilling, makes Python ports straightforward (`InteractiveSelector` is one class — keep it that way), and is easy to debug.

```ts
type AppState = {
  phase: 'idle' | 'navigate' | 'origin' | 'scale' | 'bbox' | 'tracking' | 'done';
  video: { fps: number; width: number; height: number; totalFrames: number } | null;
  frameIdx: number;
  zoom: number;
  pan: { x: number; y: number };
  origin: { x: number; y: number } | null;     // pixels in original frame
  metresPerPixel: number | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  startFrame: number | null;
  records: Array<[number, number, number | null, number | null, number | null, number | null]>;
};
```

---

## 4. Step index

Each step is a separate `.md` in `steps/`. Execute in order; do not skip ahead. Each step ends with a "definition of done" section — Claude Code must satisfy every checkbox before moving on.

| # | File | Goal |
|---|---|---|
| 1 | `steps/01-scaffold.md` | Create Vite + TS project, vendor OpenCV.js, hello-world canvas. |
| 2 | `steps/02-state-and-canvas.md` | Implement `state.ts` and the canvas renderer (zoom/pan, axes overlay). |
| 3 | `steps/03-video-loader.ts` | Video upload, frame seek, frame cache. |
| 4 | `steps/04-phase-navigate.md` | Phase 1: scrub to start frame. |
| 5 | `steps/05-phase-origin-scale-bbox.md` | Phases 2-4: origin click, scale line + metres input, bbox drag. |
| 6 | `steps/06-tracker.md` | OpenCV.js CSRT loop with NCC + jump validation. |
| 7 | `steps/07-postprocess-and-export.md` | Interpolation, velocity, scaling, CSV download. |
| 8 | `steps/08-trajectory-plot.md` | uPlot live trajectory rendering. |
| 9 | `steps/09-deploy.md` | Vercel deploy, README update, repo cleanup. |
| 10 | `steps/10-v2-roadmap.md` | What v2 should add (Excel, mp4 output, light mode, more locales). |

---

## 5. Constraints Claude Code must respect

- **Output schema is sacred.** The CSV must match `track.py` byte-for-byte: no header, columns `time, x, y, vx, vy`, NaNs as empty strings, 6 decimal places for metres, 4 for time. Any future tooling that reads these files must keep working.
- **Y axis is flipped from image coords.** `track.py` does `wy = -(cy - origin_y)`. Same in the web port. Don't "fix" it.
- **NCC + jump validation is non-negotiable.** Skipping it produces garbage on occlusion. Port `_validate` faithfully — same defaults (`ncc_threshold=0.35`, `max_jump=0.40`).
- **No backend, ever.** No fetch to a server, no analytics, no telemetry. The only network call is loading OpenCV.js WASM on first use, and that should be vendored in `public/opencv/` so it works offline after first load.
- **Bundle budget**: app code (excluding OpenCV WASM) under 200 KB gzipped. OpenCV WASM (~10 MB) is loaded lazily after the user picks a video.
- **Browser support**: latest Chrome/Edge/Firefox/Safari. No IE, no polyfills for old Safari.
- **Aesthetic guardrails are mandatory.** `steps/01-scaffold.md` §1.6.5 is the non-negotiable visual style guide. Re-read it before writing any CSS, layout, or component in steps 2-9. The anti-patterns checklist (no purple, no `rounded-2xl`, no glassmorphism, no Inter/Roboto/Space Grotesk, etc.) blocks merge if violated.
- **i18n discipline is mandatory.** `steps/01-scaffold.md` §1.7 defines the rules: zero hardcoded user-facing strings outside `i18n/pt-BR.json`. Every new string lands in the JSON file in the same commit as its use. Re-read §1.7 before any step that adds UI text.
- **Interactive design checkpoints are mandatory.** Steps that produce visible layout (1, 4, 5, 7, 8) **must pause and ask the user clarifying questions before generating final markup/CSS.** Each of those step files contains a §X.0 "Design questions for the user" block listing what to confirm. Claude Code presents the questions, **waits for answers**, then proceeds. Skipping the questions and inferring defaults is a violation of step DoD.

---

## 6. Open questions for the user (resolve before step 6)

These don't block scaffolding (steps 1-5) but Claude Code should flag them when reaching the relevant step:

1. **Frame stepping during tracking** — should the tracker run on every frame or every Nth frame (`--step` flag)? CLI runs every frame. Web on long videos may be slow. Default: every frame, add a "Process every N frames" input later.
2. **What happens on tracking failure mid-video?** CLI marks frames as `LOST` and writes NaN, then linearly interpolates. Same behavior in web. But the user should be told visibly when frames are lost (counter in the panel). Confirm this UX.
3. **Mobile?** Tracker runs on phones in theory but the UI (zoom/pan with mouse) is desktop-first. v1 = desktop only. Acceptable?
4. **Domain name** — Vercel gives `<project>.vercel.app` free. Want a custom domain in v1 or later?

---

## 7. Success criteria (definition of done for the whole project)

- [ ] User can clone the repo, `npm install`, `npm run dev`, and have the app running locally in <2 minutes.
- [ ] User can upload a sample video, complete all phases, run the tracker, and download a CSV that is byte-for-byte interchangeable with `track.py` output.
- [ ] The deployed site loads at a public URL with HTTPS, with no broken assets, in <3 seconds on a fresh visit.
- [ ] README is rewritten with: what the tool does, screenshots/GIF, how to use the live site, how to run locally, how the tracker works.
- [ ] All steps 1-9 marked complete; step 10 (v2 roadmap) committed for future work.
