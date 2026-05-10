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

import { getState, setState } from '../../state';
import { setOverlayPainter, clearOverlayPainter } from '../overlay';
import { origToDisp, render } from '../canvas';
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
      <button id="track-stop" class="secondary">${t('tracking.stop')}</button>
    </div>
  `;
  const fill = panel.querySelector('#prog-fill') as HTMLElement;
  const text = panel.querySelector('#prog-text') as HTMLElement;
  const cancelBtn = panel.querySelector('#track-cancel') as HTMLButtonElement;
  const stopBtn = panel.querySelector('#track-stop') as HTMLButtonElement;

  let cancelled = false;
  let stopped = false;
  let liveBbox: { x: number; y: number; w: number; h: number } | null = null;
  let lastLost = false;
  let tracker: Tracker | null = null;

  // Live overlay painter — green when tracking, solid red when lost.
  setOverlayPainter((ctx, dw, dh) => {
    if (!liveBbox) return;
    const s = getState();
    const tl = origToDisp(liveBbox.x, liveBbox.y, s, dw, dh);
    const br = origToDisp(liveBbox.x + liveBbox.w, liveBbox.y + liveBbox.h, s, dw, dh);
    const cx = (tl.x + br.x) / 2;
    const cy = (tl.y + br.y) / 2;
    const color = lastLost ? '#ef4444' : '#a3e635';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    if (!lastLost) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b0d10';
      ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  });

  cancelBtn.addEventListener('click', () => { cancelled = true; });
  stopBtn.addEventListener('click', () => { stopped = true; });

  void run();

  async function run(): Promise<void> {
    const s0 = getState();
    if (!s0.video || !s0.bbox) { abort('missing video or bbox'); return; }
    const { fps, totalFrames } = s0.video;
    const startFrame = s0.startFrame ?? 0;
    const stride = Math.max(1, s0.frameStride | 0);
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
      lost: false,
    }];
    liveBbox = { ...s0.bbox };
    const trackedBboxes = new Map<number, { x: number; y: number; w: number; h: number }>();
    trackedBboxes.set(startFrame, { ...s0.bbox });
    const stage = document.getElementById('stage') as HTMLCanvasElement;
    // rAF-debounce the in-tracking preview. The tracking loop can iterate
    // faster than the display refresh, and we don't need to paint every
    // intermediate frame — just whatever is current at the next vsync.
    let rafPending = false;
    const schedulePreview = (): void => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        render(stage, video, getState());
      });
    };

    const total = Math.max(0, Math.floor((totalFrames - 1 - startFrame) / stride));
    let processed = 0;
    let lost = 0;

    for (let i = startFrame + stride; i < totalFrames; i += stride) {
      if (cancelled || stopped) break;
      const frame = await readFrame(video, i, fps);
      const upd = tracker.update(frame.pixels);
      if (upd) {
        liveBbox = upd.bbox;
        lastLost = false;
        trackedBboxes.set(i, { ...upd.bbox });
        samples.push({ idx: i, t: i / fps, cxPx: upd.center.cx, cyPx: upd.center.cy, lost: false });
      } else {
        // Keep the last known bbox visible (don't blank it) so the red LOST
        // overlay has something to draw on.
        lastLost = true;
        lost++;
        samples.push({ idx: i, t: i / fps, cxPx: null, cyPx: null, lost: true });
      }

      // Drive UI: update status + frameIdx, and render the canvas directly from
      // the just-seeked <video> element. We DO NOT route through the FrameCache
      // here — it would race with readFrame on the same video element, causing
      // visible frames to jump forward and backward during tracking.
      processed++;
      setState({ frameIdx: i, status: t('status.tracking', { done: processed, total }) });
      schedulePreview();
      const pct = Math.round((processed / total) * 100);
      fill.style.width = `${pct}%`;
      text.textContent = `${processed} / ${total}  ·  ${t('tracking.lost')}: ${lost}`;

      // Yield to keep UI responsive.
      if ((processed & 7) === 0) await new Promise<void>(r => setTimeout(r, 0));
    }

    tracker.dispose();
    tracker = null;

    if (cancelled) {
      const plotMount = document.getElementById('plot');
      if (plotMount) plotMount.innerHTML = '';
      const tableBody = document.getElementById('table-body');
      if (tableBody) tableBody.innerHTML = '';
      const tableEmpty = document.getElementById('table-empty');
      if (tableEmpty) tableEmpty.style.display = '';
      setState({
        status: '',
        records: [],
        trackedBboxes: null,
        frameIdx: startFrame,
        phase: 'navigate',
      });
      return;
    }

    setState({
      status: t('status.done'),
      trackedBboxes,
      frameIdx: startFrame,
      phase: 'done',
    });
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
