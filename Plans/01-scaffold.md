# Step 1 — Scaffold

> **Goal**: A working Vite + TypeScript project that runs `npm run dev`, opens a blank page with the basic layout (video hidden, canvas, sidebar, plot div), and has OpenCV.js vendored locally.

> **Read order:**
> 1. Read §§1.1–1.3 (project init, gitignore, OpenCV vendoring) — straightforward setup.
> 2. **Stop. Read §1.0 (Design questions). Ask the user. Wait for answers.** Do not start §1.4 (HTML) until decisions are recorded.
> 3. Read §1.6.5 (Aesthetic guardrails) and §1.7 (i18n) in full *before* writing the CSS in §1.6 or completing §1.4. The guardrails are mandatory typography/color/layout/motion rules; writing CSS without them in mind means rewriting it.
> 4. Continue from §1.4 with answers + guardrails in hand.

## 1.0 Design questions for the user — ASK BEFORE BUILDING

> **Mandatory pause point.** Before finalizing the HTML layout in §1.4 and the CSS in §1.6, present these questions to the user and **wait for their answers**. Do not assume defaults. Do not proceed past §1.3 without answers. The user wants to be involved in visual and behavioral decisions; this is the contract.
>
> **How to ask:** present all questions in one message, grouped by category as below. Use a numbered list. For each question give one short paragraph of context, list the options, and state a recommendation — but make clear the recommendation is just a default to override. After the user answers, summarize what's decided in a short list, then continue.
>
> **If the user answers some but not all**, ask only the unanswered ones again — don't re-ask everything. **If the user says "you decide"**, take the recommendation and note it as a default that can be revisited.

### A. Overall layout

1. **Page layout.** Default proposal: 3-region grid — video stage top-left, control panel on the right (340px wide, full-height), trajectory plot bottom-left under the stage. Alternatives: (a) video full-width top, panel + plot stacked below; (b) video centered with panel as floating sidebar (Figma-style); (c) two-column with the plot inline inside the panel instead of a separate region. Recommendation: the default 3-region grid.

2. **Panel position.** Right or left? Right matches CAD tools, Figma, most editors. Left feels more like file-browser apps. Recommendation: right.

3. **Plot region size.** The plot row is 260px tall by default. Options: (a) keep 260px fixed, (b) make it resizable (drag handle between stage and plot), (c) make it collapsible (a toggle to hide/show the plot to maximize stage space). Recommendation: (c) — collapsible, since during the setup phases the plot is empty and could yield space to the stage.

### B. First impression & empty states

4. **Stage when no video is loaded.** Options: (a) dotted grid pattern (engineering/CAD vibe), (b) solid background matching body, (c) a subtle "Arraste um vídeo aqui" empty state with an upload icon — and the whole stage becomes a drag-drop target. Recommendation: (c).

5. **Panel before video upload.** Options: (a) just the title and file picker (minimal), (b) a brief "como funciona" with the 4 phases listed as a preview (educational), (c) a quoted example workflow with a sample video to try. Recommendation: (a) — minimalism wins; explanations belong in README.

6. **App title in panel header.** Options: (a) keep "Object Tracker" (works as a brand mark in any language), (b) change to "Rastreador de Objetos", (c) something punchier ("Movimento", "Trajeto", "Cinemática"). Recommendation: (a).

### C. How features behave

7. **Phase progression — strict or revisitable?** Once the user confirms a phase (e.g. set origin), can they go back to redo it without losing later phases? Options: (a) strict linear flow — going back resets all subsequent phases; (b) free navigation — each phase has an "Edit" button in the panel summary that jumps back without losing the others (origin can be re-set without redoing the bbox); (c) one-step-back only. Recommendation: (b) — free navigation, since users frequently realize their origin or scale was off only after seeing tracker results.

8. **Origin and scale visibility during later phases.** After origin is set, should the pink crosshair stay visible during the scale and bbox phases? After scale is set, should the reference line stay visible? Options: (a) all overlays persist (visual confirmation that previous decisions are still intact); (b) overlays fade to a low-opacity hint; (c) overlays disappear, only the current phase's controls show. Recommendation: (b) — fade to ~30% opacity. Confirms context without competing with the current task.

