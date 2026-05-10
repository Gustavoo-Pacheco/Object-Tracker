// Tracking phase: drives the per-frame loop.
//
// Flow:
//   1. Load opencv.js (if not already loaded).
//   2. Read the start frame, init Tracker on the user's bbox.
//   3. For each frame from startFrame+1 → totalFrames-1:
//        - readFrame (WebGPU pixel readback or fallback)
//        - tracker.update → bbox, center
//        - push raw sample, paint progress
//        - yield to event loop
//   4. Hand raw samples to the post-processor, which writes records.

import { getState, setState, triggerRender } from '../../state';
import { setOverlayPainter, clearOverlayPainter } from '../overlay';
import { origToDisp } from '../canvas';
import { Tracker } from '../../cv/tracker';
import { readFrame } from '../../video/frames';
import type { Sample } from '../../postprocess';
import { setRawSamples } from '../results';
import { t } from '../../i18n';

export function mountTracking(panel: HTMLElement): () => void {
  panel.innerHTML = `
    <h2>${t('tracking.title')}</h2>
    <div class="tracking-progress">
      <div class="progress-bar"><div class="progress-fill" id="prog-fill" style="width:0%"></div></div>
      <p class="hint" id="prog-text">0 / 0</p>
    </div>
    <div class="phase-actions">
      <button id="track-cancel" class="secondary">${t('tracking.cancel')}</button>
    </div>
  `;
  const fill = panel.querySelector('#prog-fill') as HTMLElement;
  const text = panel.querySelector('#prog-text') as HTMLElement;
  const cancelBtn = panel.querySelector('#track-cancel') as HTMLButtonElement;

  let cancelled = false;
  let liveBbox: { x: number; y: number; w: number; h: number } | null = null;
  let tracker: Tracker | null = null;

  // Live overlay painter — draws the currently-tracked bbox in green.
  setOverlayPainter((ctx, dw, dh) => {
    if (!liveBbox) return;
    const s = getState();
    const tl = origToDisp(liveBbox.x, liveBbox.y, s, dw, dh);
    const br = origToDisp(liveBbox.x + liveBbox.w, liveBbox.y + liveBbox.h, s, dw, dh);
    const cx = (tl.x + br.x) / 2;
    const cy = (tl.y + br.y) / 2;
    ctx.save();
    // Bright lime — high-contrast against the red axes and most footage.
    ctx.strokeStyle = '#a3e635';
    ctx.lineWidth = 2;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    // White centre dot with lime ring for unambiguous centre-of-bbox readout.
    ctx.fillStyle = '#a3e635';
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0b0d10';
    ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });

  cancelBtn.addEventListener('click', () => { cancelled = true; });

  void run();

  async function run(): Promise<void> {
    const s0 = getState();
    if (!s0.video || !s0.bbox) { abort('missing video or bbox'); return; }
    const { fps, totalFrames } = s0.video;
    const startFrame = s0.startFrame ?? 0;
    const video = document.getElementById('src') as HTMLVideoElement;

    // Initial frame.
    const initFrame = await readFrame(video, startFrame, fps);
    tracker = new Tracker();
    try {
      tracker.init(initFrame.pixels, initFrame.w, initFrame.h, s0.bbox);
    } catch (e) {
      abort((e as Error).message);
      return;
    }

    const samples: Sample[] = [{
      idx: startFrame,
      t: startFrame / fps,
      cxPx: s0.bbox.x + s0.bbox.w / 2,
      cyPx: s0.bbox.y + s0.bbox.h / 2,
    }];
    liveBbox = { ...s0.bbox };

    const total = totalFrames - 1 - startFrame;
    let processed = 0;
    let lost = 0;

    for (let i = startFrame + 1; i < totalFrames; i++) {
      if (cancelled) break;
      const frame = await readFrame(video, i, fps);
      const upd = tracker.update(frame.pixels);
      if (upd) {
        liveBbox = upd.bbox;
        samples.push({ idx: i, t: i / fps, cxPx: upd.center.cx, cyPx: upd.center.cy });
      } else {
        lost++;
        samples.push({ idx: i, t: i / fps, cxPx: null, cyPx: null });
      }

      // Drive UI: scrub video frame index so the canvas reflects current frame,
      // and update progress.
      processed++;
      setState({ frameIdx: i, status: t('status.tracking', { done: processed, total }) });
      triggerRender();
      const pct = Math.round((processed / total) * 100);
      fill.style.width = `${pct}%`;
      text.textContent = `${processed} / ${total}  ·  ${t('tracking.lost')}: ${lost}`;

      // Yield to keep UI responsive.
      if ((processed & 7) === 0) await new Promise<void>(r => setTimeout(r, 0));
    }

    tracker.dispose();
    tracker = null;
    setState({ status: t('status.done'), phase: 'done' });
    setRawSamples(samples);
  }

  function abort(reason: string): void {
    setState({ status: reason, phase: 'setup' });
  }

  return () => {
    cancelled = true;
    tracker?.dispose();
    tracker = null;
    liveBbox = null;
    clearOverlayPainter();
    panel.innerHTML = '';
  };
}
