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
const TEMPLATE_LR = 0.05;     // learning rate for online template update
const ACCEPT_NCC = 0.30;      // below this NCC, treat the frame as "lost"

export class Tracker {
  private template: Float32Array | null = null;  // grayscale, mean-subtracted
  private templateNorm = 0;                       // sqrt(sum of squares)
  private tw = 0;
  private th = 0;
  private bbox: Bbox | null = null;
  private frameW = 0;
  private frameH = 0;

  // The cv arg is ignored — kept for API parity with the planned OpenCV path.
  constructor(_cv?: unknown) { /* no cv needed */ }

  init(pixels: Uint8Array, w: number, h: number, bbox: Bbox): void {
    this.frameW = w; this.frameH = h;
    const gray = toGray(pixels, w, h);
    this.bbox = clampBbox({ ...bbox }, w, h);
    this.tw = this.bbox.w;
    this.th = this.bbox.h;
    if (this.tw < 4 || this.th < 4) throw new Error('bbox too small for tracker');
    const tpl = cropFloat(gray, w, this.bbox.x, this.bbox.y, this.tw, this.th);
    const { centred, norm } = meanSubtractAndNorm(tpl);
    this.template = centred;
    this.templateNorm = norm;
  }

  update(pixels: Uint8Array): { bbox: Bbox; center: Center } | null {
    if (!this.template || !this.bbox) throw new Error('Tracker not initialised');
    const gray = toGray(pixels, this.frameW, this.frameH);

    // Search window centred on previous bbox, padded by SEARCH_PAD * size.
    const padX = Math.round(this.tw * SEARCH_PAD);
    const padY = Math.round(this.th * SEARCH_PAD);
    const sx = Math.max(0, this.bbox.x - padX);
    const sy = Math.max(0, this.bbox.y - padY);
    const ex = Math.min(this.frameW, this.bbox.x + this.tw + padX);
    const ey = Math.min(this.frameH, this.bbox.y + this.th + padY);
    const sw = ex - sx;
    const sh = ey - sy;
    if (sw < this.tw || sh < this.th) return null;

    const window = cropFloat(gray, this.frameW, sx, sy, sw, sh);
    const peak = nccPeak(window, sw, sh, this.template, this.tw, this.th, this.templateNorm);
    if (!peak) return null;
    if (peak.score < ACCEPT_NCC) return null;

    const newX = sx + peak.x;
    const newY = sy + peak.y;
    this.bbox = { x: newX, y: newY, w: this.tw, h: this.th };

    // Online template update — slow LR avoids drift on occlusions.
    const fresh = cropFloat(gray, this.frameW, newX, newY, this.tw, this.th);
    const { centred: freshC, norm: _freshN } = meanSubtractAndNorm(fresh);
    for (let i = 0; i < this.template.length; i++) {
      this.template[i] = (1 - TEMPLATE_LR) * this.template[i] + TEMPLATE_LR * freshC[i];
    }
    // Recompute norm after blending.
    let s = 0;
    for (let i = 0; i < this.template.length; i++) s += this.template[i] * this.template[i];
    this.templateNorm = Math.sqrt(s) || 1;

    return {
      bbox: this.bbox,
      center: { cx: newX + this.tw / 2, cy: newY + this.th / 2 },
    };
  }

  dispose(): void {
    this.template = null;
    this.bbox = null;
  }
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
function nccPeak(
  win: Float32Array, ww: number, wh: number,
  tpl: Float32Array, tw: number, th: number,
  tplNorm: number,
): { x: number; y: number; score: number } | null {
  const maxDX = ww - tw;
  const maxDY = wh - th;
  if (maxDX < 0 || maxDY < 0) return null;

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
      if (score > bestScore) {
        bestScore = score;
        bestX = dx; bestY = dy;
      }
    }
  }
  return { x: bestX, y: bestY, score: bestScore };
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