9. **Frame seeking during tracking.** Should the user see each frame being tracked in real time, or just a progress indicator? Options: (a) live preview — every tracked frame is rendered to the stage with the bbox drawn in real time (slow but informative); (b) progress bar only — stage shows the start frame, plot updates incrementally, no per-frame video update (faster); (c) live preview with a "fast mode" toggle to disable. Recommendation: (b). The plot updating live in the bottom panel already gives feedback. A 1000-frame live preview will be slow on most machines.

10. **What happens after tracking completes?** Options: (a) auto-stay on the start frame; (b) auto-advance to a "results" frame showing the trajectory drawn over the video; (c) auto-play the video with the tracked bbox annotated; (d) freeze on the last frame. Recommendation: (b) — show the start frame with the entire trajectory polyline overlaid in the stage, so the user can sanity-check at a glance.

11. **Lost-frame behavior.** When the tracker loses the object, the CLI marks the frame as `LOST`, draws the last valid bbox in red, and writes NaN to the CSV. In the web app, options: (a) match the CLI exactly; (b) pause tracking and let the user manually reposition the bbox to resume; (c) match CLI but show a warning toast every 10 lost frames. Recommendation: (a) for v1 — matches CLI behavior, post-process interpolation handles the gap. (b) is a nice v2 feature.

12. **Loading indicator for OpenCV (~10 MB).** First time the user advances to the tracking phase, OpenCV.js loads. Options: (a) blocking modal with progress bar, (b) inline loading message in the panel with determinate progress (non-blocking, user can still review prior phases), (c) start loading earlier — kick off the download as soon as a video is uploaded, in the background. Recommendation: (c) — proactive background fetch + inline progress in the panel; it's almost always done by the time the user finishes the 4 setup phases.

### D. Output & defaults

13. **Default export preset.** Step 7 ships two presets: "track.py compatível" (CSV, no header, 5 columns) and "Para planilhas" (CSV with header, 7 columns including frame and speed). Which is the default the user sees on first export? Recommendation: "track.py compatível" — it's the round-trip-tested format and matches the documented schema.

