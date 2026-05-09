# Step 9 — Deploy + repo cleanup

> **Goal**: A live URL anyone can visit. Repo is cleanly structured. README explains both the web app and the Python CLI.

> **Pre-flight (don't skip):** before writing any code in this step, re-read `01-scaffold.md` §1.6.5 (aesthetic guardrails) and §1.7 (i18n discipline — PT-BR only), plus `../PLAN.md` §5 (constraints). Run the anti-patterns checklist against your planned output. If you find purple, `rounded-2xl`, glassmorphism, Inter/Roboto/Space Grotesk, hardcoded user-facing strings, or any other listed violation in your output, revert and redo before committing.


## 9.1 Choose Vercel or Netlify

Both are free for static sites of this scale. Pick by personal preference. Recommended **Vercel** for:
- Faster deploys.
- Git push → auto-deploy out of the box, no extra config.
- Custom headers via `vercel.json` (we need this for OpenCV WASM cache headers).

If the user prefers Netlify, the only changes are: `netlify.toml` instead of `vercel.json`, and the deploy CLI command.

## 9.2 Vercel setup (recommended)

### `vercel.json` at repo root

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "headers": [
    {
      "source": "/opencv/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

The COEP/COOP headers enable `SharedArrayBuffer`, which OpenCV.js uses for threaded ops if available. They don't break anything if not needed.

### Deploy

```bash
npm i -g vercel
vercel --prod
```

Or — preferred — connect the GitHub repo through `vercel.com/new`, which sets up auto-deploy on push to `main`. PRs get preview URLs automatically.

## 9.3 Netlify setup (alternative)

### `netlify.toml`

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[headers]]
  for = "/opencv/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
    Cross-Origin-Embedder-Policy = "require-corp"
    Cross-Origin-Opener-Policy = "same-origin"
```

Connect via netlify.com/start.

## 9.4 Bundle size check

```bash
npm run build
ls -lh dist/assets/
```

Acceptance:
- Main JS bundle (excluding OpenCV): under 200 KB gzipped. Run `gzip -c dist/assets/index-*.js | wc -c` to verify.
- `opencv.js` + WASM: ~10 MB total — that's fine since they load lazily and cache for a year.
- Total first-paint payload (HTML + CSS + main JS): under 100 KB transferred.

If the main bundle blows past 200 KB, run `npx vite-bundle-visualizer` to see what's pulling weight. uPlot, the OpenCV loader, and your code should be the only contributors.

## 9.5 Repo cleanup

Reorganize the repo so the Python CLI and web app coexist cleanly:

```
.
├─ README.md
├─ LICENSE
├─ .gitignore
├─ vercel.json
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ index.html
├─ public/
│  └─ opencv/
├─ src/
│  └─ ...
├─ samples/
│  ├─ drop.mp4
│  ├─ drop_track.csv         (reference output)
│  └─ README.md              (explains samples)
├─ cli/
│  ├─ track.py               (moved from root)
│  ├─ make_report.py         (moved from root)
│  └─ requirements.txt
└─ docs/                     (optional: screenshots, GIFs for README)
```

Moving `track.py` and `make_report.py` into `cli/` clarifies that the web app is now the primary deliverable. Update any internal paths if the scripts reference relative dirs (they don't currently — `videos/` and `output/` are CWD-relative).

## 9.6 README rewrite

The README must answer, in order:

1. **What is this?** One paragraph.
2. **Try it now** — link to deployed URL with screenshot/GIF.
3. **How to use** — 6 numbered steps with screenshots.
4. **Run locally (web app)** — `git clone && npm install && npm run dev`.
5. **Python CLI** — for users who want batch processing or already have the Python tool. Cover install, run, output schema.
6. **How tracking works** — 1 paragraph on CSRT, NCC, jump validation. Link to OpenCV docs.
7. **Output schema** — table of CSV columns + units.
8. **Limitations** — single-object only, desktop-first UI, no audio analysis, requires good contrast between target and background.
9. **License** — keep whatever's there, add MIT or similar if missing.

Keep it under 300 lines. Heavy detail belongs in `docs/`, not the README.

Add a screenshot or GIF — a 5-second screen recording of the full flow (upload → origin → scale → bbox → run → CSV download). Use ScreenToGif or similar. Save as `docs/demo.gif`, embed in README.

## 9.7 Smoke test post-deploy

After the first successful deploy, walk through this checklist on the live URL:

- [ ] Site loads in <3s on a fresh browser (no cache).
- [ ] Upload a sample video. App accepts it.
- [ ] Complete all 4 phases.
- [ ] OpenCV.js loads with the visible loading indicator.
- [ ] Tracking runs without console errors.
- [ ] CSV downloads with the right filename.
- [ ] Plot renders all three tabs.
- [ ] All visible UI text is in Portuguese — no English leaking through anywhere.
- [ ] Reload the page — OpenCV.js loads from cache (verify in DevTools Network: 200 from disk cache, not 200 from network).
- [ ] Mobile Safari: app loads, layout doesn't break (even if interactions are awkward).

## 9.8 Add CI (optional but recommended)

`.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build
      - run: npx tsc --noEmit
```

This catches type errors and broken builds before they hit `main`.

## Definition of done

- [ ] Site is live at a public HTTPS URL (e.g. `object-tracker.vercel.app`).
- [ ] Auto-deploy on push to `main` is configured.
- [ ] `vercel.json` (or `netlify.toml`) is committed.
- [ ] OpenCV WASM is served with year-long cache headers.
- [ ] Repo is reorganized: `cli/` for Python, `src/` + root for web.
- [ ] README is rewritten and includes a working demo GIF.
- [ ] CI pipeline runs `tsc --noEmit` and `npm run build` on PRs.
- [ ] The smoke test in 9.7 all passes.
- [ ] Final commit: `step 9: deploy to <vercel|netlify> + readme`.
