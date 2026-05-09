# Step 10 — v2 roadmap

> **Goal**: A short, prioritized list of follow-up work. Don't implement these in v1. This file should be committed for future reference.

## High-value (do these first in v2)

### 1. Excel export
Port `make_report.py` to the browser using [SheetJS](https://github.com/SheetJS/sheetjs) (`xlsx` npm package).

Caveats:
- SheetJS doesn't support native Excel charts. Workaround: render uPlot to PNG via `chart.root.querySelector('canvas').toDataURL()` and embed the images in the .xlsx file as floating pictures.
- Filename: `<stem>_report.xlsx` to match the CLI.

Effort: ~1 day.

### 2. Move tracker to a Web Worker
The main-thread tracking loop is fine for short videos but freezes the UI on long ones. Move CSRT to a dedicated worker.

Steps:
- Vendor an OpenCV.js worker-friendly build.
- Create `src/tracker/worker.ts` that imports OpenCV and exposes a `tracker` API via `postMessage`.
- Transfer `ImageBitmap`s to the worker (they're transferable — zero-copy).
- Wire main thread to feed frames and receive results.

Effort: ~1-2 days.

### 3. Annotated MP4 export
Replicate the CLI's `_tracked.mp4` output (frames with bbox + axes overlay drawn in).

Approach: use the WebCodecs API (`VideoEncoder`) to encode an mp4. Available in Chrome 94+, Safari 17+, Firefox 130+. Fallback: encode a webm via `MediaRecorder` (universally supported but lower quality).

Effort: ~2-3 days. The harder part is muxing audio-less mp4 — use [mp4-muxer](https://github.com/Vanilagy/mp4-muxer).

## Medium-value

### 4. Light mode + theme toggle
v1 ships dark only. Add a light theme by overriding the four root CSS variables under `[data-theme="light"]`. Toggle button in the panel header. Persist choice in `localStorage`. The CSS architecture in step 1 already isolates colors into variables — adding light mode is mostly a single block.

Effort: ~2 hours.

### 5. Add English locale (and others)
v1 ships PT-BR only. The i18n architecture in step 1 already routes everything through `t()`, so adding EN is mostly a translation task: drop `i18n/en.json`, expand `i18n/index.ts` with a small locale switcher (~15 lines: `localStorage` for persistence, `navigator.language` for autodetect, an `onLocaleChange` event for the plot to re-render axis labels), and add a small EN/PT toggle in the panel header.

Effort: ~half a day for EN; ~30 min per additional locale (ES, FR, ZH) of decent translation work. Consider a Crowdin or PR-based contribution flow once there's user demand.

### 6. Multi-object tracking
v1 tracks one object. v2 should let users add multiple bounding boxes, each producing its own CSV. UI: a list of "Tracks" in the sidebar, each with its own bbox + delete button.

Refactor required: `state.records` becomes `state.tracks: Track[]` where each `Track` has its own bbox and records array. Plot tabs gain a per-track selector. CSV download becomes a zip if more than one track.

Effort: ~3-4 days. This is meaningful refactoring — pick a name (`Track`/`Object`/`Target`) and propagate.

### 7. Tracker selection
Expose `cv.TrackerKCF`, `cv.TrackerMIL`, `cv.TrackerMOSSE` alongside CSRT. Some are faster, some more robust. Let users switch and compare.

Effort: ~1 day. Requires testing each tracker's stability on real videos.

## Low-value / nice-to-have

### 8. Smoothing (Kalman / Savitzky-Golay)
Velocities from finite differences are noisy. Add an optional smoothing pass. Show before/after on the plot.

### 9. Acceleration column
The README mentions "position/velocity/acceleration as CSV". v1 ships position + velocity. Add `ax, ay` columns via central differences on velocity.

Effort: 1 hour. Update `track.py` and `make_report.py` in lockstep so the schema stays consistent.

### 10. Drop-zone for video upload
Currently file picker only. Add drag-and-drop on the `<main>` element.

Effort: <1 hour.

### 11. Keyboard-only operation
Audit the app: can someone with no mouse do everything? Probably not. Wire `Tab` order, add visible focus outlines, support Enter on the bbox phase.

### 12. Snapshot / share state
Generate a shareable URL that encodes (origin, scale, bbox, start frame) so two people analyzing the same video can compare.

URLs would balloon — encode as compressed JSON in the hash fragment, not the path. Effort: ~1 day.

## Things explicitly NOT to do

- **Don't add user accounts.** This is a single-page tool, not a SaaS.
- **Don't add a backend** for any reason. Adds operational cost; defeats the "free local tool" goal.
- **Don't replace OpenCV with a custom JS tracker.** CSRT is well-tested, well-known, and reproducible against the Python CLI. Resist the urge to "rewrite for purity."
- **Don't add analytics or telemetry.** The user is doing physics homework on potentially-private video. Privacy is a feature.

## How to choose what's next

When the user comes back to ask "what should v2 do?", weigh:
1. What broke or got asked about during v1 use? (Real signal beats hypothetical.)
2. What's blocking adoption by other users (teachers, students)?
3. What's a 1-day win vs a 1-week win? Prefer 1-day wins until a 1-week one is clearly justified.