14. **Persistence between sessions.** Should the app remember anything between page reloads? Options: (a) nothing — fresh start every time (privacy-pure); (b) only the export preset (small, useful, low-stakes); (c) also the last video filename and tracker settings (NCC threshold, jump ratio); (d) full session restore (last bbox, origin, scale — though the video itself can't be restored, only metadata). Recommendation: (b). Fresh phases on every session keeps the tool reset-friendly; saved export preferences stop the user fighting the same toggle every time.

After the user answers, document the decisions inline in this file (replace each "Recommendation:" line with the chosen option, keep the alternatives for future reference) and proceed to §1.4.

## 1.1 Initialize project

Create the project at the repo root (alongside `track.py`, not inside a subfolder — the web app and the Python CLI share the repo).

```bash
npm create vite@latest . -- --template vanilla-ts
npm install
```

If `vite` complains about non-empty directory, accept the merge — Vite will not overwrite `track.py`, `make_report.py`, or `requirements.txt`.

## 1.2 Update `.gitignore`

Add to existing `.gitignore`:

```
node_modules/
dist/
.vite/
*.log
```

Keep all the existing Python entries.

## 1.3 Vendor OpenCV.js

Download into `public/opencv/`:

- `opencv.js` — main JS wrapper
- `opencv_js.wasm` — the WASM blob

Use the official build from `https://docs.opencv.org/4.x/opencv.js`. Pin to **OpenCV 4.10.0** or whatever is current at execution time — write the version into `public/opencv/VERSION.txt` so it's reproducible.

```bash
mkdir -p public/opencv
curl -L -o public/opencv/opencv.js https://docs.opencv.org/4.10.0/opencv.js
# The wasm is fetched by opencv.js at runtime; check what URL it requests on first load
# and vendor that file too. Run the dev server, watch network tab, save the wasm file.
```

**Why vendor instead of CDN**: the brief requires offline / local operation. CDN dependencies break that.

## 1.4 Layout HTML

Replace `index.html` with the structure from `PLAN.md` §3. Use semantic tags. `lang="pt-BR"` is hardcoded — there's no language switcher in v1.

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Object Tracker</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <main>
      <section id="stage-wrap">
        <video id="src" hidden playsinline muted></video>
        <canvas id="stage"></canvas>
      </section>
      <aside id="panel">
        <header class="panel-head">
          <h1 data-i18n="app.title">Object Tracker</h1>
        </header>
        <p id="status" data-i18n="status.empty">Carregue um vídeo para começar</p>
        <input type="file" id="file" accept="video/*" />
      </aside>
      <section id="plot"></section>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

## 1.5 `src/main.ts` skeleton

```ts
import './styles.css';

const status = document.getElementById('status') as HTMLElement;
const file = document.getElementById('file') as HTMLInputElement;
const canvas = document.getElementById('stage') as HTMLCanvasElement;

file.addEventListener('change', () => {
  if (file.files?.[0]) {
    status.textContent = `Carregado: ${file.files[0].name}`;
  }
});

// placeholder — drawn over in step 2
canvas.width = 640;
canvas.height = 360;
const ctx = canvas.getContext('2d')!;
ctx.fillStyle = '#f7f9fb';
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = '#1a85ff';
ctx.font = '16px ui-monospace, monospace';
ctx.fillText('Stage placeholder', 16, 32);
```

## 1.6 Minimal `styles.css` (dark theme)

Single source of theming via CSS variables. Near-black background, light text, blue accent. Tabular numerics for any column showing data. No light-mode toggle in v1 — design flag is `dark-mode`.

```css
:root {
  /* surfaces */
  --bg:        #0b0d10;   /* page background */
  --surface-1: #14171c;   /* panels, plot area */
  --surface-2: #1c2027;   /* hover / inputs */
  --line:      #262b33;   /* borders, gridlines */

  /* text */
  --fg:        #e6e9ef;   /* primary text */
  --muted:     #8a93a4;   /* secondary text, axis labels */

  /* accents */
  --accent:        #3b82f6;   /* primary actions */
  --accent-hover:  #5b9bff;
  --accent-fg:     #ffffff;
  --pink:          #f472b6;   /* origin/scale crosshair (matches CLI hot pink) */
  --green:         #4ade80;   /* bbox confirmed */
  --red:           #f87171;   /* lost frames, errors */

  /* fonts */
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: "Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}

* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  color: var(--fg);
  font-family: var(--sans);
  font-size: 14px;
  font-feature-settings: "ss01", "cv11";  /* Inter Tight stylistic alternates if available */
}

/* Atmospheric background — not pure black; subtle radial depth */
body {
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, rgba(59, 130, 246, 0.04) 0%, transparent 60%),
    var(--bg);
}

main {
  display: grid;
  grid-template-columns: 1fr 340px;
  grid-template-rows: 1fr 260px;
  grid-template-areas: "stage panel" "plot panel";
  height: 100vh;
  gap: 1px;
  background: var(--line);
}

#stage-wrap {
  grid-area: stage;
  background: var(--bg);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
#stage { max-width: 100%; max-height: 100%; cursor: crosshair; }

#panel {
  grid-area: panel;
  padding: 16px 20px;
  background: var(--surface-1);
  overflow-y: auto;
}
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
#panel h1 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: 0.2px; }
#panel h2 { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 20px 0 8px; }

#plot { grid-area: plot; background: var(--surface-1); }

.tabular { font-variant-numeric: tabular-nums; font-family: var(--mono); }

button {
  background: var(--accent); color: var(--accent-fg); border: none;
  padding: 8px 14px; border-radius: 6px; cursor: pointer;
  font-family: var(--sans); font-size: 13px; font-weight: 500;
  transition: background 0.12s ease;
}
button:hover { background: var(--accent-hover); }
button:disabled { background: var(--surface-2); color: var(--muted); cursor: not-allowed; }
button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
button.secondary:hover { background: rgba(59, 130, 246, 0.1); }

input[type="number"], input[type="text"], select {
  background: var(--surface-2); color: var(--fg);
  border: 1px solid var(--line); border-radius: 4px;
  padding: 6px 10px; font-family: var(--mono); font-size: 13px;
}
input[type="range"] { width: 100%; accent-color: var(--accent); }

.hint { color: var(--muted); font-size: 12px; margin: 6px 0; }
```

Pure black (`#000`) causes harsh contrast on OLED screens — `#0b0d10` is darker-than-Slack but not eye-searing. The atmospheric `body` gradient adds 4% blue-tinted glow at the top — invisible on first glance, but the workspace feels less flat than a single fill color.

## 1.6.5 Aesthetic guardrails — READ THIS BEFORE WRITING ANY UI

> **Mandatory.** Before generating any CSS, component layout, or visual element in steps 2-9, Claude Code re-reads this section. The dark theme variables in §1.6 are only the foundation — these guardrails are what make the interface feel intentional rather than generic.

### The aesthetic in one line

**Refined minimalism, developer-tool sensibility, scientific precision.** Think of how a debugger or a Linear/Raycast/Vercel surface looks — restrained, monochromatic with one assertive accent, monospace for anything numeric, typography doing the work that decoration usually does. The canvas + plot are the heroes; the chrome should disappear.

### Typography rules

The default font stack (Inter Tight + JetBrains Mono) is **not optional defaulting** — it is a deliberate choice. Install via `@fontsource`:

```bash
npm install @fontsource-variable/inter-tight @fontsource-variable/jetbrains-mono
```

In `src/main.ts` (top of file, before any other import):
```ts
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
```

This vendors the fonts into the bundle — they work offline, no Google Fonts CDN, no FOUT. Use:
- **Inter Tight** for all UI chrome: titles, labels, button text, status messages, instructional copy.
- **JetBrains Mono** for everything numeric or code-like: frame counters, time values, m/px readouts, axis tick labels, the `data-i18n` keys themselves never appear but the rendered numbers do.

Rules:
- **Never use Inter** (the regular one) — Inter Tight is denser and more characterful.
- **Never use Roboto, Arial, or "Helvetica"**.
- **Never use Space Grotesk** — it's the default "AI design" font and will date the project.
- **Tabular numerics on every number**: any element showing a numeric value gets `class="tabular"` (which sets `font-variant-numeric: tabular-nums` and the mono family). No exceptions — when frame counter goes from 99 → 100, the digits must not jump.
- **Title is small**: `#panel h1` is 16px, not 24px. The interface is tool-like, not marketing-like. Hierarchy comes from weight and color, not size.

### Color rules

Stick rigidly to the variables in §1.6. Specifically forbidden:
- ❌ **No purple** anywhere. No purple-to-pink gradients. No `#a855f7`, no `#8b5cf6`, no Stripe-style indigo. The accent is `#3B82F6` blue. That's the only chromatic color besides pink (origin crosshair only) and the status colors (green/red).
- ❌ **No card shadows** in dark mode. Drop shadows on dark surfaces look terrible. Separate panels with 1px borders (`var(--line)`) instead.
- ❌ **No `rounded-2xl` / `border-radius: 16px+` on everything**. Buttons: `6px`. Inputs: `4px`. Panels: `0px` (they meet the screen edges). The aesthetic is precise, not soft.
- ❌ **No glassmorphism** (`backdrop-filter: blur`). It's both performance-expensive and visually noisy on a tool that already shows video.
- ❌ **No gradient text**. Headlines stay solid `var(--fg)`.
- ✅ The `body` radial gradient in §1.6 is the *only* gradient in the entire app.
- ✅ When something is "active" or "selected", indicate it with a 2px bottom-border or left-border in `var(--accent)` — never with a filled background pill.

### Layout rules

- **Panels meet the screen edges.** No outer margins, no centered max-width container. The grid layout in §1.6 fills the viewport. This is a tool, not a webpage.
- **1px separator lines, not gaps.** The `gap: 1px` on the main grid + `background: var(--line)` underneath is the only divider needed between regions.
- **Generous internal padding inside the panel** (16-20px), tight vertical rhythm between controls (8-12px between siblings).
- **Phase headers (`h2`) are uppercase, 12-13px, letter-spaced**, in `var(--muted)`. They're labels, not titles.
- **Right-align numbers** in any list/table of values (use `text-align: right` on numeric cells). Labels left, values right is the scientific-tool convention.

### Motion rules

This is a tool, not a marketing site. Apply restraint:
- **Hover transitions**: 120ms, only on `background` and `color`. Nothing else.
- **No page-load animations.** No staggered reveals, no fade-ins. The UI is present immediately.
- **Phase transitions** can fade the panel content in 150ms — that's the only "animation" in the app.
- **Status text changes** without animation — values update directly. Tabular numerics make this readable without flashing.

### Required micro-details (these are the things that elevate it)

- **Focus rings on every interactive element**: `outline: 2px solid var(--accent); outline-offset: 2px;` — visible accessibility, not the browser default.
- **Cursor changes**: `cursor: crosshair` on the stage during origin/scale/bbox phases; `cursor: grab` / `grabbing` during pan; default elsewhere.
- **Selection color**: `::selection { background: var(--accent); color: var(--accent-fg); }` — matches the accent.
- **Scrollbar styling on `#panel`**: thin (8px), tracks invisible, thumb in `var(--line)` going to `var(--muted)` on hover. Webkit only is fine; Firefox falls back to default.
- **Empty states matter**: when the plot has no data, show a single line of muted text reading what's localized as `plot.empty` ("No data yet. Track a video to see results."). Not an icon. Not an illustration. Just the line.

### Anti-patterns checklist (paste this into your mental checklist before each commit)

When reviewing your own CSS/layout output, verify NONE of the following are present:

- [ ] Purple anywhere
- [ ] `border-radius` over 8px
- [ ] Box-shadows on cards or panels
- [ ] Inter (the regular one), Roboto, Arial, Space Grotesk
- [ ] Centered max-width container
- [ ] Pill-shaped active states (filled background)
- [ ] Glassmorphism / backdrop-filter
- [ ] Page-load animations
- [ ] Emoji as icons
- [ ] Gradient text or gradient buttons
- [ ] Generic shadcn/ui Card, Dialog, or Sheet components copy-pasted

If any of those appear, revert and try again before committing.

### Reference touchstones

When unsure how something should look, the closest visual references are: **Linear's settings panels**, **Vercel's dashboard tables**, **Raycast's command interface**, **Figma's developer panel**. NOT Notion, NOT Stripe's marketing site, NOT shadcn's example dashboard.

### How Claude Code uses this section

At the start of **every** step from 2 onward, Claude Code re-reads §1.6.5 in `01-scaffold.md` before generating any CSS or markup. The Definition of Done in each step now implicitly includes "passes the anti-patterns checklist above." If a step's CSS does any of those things, the step is not done.

## 1.7 i18n setup (PT-BR, future-proof for EN)

v1 ships **Portuguese only**. There is no UI language switcher. We still route every string through `t()` and a JSON dictionary so adding English (or any other locale) in v2 is a matter of dropping in a second JSON file — no code rewrite. The discipline costs nothing now and saves a lot later.

### `src/i18n/pt-BR.json`

```json
{
  "app.title": "Object Tracker",
  "status.empty": "Carregue um vídeo para começar",
  "status.loaded": "{name} carregado: {w}×{h}, {n} frames @ {fps} fps",
  "status.tracking": "Rastreando: {done}/{total}",
  "status.done": "Rastreamento concluído",
  "phase1.title": "Etapa 1: escolher frame inicial",
  "phase1.confirm": "Confirmar frame inicial",
  "phase1.shortcuts": "Atalhos: ← → (±1), W/S (±10), +/− (zoom), arraste = pan",
  "phase2.title": "Etapa 2: definir origem (0,0)",
  "phase2.instruction": "Clique no ponto que será a origem do sistema de coordenadas.",
  "phase2.confirm": "Confirmar origem",
  "phase3.title": "Etapa 3: definir escala",
  "phase3.instruction": "Clique em dois pontos com distância conhecida e digite a distância em metros.",
  "phase3.metres": "Distância em metros",
  "phase3.confirm": "Confirmar escala",
  "phase3.redo": "Refazer linha",
  "phase4.title": "Etapa 4: desenhar caixa delimitadora",
  "phase4.instruction": "Clique e arraste um retângulo em volta do objeto a rastrear.",
  "phase4.confirm": "Iniciar rastreamento",
  "phase4.redo": "Refazer caixa",
  "tracking.cancel": "Cancelar",
  "tracking.lost": "Frames perdidos",
  "tracking.elapsed": "Tempo decorrido",
  "results.title": "Resultados",
  "results.tracked": "Frames rastreados",
  "results.interpolated": "Frames interpolados",
  "results.lost": "Frames perdidos",
  "results.total": "Total",
  "results.restart": "Reiniciar rastreamento",
  "export.title": "Exportar",
  "export.format": "Formato",
  "export.columns": "Colunas",
  "export.columns_hint": "Escolha qualquer subconjunto. A ordem é fixa.",
  "export.include_header": "Incluir cabeçalho",
  "export.preset_label": "Configuração",
  "export.preset.cli": "Compatível com track.py",
  "export.preset.spreadsheet": "Para planilhas",
  "export.preset.custom": "Personalizada",
  "export.save_default": "Salvar como padrão",
  "export.download": "Baixar ({filename})",
  "export.cli_warning": "Estas opções diferem do padrão da CLI. A saída não será compatível com make_report.py.",
  "export.errors.no_columns": "Selecione pelo menos uma coluna.",
  "plot.tab.trajectory": "Trajetória",
  "plot.axis.x": "x (m)",
  "plot.axis.y": "y (m)",
  "plot.axis.t": "tempo (s)",
  "plot.axis.vx": "vx (m/s)",
  "plot.axis.vy": "vy (m/s)",
  "errors.video_load": "Falha ao carregar vídeo",
  "errors.opencv_load": "Falha ao carregar OpenCV",
  "errors.bbox_too_small": "Caixa delimitadora muito pequena",
  "loading.opencv": "Carregando OpenCV (~10 MB)…"
}
```

### `src/i18n/index.ts`

```ts
import ptBR from './pt-BR.json';

// PT-BR is the only locale in v1. The dict structure stays generic so
// adding a second JSON in v2 is one import + one if-statement away.
const dict: Record<string, string> = ptBR;

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = dict[key] ?? key;  // fall back to the key itself — visible bug, easy to spot
  if (vars) for (const [k, v] of Object.entries(vars)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** Replace text on every [data-i18n] element. Run once on init. */
export function applyDom() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n!;
    el.textContent = t(key);
  });
  document.documentElement.lang = 'pt-BR';
}
```

### Wire it in `main.ts`

```ts
import { applyDom } from './i18n';
applyDom(); // one-time pass for static [data-i18n] elements
```

That's it — no locale switcher, no `localStorage`, no `setLocale`. Just one dictionary and `t()`.

### Rules for Claude Code

- **No hardcoded user-facing strings anywhere outside `i18n/pt-BR.json`.** If you find yourself typing `"Confirmar"` or `"Selecione"` directly in a `.ts` file, that's a bug — add a key to the JSON and use `t('key')` instead.
- **Static elements use `data-i18n="key"`** in HTML and are translated by `applyDom()` once at boot.
- **Dynamic strings (template-built)** use `t('key', { name, w, h })` directly during DOM construction.
- **Phase modules**, when they re-render the panel, build the markup with `t()` calls inline — `data-i18n` only works for elements that exist at boot.
- **Console errors and dev-only messages** stay in English — they're for the developer, not the user.
- **CSV column headers when the user enables the header row** ARE translated (they're user-facing), but CSV columns themselves, file extensions, and numeric formats stay neutral — never localize the CSV schema (output schema is sacred per `PLAN.md` §5).
- **When adding a new feature, the new key lands in `pt-BR.json` in the same commit as its use.** A missing key falls back to the literal key (e.g. `"phase5.confirm"`) — visible in the UI, easy to spot.
- **Don't add `en.json` or any other locale in v1.** v2 will add EN; doing it now creates dead code and synchronization burden for no user-visible benefit.

## 1.8 First commit

```bash
git add .
git commit -m "step 1: scaffold vite+ts, vendor opencv.js, dark theme, pt-BR i18n"
```

## Definition of done

- [ ] `npm run dev` opens a page on `http://localhost:5173` with no console errors.
- [ ] The page shows the dark theme: near-black background, light text, blue accent on the file input button hover.
- [ ] Sidebar has the title (in PT-BR) and a file input. **No language switcher.**
- [ ] All visible text is Portuguese — no leftover English strings anywhere except in code comments and console messages.
- [ ] `<html lang="pt-BR">` is set (statically in the markup and confirmed by `applyDom()`).
- [ ] `t('any.key')` works at runtime; missing keys render as the key itself, not as `undefined`.
- [ ] `public/opencv/opencv.js` and `opencv_js.wasm` exist; `VERSION.txt` documents the version.
- [ ] `npm run build` produces a `dist/` folder; opening `dist/index.html` directly (file://) loads correctly.
- [ ] `.gitignore` excludes `node_modules`, `dist`, `.vite`.
- [ ] Single commit titled `step 1: scaffold ...`.
