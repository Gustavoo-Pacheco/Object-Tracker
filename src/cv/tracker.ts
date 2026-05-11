// Pure-TypeScript template tracker (Normalised Cross-Correlation).
//
// Why not OpenCV TrackerMIL/CSRT: the vendored opencv.js (4.10.0 docs build)
// does not include any cv.Tracker* class nor cv.matchTemplate. Rather than
// require the user to compile a custom opencv_js.wasm, we implement the
// classic NCC template-matching tracker directly. It matches the cropped
// template against a search window centred on the previous bbox, picks the
// peak score, and (lightly) updates the template each frame.
//
// Limits vs. CSRT: no scale/rotation adaptation, weaker against occlusion.
// Strengths: zero deps, deterministic, runs in ~1-3 ms per frame for typical
// template/window sizes, integrates cleanly with the WebGPU pixel pipeline.

export type Bbox = { x: number; y: number; w: number; h: number };
export type Center = { cx: number; cy: number };

const SEARCH_PAD = 1.0;       // search window grows by template_dim * (1 + 2*pad)
// Lower LR reduces template drift along the motion direction. The integer-pixel
// NCC peak is always slightly misaligned during motion, so each adaptation
// smears the template toward the leading edge; over many frames the bbox ends
// up "leading" the object. 0.02 keeps adaptation for blur/lighting changes
// while curbing the drift.
const TEMPLATE_LR = 0.02;     // learning rate for online template update
// Lost detection is gated against a FROZEN reference template (the appearance
// at init time), not the drifting live template. This is what makes the lost
// flag actually fire — comparing against the live template would always score
// high since it adapts to whatever the tracker is matching.
// Commit gate uses the LIVE-template score (peak.score) — the live template
// adapts to the object's current appearance, so this stays high through blur
// and gradual changes. Frozen-reference score is used only to gate template
// updates (so we don't drift onto background) and as a long-term lost signal.
const LIVE_CONFIDENT_NCC = 0.45;  // live-template score required to commit bbox
const UPDATE_NCC = 0.60;          // frozen-ref score required to adapt live template
const REF_LOST_NCC = 0.25;        // frozen-ref score below this for many frames → fully lost
const LOST_PAD_GROWTH = 0.4;  // extra SEARCH_PAD per consecutive low-confidence frame
// Cap on the search window. Kept tight so that when a second visually similar
// object (e.g. a second ball) is nearby, the window cannot expand far enough
// to swallow it during a brief loss — otherwise the tracker would happily
// re-acquire onto the wrong target. Higher values trade identity for recall.
const MAX_PAD = 2.0;          // cap search window so a missing object can't grab a random match
const MAX_LOST_FRAMES = 2;    // surface "lost" to caller after this many misses
// Per-pixel std of the matched patch must exceed this fraction of the original
// template's std to be considered an object match. With NCC permissive enough
// to allow blur, the patch-std gate is the primary defense against the bbox
// jumping onto featureless background (sky, wall, floor) when the object
// leaves the frame. Blur reduces high-frequency content but preserves overall
// std, so this still passes blurred objects.
const MIN_PATCH_STD_RATIO = 0.45;
// Extra context captured around the user's bbox for the internal template.
// A tight bbox (no context) makes NCC extremely sensitive to small alignment
// errors — even a 1-px shift drops the score sharply and the tracker loses
// the object. Adding context gives the template stable anchor features. The
// reported bbox stays the user-drawn size; only the internal template grows.
const CONTEXT_PADDING = 0.3;  // 30% padding each side (template grows ~1.6x area)

export type TrackResult = { bbox: Bbox; center: Center; score: number };

export class Tracker {
  private template: Float32Array | null = null;  // grayscale, mean-subtracted, Hann-windowed (drifts)
  private templateNorm = 0;
  private refTemplate: Float32Array | null = null; // FROZEN appearance at init, Hann-windowed
  private refNorm = 0;
  private hann: Float32Array | null = null; // separable Hann window cached for freshC
  private tw = 0; // expanded template width (includes context padding)
  private th = 0; // expanded template height
  private bbox: Bbox | null = null; // expanded template top-left + size (internal)
  private userW = 0; // original user-drawn bbox size — reported back to caller
  private userH = 0;
  private padX = 0; // offset from expanded top-left to user bbox top-left
  private padY = 0;
  private frameW = 0;
  private frameH = 0;
  private lostFrames = 0;
  private minPatchNorm = 0; // patch-norm threshold: matches below are background

  // The cv arg is ignored — kept for API parity with the planned OpenCV path.
  constructor(_cv?: unknown) { /* no cv needed */ }

