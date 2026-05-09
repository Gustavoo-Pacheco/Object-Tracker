# Step 4 — Phase 1: Navigate to start frame

> **Goal**: Ported behavior of `InteractiveSelector.navigate()` in `track.py`. User scrubs the video to find the frame where tracking should begin.

> **Pre-flight (don't skip):** before writing any code in this step, re-read `01-scaffold.md` §1.6.5 (aesthetic guardrails) and §1.7 (i18n discipline — PT-BR only), plus `../PLAN.md` §5 (constraints). Run the anti-patterns checklist against your planned output. If you find purple, `rounded-2xl`, glassmorphism, Inter/Roboto/Space Grotesk, hardcoded user-facing strings, or any other listed violation in your output, revert and redo before committing.

## 4.0 Design questions for the user — ASK BEFORE BUILDING

> **Mandatory pause point.** Before generating the panel UI in §4.1 and the keyboard handler in §4.3, present these questions to the user and **wait for their answers**. The mockup in §4.1 is a strawman — the user gets to shape it.

Ask the user:

1. **Frame scrubbing controls.** The default proposal stacks five controls: a number readout (`0 / 599`), a horizontal slider, a typeable number input, ±1/±10 jump buttons, and a hint line about keyboard shortcuts. That's a lot of controls for one job. Options: (a) keep all five (power users have options), (b) drop the buttons and keep only slider + number input (cleaner), (c) drop the number input and keep slider + buttons (touch-friendlier). Recommendation: (b) — cleanest, keyboard shortcuts cover what the buttons do.

2. **Time vs frame display.** Should the frame readout show `frame 234 / 599` or `7.80 s / 19.97 s`, or both? Physics analysis is time-domain — seconds are more meaningful. Options: (a) frame number only, (b) seconds only, (c) both stacked (`234 / 599` small above `7.80 s` large). Recommendation: (c).

3. **Slider visual.** The native HTML range slider is functional but ugly. Options: (a) keep native (free, accessible, keyboard works), (b) custom-styled native (track in `--line`, thumb in `--accent`, no JS), (c) custom slider with frame thumbnails on hover (looks great, expensive — defer to v2). Recommendation: (b).

4. **Confirm button placement.** Big primary action at the bottom of the panel, or sticky at the right edge of the screen? Recommendation: bottom of the panel — keeps the workflow linear.

5. **Should the user be able to type a timestamp directly?** E.g. "type `2.5` in seconds and jump there." Options: (a) frame number only (matches `track.py`), (b) frame number with a small "go to time" alternative input below. Recommendation: (a) for v1; revisit if users ask.

After answers, replace the §4.1 mockup with the agreed layout and proceed.

## 4.1 UI controls in the sidebar (#panel)

Replace the file input area, after a video is loaded, with this layout:

```
┌─ Object Tracker ────────────────┐
│ video.mp4                       │
│ 1920×1080 · 600 frames @ 30 fps │
│                                 │
│ ETAPA 1: ESCOLHER FRAME INICIAL │
│ [<<] [<] [▶︎ 0/599] [>] [>>]     │
│ ┌────────────────────────────┐  │
│ │ slider 0 ─────────────  599│  │
│ └────────────────────────────┘  │
│ Frame: [   0 ]                  │
│ Atalhos: ← → (±1), W/S (±10)    │
│                                 │
│ [ Confirmar frame inicial ]     │
└─────────────────────────────────┘
```

All visible text comes from `t()` keys defined in `i18n/pt-BR.json`. No hardcoded language anywhere in TS.

Add to step 1's `i18n/index.ts` import: `import { t } from '../../i18n';` at the top of every phase module.

## 4.2 `src/ui/phases/navigate.ts`

```ts
import { getState, setState } from '../../state';

export function mountNavigate(panel: HTMLElement, onConfirm: (idx: number) => void) {
  const s = getState();
  if (!s.video) return;

  panel.innerHTML = `
    <h2>${t('phase1.title')}</h2>
    <div class="frame-controls">
      <button data-jump="-10">«</button>
      <button data-jump="-1">‹</button>
      <span class="frame-display tabular" id="frame-display">0 / ${s.video.totalFrames - 1}</span>
      <button data-jump="1">›</button>
      <button data-jump="10">»</button>
    </div>
    <input type="range" id="scrub" min="0" max="${s.video.totalFrames - 1}" value="0" />
    <label>
      Frame: <input type="number" id="frame-input" min="0" max="${s.video.totalFrames - 1}" value="0" class="tabular" />
    </label>
    <p class="hint">${t('phase1.shortcuts')}</p>
    <button id="confirm-frame">${t('phase1.confirm')}</button>
  `;

  const scrub = panel.querySelector('#scrub') as HTMLInputElement;
  const numInput = panel.querySelector('#frame-input') as HTMLInputElement;
  const display = panel.querySelector('#frame-display') as HTMLElement;
  const confirm = panel.querySelector('#confirm-frame') as HTMLButtonElement;

  function jump(delta: number) {
    const s = getState();
    if (!s.video) return;
    const next = clamp(s.frameIdx + delta, 0, s.video.totalFrames - 1);
    setState({ frameIdx: next });
  }

  panel.querySelectorAll('[data-jump]').forEach(btn => {
    btn.addEventListener('click', () => jump(parseInt((btn as HTMLElement).dataset.jump!, 10)));
  });
  scrub.addEventListener('input', () => setState({ frameIdx: parseInt(scrub.value, 10) }));
  numInput.addEventListener('change', () => {
    const s = getState();
    if (!s.video) return;
    const n = clamp(parseInt(numInput.value, 10) || 0, 0, s.video.totalFrames - 1);
    setState({ frameIdx: n });
  });
  confirm.addEventListener('click', () => {
    setState({ startFrame: getState().frameIdx, phase: 'origin' });
    onConfirm(getState().frameIdx);
  });

  // Keep UI in sync with state changes
  return subscribeUI(() => {
    const s = getState();
    if (!s.video) return;
    if (scrub.value !== String(s.frameIdx)) scrub.value = String(s.frameIdx);
    if (numInput.value !== String(s.frameIdx)) numInput.value = String(s.frameIdx);
    display.textContent = `${s.frameIdx} / ${s.video.totalFrames - 1}`;
  });
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
```

`subscribeUI` is a wrapper around `subscribe` that returns the unsubscribe so we can clean up on phase transition.

## 4.3 Keyboard shortcuts (global, scoped to phase)

Match `track.py` exactly:

| Key | Action |
|---|---|
| ← / A | frame −1 |
| → / D | frame +1 |
| W / ↑ | frame +10 |
| S / ↓ | frame −10 |
| + / = | zoom in (center) |
| − | zoom out (center) |
| I | pan up |
| K | pan down |
| J | pan left |
| L | pan right |
| Enter / Space | confirm |
| Esc | cancel — return to upload state |

```ts
function attachNavKeys(unsubs: Array<() => void>) {
  const handler = (e: KeyboardEvent) => {
    if (getState().phase !== 'navigate') return;
    // ignore when typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    switch (e.key) {
      case 'ArrowLeft': case 'a': jump(-1); break;
      case 'ArrowRight': case 'd': jump(1); break;
      case 'ArrowUp': case 'w': jump(10); break;
      case 'ArrowDown': case 's': jump(-10); break;
      case 'Enter': case ' ': confirmCurrent(); break;
      case 'Escape': cancelToUpload(); break;
    }
    // zoom/pan shortcuts forwarded to canvas module
  };
  window.addEventListener('keydown', handler);
  unsubs.push(() => window.removeEventListener('keydown', handler));
}
```

Note: the global keydown handler should be installed once in `main.ts`, but only fire when `state.phase === 'navigate'` (or whatever phase needs it). A small router at the top of the handler keeps things sane.

## 4.4 Visual debounce

Frame seeking can lag a bit on long videos. To avoid janky scrubbing:

- The slider's `input` event sets state immediately so the number display updates.
- Frame *rendering* debounces by 16 ms (one rAF) — multiple rapid scrubs within a frame collapse into one decode.

Implement in `main.ts`:

```ts
let rafQueued = false;
subscribe(() => {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(async () => {
    rafQueued = false;
    const s = getState();
    if (!s.video) return;
    const bm = await cache.get(s.frameIdx);
    if (bm) render(canvas, bm, s);
  });
});
```

## Definition of done

- [ ] After upload, sidebar shows the navigate panel with all controls.
- [ ] Slider, number input, and ± buttons all change the frame; all stay in sync via state.
- [ ] Keyboard shortcuts match the table above and only fire in this phase.
- [ ] Scrubbing rapidly does not crash; rendering coalesces via rAF.
- [ ] "Confirm start frame" / "Confirmar frame inicial" sets `state.startFrame` and transitions `phase` to `'origin'`.
- [ ] Esc returns to idle (file picker again, state cleared).
- [ ] Commit: `step 4: phase 1 navigate`.
