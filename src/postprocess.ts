// Post-processing: smoothing, axis/scale conversion, velocity.
//
// Input: raw tracker centers in image-pixel coords, per frame.
// Output: TrackRecord rows in metres relative to the user-set origin
// (Y-up to match the on-screen axis tool), plus instantaneous velocity.

import type { TrackRecord } from './state';

export type Sample = { idx: number; t: number; cxPx: number | null; cyPx: number | null };
export type Smoothing = 'none' | 'ma5' | 'ma7' | 'sg5';

// ── Smoothing kernels ──────────────────────────────────────────
function movingAverage(xs: (number | null)[], window: number): (number | null)[] {
  const half = Math.floor(window / 2);
  const out: (number | null)[] = new Array(xs.length).fill(null);
  for (let i = 0; i < xs.length; i++) {
    let sum = 0; let n = 0;
    for (let k = -half; k <= half; k++) {
      const v = xs[i + k];
      if (v == null) continue;
      sum += v; n++;
    }
    out[i] = n > 0 ? sum / n : null;
  }
  return out;
}

// Savitzky–Golay, window=5, polynomial order 2 (quadratic). Coefficients from
// the standard SG table (centred difference).
const SG5 = [-3, 12, 17, 12, -3];
const SG5_NORM = 35;

function savitzkyGolay5(xs: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  for (let i = 0; i < xs.length; i++) {
    if (i < 2 || i > xs.length - 3) {
      out[i] = xs[i]; // edges: keep raw value
      continue;
    }
    let s = 0; let valid = true;
    for (let k = -2; k <= 2; k++) {
      const v = xs[i + k];
      if (v == null) { valid = false; break; }
      s += SG5[k + 2] * v;
    }
    out[i] = valid ? s / SG5_NORM : xs[i];
  }
  return out;
}

function smooth(xs: (number | null)[], mode: Smoothing): (number | null)[] {
  switch (mode) {
    case 'ma5': return movingAverage(xs, 5);
    case 'ma7': return movingAverage(xs, 7);
    case 'sg5': return savitzkyGolay5(xs);
    case 'none':
    default: return xs.slice();
  }
}

// ── Main pipeline ──────────────────────────────────────────────
export type ProcessOpts = {
  origin: { x: number; y: number };
  metresPerPixel: number;
  smoothing: Smoothing;
  yUp: boolean; // image Y-down → world Y-up flip
};

// Raw samples → finished TrackRecord[] in metres-from-origin with velocity.
export function process(samples: Sample[], opts: ProcessOpts): TrackRecord[] {
  const cxs = samples.map(s => s.cxPx);
  const cys = samples.map(s => s.cyPx);
  const sx = smooth(cxs, opts.smoothing);
  const sy = smooth(cys, opts.smoothing);

  const k = opts.metresPerPixel;
  const ox = opts.origin.x;
  const oy = opts.origin.y;
  const ySign = opts.yUp ? -1 : 1;

  // px → metres, origin-shifted.
  const xs: (number | null)[] = sx.map(v => v == null ? null : (v - ox) * k);
  const ys: (number | null)[] = sy.map(v => v == null ? null : ySign * (v - oy) * k);

  // Velocity: centred difference where possible, else forward/back.
  const out: TrackRecord[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const x = xs[i]; const y = ys[i];
    let vx: number | null = null;
    let vy: number | null = null;

    const prev = samples[i - 1]; const next = samples[i + 1];
    const xp = i > 0 ? xs[i - 1] : null;
    const xn = i < samples.length - 1 ? xs[i + 1] : null;
    const yp = i > 0 ? ys[i - 1] : null;
    const yn = i < samples.length - 1 ? ys[i + 1] : null;

    if (prev && next && xp != null && xn != null) {
      vx = (xn - xp) / (next.t - prev.t);
    } else if (prev && x != null && xp != null) {
      vx = (x - xp) / (s.t - prev.t);
    } else if (next && x != null && xn != null) {
      vx = (xn - x) / (next.t - s.t);
    }
    if (prev && next && yp != null && yn != null) {
      vy = (yn - yp) / (next.t - prev.t);
    } else if (prev && y != null && yp != null) {
      vy = (y - yp) / (s.t - prev.t);
    } else if (next && y != null && yn != null) {
      vy = (yn - y) / (next.t - s.t);
    }

    out.push([s.idx, s.t, x, y, vx, vy]);
  }
  return out;
}