  init(pixels: Uint8Array, w: number, h: number, bbox: Bbox): void {
    this.frameW = w; this.frameH = h;
    const gray = toGray(pixels, w, h);
    const userBbox = clampBbox({ ...bbox }, w, h);
    this.userW = userBbox.w;
    this.userH = userBbox.h;
    if (this.userW < 4 || this.userH < 4) throw new Error('bbox too small for tracker');

    // Expand the bbox to capture surrounding context. The reported bbox keeps
    // the user-drawn size; only the internal template region grows. Clamp to
    // the frame and accept asymmetric padding when the bbox is near an edge.
    const wantPadX = Math.round(userBbox.w * CONTEXT_PADDING);
    const wantPadY = Math.round(userBbox.h * CONTEXT_PADDING);
    const tx = Math.max(0, userBbox.x - wantPadX);
    const ty = Math.max(0, userBbox.y - wantPadY);
    const ex = Math.min(w, userBbox.x + userBbox.w + wantPadX);
    const ey = Math.min(h, userBbox.y + userBbox.h + wantPadY);
    this.tw = ex - tx;
    this.th = ey - ty;
    this.padX = userBbox.x - tx;
    this.padY = userBbox.y - ty;
    this.bbox = { x: tx, y: ty, w: this.tw, h: this.th };

    const tpl = cropFloat(gray, w, tx, ty, this.tw, this.th);
    const { centred } = meanSubtractAndNorm(tpl);

    // Build separable Hann window and apply it to the centred template. The
    // window weights centre pixels (the object) more than edge pixels (the
    // padded context), so the context anchors the match without dominating it.
    this.hann = hannWindow2D(this.tw, this.th);
    for (let i = 0; i < centred.length; i++) centred[i] *= this.hann[i];

    // Norm must be recomputed because the window changed the values.
    let sq = 0;
    for (let i = 0; i < centred.length; i++) sq += centred[i] * centred[i];
    const norm = Math.sqrt(sq) || 1;

    this.template = centred;
    this.templateNorm = norm;
    this.refTemplate = new Float32Array(centred);
    this.refNorm = norm;
    this.minPatchNorm = norm * MIN_PATCH_STD_RATIO;
    this.lostFrames = 0;
  }

  update(pixels: Uint8Array): TrackResult | null {
    if (!this.template || !this.refTemplate || !this.bbox || !this.hann) throw new Error('Tracker not initialised');
    const gray = toGray(pixels, this.frameW, this.frameH);

    // Convert internal expanded bbox into the user-facing bbox for returns.
    const userBboxAt = (ix: number, iy: number): Bbox => ({
      x: ix + this.padX, y: iy + this.padY, w: this.userW, h: this.userH,
    });

    // Search window grows with consecutive low-confidence frames so a fast or
    // briefly-blurred object can be re-acquired instead of being permanently
    // lost outside the original window.
    const pad = Math.min(MAX_PAD, SEARCH_PAD + this.lostFrames * LOST_PAD_GROWTH);
    const padX = Math.round(this.tw * pad);
    const padY = Math.round(this.th * pad);
    const sx = Math.max(0, this.bbox.x - padX);
    const sy = Math.max(0, this.bbox.y - padY);
    const ex = Math.min(this.frameW, this.bbox.x + this.tw + padX);
    const ey = Math.min(this.frameH, this.bbox.y + this.th + padY);
    const sw = ex - sx;
    const sh = ey - sy;
    if (sw < this.tw || sh < this.th) return null;

    // Match using the (adapting) live template — better recall under appearance change.
    const window = cropFloat(gray, this.frameW, sx, sy, sw, sh);
    const peak = nccPeak(window, sw, sh, this.template, this.tw, this.th, this.templateNorm);
    if (!peak) {
      this.lostFrames++;
      if (this.lostFrames > MAX_LOST_FRAMES) return null;
      const ub = userBboxAt(this.bbox.x, this.bbox.y);
      return { bbox: ub, center: { cx: ub.x + ub.w / 2, cy: ub.y + ub.h / 2 }, score: 0 };
    }

    const newX = sx + peak.x;
    const newY = sy + peak.y;

    // Score the matched patch against the FROZEN reference. The frozen ref
    // is Hann-windowed, so we apply the same window to freshC before the dot
    // product — otherwise the centre/edge weighting differs and the score is
    // distorted. freshN (un-windowed std) is still used for the background gate.
    const fresh = cropFloat(gray, this.frameW, newX, newY, this.tw, this.th);
    const { centred: freshC, norm: freshN } = meanSubtractAndNorm(fresh);
    const freshCW = new Float32Array(freshC.length);
    for (let i = 0; i < freshC.length; i++) freshCW[i] = freshC[i] * this.hann[i];
    let dot = 0;
    let sqW = 0;
    for (let i = 0; i < this.refTemplate.length; i++) {
      dot += freshCW[i] * this.refTemplate[i];
      sqW += freshCW[i] * freshCW[i];
    }
    const freshNW = Math.sqrt(sqW) || 1;
    const refScore = dot / (freshNW * this.refNorm);

    // Background gate: a near-uniform patch cannot be the object even if NCC
    // scores high. Stops the bbox from jumping onto sky/wall/floor when the
    // object leaves frame. Blur preserves overall std so blurry objects pass.
    const isBackground = freshN < this.minPatchNorm;

    // Commit decision uses the LIVE-template score (peak.score) — that score
    // tracks the object's current appearance through blur and gradual change,
    // unlike refScore which collapses against blur on a sharp frozen template.
    const liveScore = peak.score;
    const reject = isBackground || liveScore < LIVE_CONFIDENT_NCC || refScore < REF_LOST_NCC;
    if (reject) {
      this.lostFrames++;
      // Local-only search: the bbox can only follow the object from its last
      // known position. Full-frame re-search was removed because when the
      // scene contains another visually similar object (two balls, etc.),
      // global re-acquisition jumped to the wrong one. The local window still
      // grows with lostFrames (LOST_PAD_GROWTH up to MAX_PAD), giving the
      // tracker a fighting chance on briefly-occluded or fast objects without
      // ever leaving the neighbourhood of the last sighting.
      if (this.lostFrames > MAX_LOST_FRAMES) return null;
      const ub = userBboxAt(this.bbox.x, this.bbox.y);
      return { bbox: ub, center: { cx: ub.x + ub.w / 2, cy: ub.y + ub.h / 2 }, score: refScore };
    }

    this.bbox = { x: newX, y: newY, w: this.tw, h: this.th };
    this.lostFrames = 0;

    // Adapt the windowed live template using the windowed fresh patch, so
    // the Hann weighting stays consistent across the template's lifetime.
    if (refScore >= UPDATE_NCC) {
      for (let i = 0; i < this.template.length; i++) {
        this.template[i] = (1 - TEMPLATE_LR) * this.template[i] + TEMPLATE_LR * freshCW[i];
      }
      let s = 0;
      for (let i = 0; i < this.template.length; i++) s += this.template[i] * this.template[i];
      this.templateNorm = Math.sqrt(s) || 1;
    }

    // Sub-pixel refinement of the reported center: fit a parabola to the NCC
    // score at the peak and its 4 neighbours, shift by the analytic maximum.
    // Internal bbox stays integer-aligned (cropFloat needs integer indices),
    // but the reported center is sub-pixel accurate.
    const ub = userBboxAt(newX, newY);
    return {
      bbox: ub,
      center: {
        cx: ub.x + ub.w / 2 + peak.subX,
        cy: ub.y + ub.h / 2 + peak.subY,
      },
      score: refScore,
    };
  }

  dispose(): void {
    this.template = null;
    this.refTemplate = null;
    this.hann = null;
    this.bbox = null;
  }
}

// Separable Hann window flattened to (w*h). Centre pixel ≈ 1, corners → 0.
function hannWindow2D(w: number, h: number): Float32Array {
  const wx = new Float32Array(w);
  const wy = new Float32Array(h);
  for (let i = 0; i < w; i++) wx[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, w - 1)));
  for (let i = 0; i < h; i++) wy[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, h - 1)));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = wx[x] * wy[y];
  }
  return out;
}

// ── Helpers ────────────────────────────────────────────────────

function toGray(rgba: Uint8Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // BT.601 luma — matches OpenCV's default cvtColor RGBA→GRAY.
    out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return out;
}

function cropFloat(
  src: Float32Array, srcW: number,
  x: number, y: number, w: number, h: number,
): Float32Array {
  const out = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    const sOff = (y + row) * srcW + x;
    const dOff = row * w;
    out.set(src.subarray(sOff, sOff + w), dOff);
  }
  return out;
}

function meanSubtractAndNorm(buf: Float32Array): { centred: Float32Array; norm: number } {
  let mean = 0;
  for (let i = 0; i < buf.length; i++) mean += buf[i];
  mean /= buf.length;
  const centred = new Float32Array(buf.length);
  let sq = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] - mean;
    centred[i] = v;
    sq += v * v;
  }
  return { centred, norm: Math.sqrt(sq) || 1 };
}

// Naive NCC over the search window — returns top-left of best template match.
// subX/subY are sub-pixel offsets from a parabolic fit around the peak, in
// the range [-0.5, +0.5]. They correct the integer-pixel snapping bias that
// otherwise pulls the bbox toward the leading edge during motion.
function nccPeak(
  win: Float32Array, ww: number, wh: number,
  tpl: Float32Array, tw: number, th: number,
  tplNorm: number,
): { x: number; y: number; score: number; subX: number; subY: number } | null {
  const maxDX = ww - tw;
  const maxDY = wh - th;
  if (maxDX < 0 || maxDY < 0) return null;

  // Store the full score grid so we can fit a parabola around the peak.
  const gw = maxDX + 1;
  const gh = maxDY + 1;
  const scores = new Float32Array(gw * gh);

  let bestScore = -Infinity;
  let bestX = 0, bestY = 0;

  // Precompute integral images for fast windowed mean/sumSq.
  const ii = integralImage(win, ww, wh);
  const ii2 = integralImageSq(win, ww, wh);

  const N = tw * th;

  for (let dy = 0; dy <= maxDY; dy++) {
    for (let dx = 0; dx <= maxDX; dx++) {
      // Window stats via integral images.
      const sum = areaSum(ii, ww + 1, dx, dy, tw, th);
      const sumSq = areaSum(ii2, ww + 1, dx, dy, tw, th);
      const mean = sum / N;
      const variance = sumSq - sum * mean;
      const winNorm = Math.sqrt(variance) || 1;

      // Cross-correlation between window patch and template.
      let cc = 0;
      for (let row = 0; row < th; row++) {
        const wOff = (dy + row) * ww + dx;
        const tOff = row * tw;
        for (let col = 0; col < tw; col++) {
          cc += (win[wOff + col] - mean) * tpl[tOff + col];
        }
      }
      const score = cc / (winNorm * tplNorm);
      scores[dy * gw + dx] = score;
      if (score > bestScore) {
        bestScore = score;
        bestX = dx; bestY = dy;
      }
    }
  }

  // Parabolic sub-pixel fit. For a quadratic y = a·x² + b·x + c sampled at
  // -1, 0, +1 with values f(-1)=L, f(0)=C, f(+1)=R, the vertex is at
  // x* = (L - R) / (2·(L - 2C + R)). Clamp to [-0.5, +0.5] for safety.
  let subX = 0, subY = 0;
  if (bestX > 0 && bestX < maxDX) {
    const L = scores[bestY * gw + (bestX - 1)];
    const C = bestScore;
    const R = scores[bestY * gw + (bestX + 1)];
    const denom = L - 2 * C + R;
    if (denom < 0) subX = Math.max(-0.5, Math.min(0.5, (L - R) / (2 * denom)));
  }
  if (bestY > 0 && bestY < maxDY) {
    const U = scores[(bestY - 1) * gw + bestX];
    const C = bestScore;
    const D = scores[(bestY + 1) * gw + bestX];
    const denom = U - 2 * C + D;
    if (denom < 0) subY = Math.max(-0.5, Math.min(0.5, (U - D) / (2 * denom)));
  }

  return { x: bestX, y: bestY, score: bestScore, subX, subY };
}

// Standard summed-area table of size (w+1)*(h+1).
function integralImage(src: Float32Array, w: number, h: number): Float64Array {
  const sw = w + 1;
  const ii = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      ii[(y + 1) * sw + (x + 1)] = ii[y * sw + (x + 1)] + row;
    }
  }
  return ii;
}

function integralImageSq(src: Float32Array, w: number, h: number): Float64Array {
  const sw = w + 1;
  const ii = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      row += v * v;
      ii[(y + 1) * sw + (x + 1)] = ii[y * sw + (x + 1)] + row;
    }
  }
  return ii;
}

function areaSum(ii: Float64Array, sw: number, x: number, y: number, w: number, h: number): number {
  const x2 = x + w; const y2 = y + h;
  return ii[y2 * sw + x2] - ii[y * sw + x2] - ii[y2 * sw + x] + ii[y * sw + x];
}

function clampBbox(b: Bbox, w: number, h: number): Bbox {
  b.x = Math.max(0, Math.min(b.x, w - 1));
  b.y = Math.max(0, Math.min(b.y, h - 1));
  b.w = Math.max(4, Math.min(b.w, w - b.x));
  b.h = Math.max(4, Math.min(b.h, h - b.y));
  return b;
}
