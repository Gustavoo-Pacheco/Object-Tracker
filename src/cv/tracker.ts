// Channel and Spatial Reliability Tracker (CSRT) — pure-TS, fixed-size.
//
// Drop-in replacement for the previous NCC template tracker. Public API
// (Tracker.init/update/dispose, Bbox/Center/TrackResult) and lost-frame
// semantics (return null after MAX_LOST_FRAMES) are byte-identical so the
// caller in src/ui/phases/tracking.ts needs no edits. Bbox is fixed-size
// in this Phase 1 — only the center moves; w/h stay at userW/userH.
//
// Why DCF over NCC: the filter is trained against an ideal Gaussian
// target so it learns what makes the object *distinct from its
// surroundings* rather than memorising the pixel grid. That gives
// robustness to gradual appearance change and in-plane rotation that
// NCC's frozen template can't match.
//
// Iteration 2 — drift control. Plain DCF retrains every confident frame
// and contaminates itself: a 1-px misalignment feeds background into the
// filter, the next peak shifts further off, and the bbox slides off the
// object while reporting high PSR the whole time. To stop that:
//   - Keep a FROZEN reference filter from init. Use its PSR on the
//     current patch as a sanity gate: if the reference filter can't
//     find the object, freeze the live filter for this frame
//     (and after MAX_LOST_FRAMES bad ref frames, surface as LOST).
//   - APCE (Average Peak-to-Correlation Energy) as a second-opinion on
//     response sharpness — guards against flat noisy responses.
//   - Trust region on per-frame displacement — large jumps are filter
//     errors, not real motion.
//   - Per-channel reliability via per-channel PSR (not peak height),
//     so channels that learned background structure get down-weighted.
//
// Simplifications vs. Lukežič et al. 2017:
//   - HoG-only features (gradient-orientation channels at pixel
//     resolution + raw intensity). ColorNames LUT omitted.
//   - Closed-form multi-channel DCF; spatial mask applied as feature
//     weighting (equivalent to one ADMM step at infinite mu).

export type Bbox = { x: number; y: number; w: number; h: number };
export type Center = { cx: number; cy: number };
export type TrackResult = { bbox: Bbox; center: Center; score: number };

const SEARCH_AREA_SCALE = 1.8;       // (down from 2.0 — see Iter-3 notes)
const N_ORIENT_BINS = 9;
const USE_INTENSITY = true;
const LAMBDA = 1e-4;
const LEARNING_RATE = 0.0125;        // filter EMA (down from 0.02 — see Iter-2 notes)
const HIST_LEARNING_RATE = 0.005;    // histograms/mask adapt slower than the filter
const HIST_BINS = 6;                 // 6×6×6 RGB foreground/background histogram
const PSR_COMMIT_THRESHOLD = 5.0;    // live PSR required to move the bbox
const REF_PSR_CONSENSUS_THRESHOLD = 5.0; // ref PSR required to *vote* on position
const REF_PSR_UPDATE_THRESHOLD = 6.5;// ref PSR required to retrain the live filter
const REF_PSR_LOST_THRESHOLD = 3.5;  // ref PSR below this for MAX_LOST_FRAMES → null
const CONSENSUS_RADIUS_FRACTION = 0.15; // |live-peak − ref-peak| ≤ this × min(intW,intH) → agree
const APCE_RATIO_THRESHOLD = 0.4;    // current APCE vs. median of recent APCEs
const APCE_HISTORY_LEN = 10;
const TRUST_REGION_FRACTION = 0.4;   // max |dx|,|dy| per frame, fraction of internal size
const PSR_NORM = 20.0;               // PSR → score in ~[0,1] for the caller
const MAX_LOST_FRAMES = 2;
const MIN_INIT_SIDE = 16;
const CONTEXT_PADDING = 0.3;
const GAUSS_SIGMA_FRACTION = 0.15;   // target-Gaussian σ (up from 0.10 — wider, more forgiving)
const LOCALIZATION_SIGMA_FRACTION = 0.25; // filter spatial-domain falloff σ
const PSR_EXCLUSION_RADIUS = 5;      // sidelobe exclusion box around peak (px)
const INNER_PRIOR_WEIGHT = 0.7;      // mask floor inside user bbox
const MASK_HARD_CUTOFF = 0.1;        // posterior below this in outer ring → 0

const N_CHANNELS = N_ORIENT_BINS + (USE_INTENSITY ? 1 : 0);

export class Tracker {
  // Frame/bbox state ------------------------------------------------------
  private frameW = 0;
  private frameH = 0;
  private userW = 0;
  private userH = 0;
  private internalW = 0;
  private internalH = 0;
  private centerX = 0;
  private centerY = 0;
  private lostFrames = 0;

  // FFT geometry ----------------------------------------------------------
  private fftW = 0;
  private fftH = 0;

  // Persistent buffers (allocated in init) --------------------------------
  private hann: Float32Array | null = null;
  private spatialMask: Float32Array | null = null;
  private localizationFalloff: Float32Array | null = null; // spatial-domain filter mask
  private targetRe: Float64Array | null = null;
  private targetIm: Float64Array | null = null;
  private filterRe: Float64Array[] | null = null;     // live (adapting) filter
  private filterIm: Float64Array[] | null = null;
  private channelW: Float32Array | null = null;
  private refFilterRe: Float64Array[] | null = null;  // frozen at init
  private refFilterIm: Float64Array[] | null = null;
  private refChannelW: Float32Array | null = null;
  private fgHist: Float32Array | null = null;
  private bgHist: Float32Array | null = null;

  // APCE ring buffer ------------------------------------------------------
  private apceHistory: Float32Array | null = null;
  private apceIndex = 0;
  private apceCount = 0;

  constructor(_cv?: unknown) { /* no cv needed */ }

  init(pixels: Uint8Array, w: number, h: number, bbox: Bbox): void {
    this.frameW = w;
    this.frameH = h;
    const b = clampBbox({ ...bbox }, w, h);
    if (b.w < MIN_INIT_SIDE || b.h < MIN_INIT_SIDE) {
      throw new Error('bbox too small for tracker');
    }
    this.userW = b.w;
    this.userH = b.h;

    this.internalW = Math.round(b.w * (1 + 2 * CONTEXT_PADDING));
    this.internalH = Math.round(b.h * (1 + 2 * CONTEXT_PADDING));

    this.centerX = b.x + b.w / 2;
    this.centerY = b.y + b.h / 2;

    const patchW = Math.round(SEARCH_AREA_SCALE * this.internalW);
    const patchH = Math.round(SEARCH_AREA_SCALE * this.internalH);
    this.fftW = nextPow2(patchW);
    this.fftH = nextPow2(patchH);

    const N = this.fftW * this.fftH;
    this.hann = hannWindow2D(this.fftW, this.fftH);

    const sigma = GAUSS_SIGMA_FRACTION * Math.sqrt(this.internalW * this.internalH);
    const g = gaussianTarget(this.fftW, this.fftH, sigma);
    this.targetRe = new Float64Array(N);
    this.targetIm = new Float64Array(N);
    for (let i = 0; i < N; i++) this.targetRe[i] = g[i];
    fft2d(this.targetRe, this.targetIm, this.fftW, this.fftH, false);

    const { R, G, B } = cropRGBPatch(pixels, w, h, this.centerX, this.centerY, this.fftW, this.fftH);
    const innerMask = innerBoxMask(this.fftW, this.fftH, this.userW, this.userH);
    const seeded = buildColorHistograms(R, G, B, innerMask);
    this.fgHist = seeded.fgHist;
    this.bgHist = seeded.bgHist;
    this.spatialMask = bayesPosteriorMask(R, G, B, this.fgHist, this.bgHist, this.fftW, this.fftH, this.userW, this.userH);

    // Spatial localization mask — Gaussian falloff centred at patch
    // centre, used to suppress filter coefficients far from the object.
    // Without this, the closed-form DCF gives the filter support across
    // the entire FFT patch (the "S" missing from Phase 1 CSRT); in
    // cluttered backgrounds those tails accumulate spurious correlations
    // and drag the peak onto background structure.
    const locSigma = LOCALIZATION_SIGMA_FRACTION * Math.max(this.internalW, this.internalH);
    this.localizationFalloff = gaussianTarget(this.fftW, this.fftH, locSigma);

    const features = extractFeatures(R, G, B, this.fftW, this.fftH);
    const solved = solveDCFFilter(features, this.hann, this.spatialMask, this.targetRe, this.targetIm, this.fftW, this.fftH);

    // One ADMM step against a fixed spatial prior: project filter into
    // spatial domain, multiply by combined localization mask, FFT back.
    const combinedMask = combinedLocalization(this.localizationFalloff, this.spatialMask);
    applySpatialLocalization(solved.filterRe, solved.filterIm, combinedMask, this.fftW, this.fftH);

    this.filterRe = solved.filterRe;
    this.filterIm = solved.filterIm;
    this.channelW = solved.channelW;

    // Frozen reference: deep copies of the localized filter and reliability
    // vector at init. The reference never adapts and acts as a sanity gate
    // (and now a position voter — see consensus in update()).
    this.refFilterRe = solved.filterRe.map(a => new Float64Array(a));
    this.refFilterIm = solved.filterIm.map(a => new Float64Array(a));
    this.refChannelW = new Float32Array(solved.channelW);

    this.apceHistory = new Float32Array(APCE_HISTORY_LEN);
    this.apceIndex = 0;
    this.apceCount = 0;
    this.lostFrames = 0;
  }

  update(pixels: Uint8Array): TrackResult | null {
    if (!this.filterRe || !this.filterIm || !this.refFilterRe || !this.refFilterIm
        || !this.hann || !this.targetRe || !this.targetIm || !this.spatialMask
        || !this.fgHist || !this.bgHist || !this.channelW || !this.refChannelW
        || !this.apceHistory) {
      throw new Error('Tracker not initialised');
    }
    const N = this.fftW * this.fftH;

    // 1. Crop search patch, extract features, FFT each channel once.
    const { R, G, B } = cropRGBPatch(pixels, this.frameW, this.frameH, this.centerX, this.centerY, this.fftW, this.fftH);
    const features = extractFeatures(R, G, B, this.fftW, this.fftH);
    const featRe: Float64Array[] = new Array(N_CHANNELS);
    const featIm: Float64Array[] = new Array(N_CHANNELS);
    for (let c = 0; c < N_CHANNELS; c++) {
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      const src = features[c];
      for (let i = 0; i < N; i++) re[i] = src[i] * this.hann[i] * this.spatialMask[i];
      fft2d(re, im, this.fftW, this.fftH, false);
      featRe[c] = re;
      featIm[c] = im;
    }

    // 2. Live response → peak, PSR, APCE.
    const liveResp = sumChannelResponse(this.filterRe, this.filterIm, featRe, featIm, this.channelW, this.fftW, this.fftH);
    const livePeak = findPeak(liveResp, this.fftW, this.fftH);
    const livePSR = psr(liveResp, this.fftW, this.fftH, livePeak.x, livePeak.y);
    const apceVal = apce(liveResp, livePeak.value);

    // 3. Reference response — same features, frozen filter. The reference
    //    is now also a *position voter*: in cluttered backgrounds the live
    //    filter drifts onto background but the (frozen) reference stays
    //    locked on the original object, so its peak location is a
    //    drift-immune second opinion.
    const refResp = sumChannelResponse(this.refFilterRe, this.refFilterIm, featRe, featIm, this.refChannelW, this.fftW, this.fftH);
    const refPeak = findPeak(refResp, this.fftW, this.fftH);
    const refPSR = psr(refResp, this.fftW, this.fftH, refPeak.x, refPeak.y);

    // 4. Per-voter displacements and trust region.
    const cx = this.fftW / 2;
    const cy = this.fftH / 2;
    const liveDx = (livePeak.x + livePeak.subX) - cx;
    const liveDy = (livePeak.y + livePeak.subY) - cy;
    const refDx = (refPeak.x + refPeak.subX) - cx;
    const refDy = (refPeak.y + refPeak.subY) - cy;
    const trustRadius = TRUST_REGION_FRACTION * Math.min(this.internalW, this.internalH);
    const liveInTrust = Math.abs(liveDx) <= trustRadius && Math.abs(liveDy) <= trustRadius;
    const refInTrust = Math.abs(refDx) <= trustRadius && Math.abs(refDy) <= trustRadius;

    // 5. Consensus rule between live and reference peaks.
    //
    //    Both valid + agree   → commit live displacement, allow filter retrain
    //    Both valid + disagree→ commit *reference* displacement (drift winner),
    //                           BUT block filter retrain — disagreement is the
    //                           strongest drift signal we have.
    //    Live only valid      → commit live (no second opinion available)
    //    Ref  only valid      → commit ref (live is uncertain — likely on background)
    //    Neither valid        → low-confidence frame
    const liveValid = Number.isFinite(livePSR) && livePSR >= PSR_COMMIT_THRESHOLD && liveInTrust;
    const refValid = Number.isFinite(refPSR) && refPSR >= REF_PSR_CONSENSUS_THRESHOLD && refInTrust;
    const consensusRadius = CONSENSUS_RADIUS_FRACTION * Math.min(this.internalW, this.internalH);
    const peaksAgree = Math.abs(liveDx - refDx) <= consensusRadius && Math.abs(liveDy - refDy) <= consensusRadius;

    let useDx = 0, useDy = 0, committed = false, agreedCommit = false;
    if (liveValid && refValid) {
      if (peaksAgree) { useDx = liveDx; useDy = liveDy; agreedCommit = true; }
      else            { useDx = refDx;  useDy = refDy;  }
      committed = true;
    } else if (liveValid) {
      useDx = liveDx; useDy = liveDy; committed = true; agreedCommit = true;
    } else if (refValid) {
      useDx = refDx; useDy = refDy; committed = true;
    }

    // Long-term lost signal — independent of which voter committed. The
    // reference filter is the ground truth for "still looks like the
    // original object"; if it gives up for MAX_LOST_FRAMES in a row, we
    // surface LOST to the caller regardless of what the live filter said.
    const refStillOK = Number.isFinite(refPSR) && refPSR >= REF_PSR_LOST_THRESHOLD;

    if (!committed || !refStillOK) {
      this.lostFrames++;
      if (this.lostFrames > MAX_LOST_FRAMES) return null;
      return this.makeResult(this.centerX, this.centerY, Math.max(0, refPSR / PSR_NORM));
    }

    // 6. Commit new centre.
    this.centerX = clamp(this.centerX + useDx, 0, this.frameW);
    this.centerY = clamp(this.centerY + useDy, 0, this.frameH);
    this.lostFrames = 0;

    // 7. Filter retrain gate — only when live and ref agreed *and* ref-PSR
    //    is high *and* APCE is sharp. Disagreement is the cleanest drift
    //    signal; never retrain after a disagreement, even if the position
    //    commit came from a confident reference vote.
    const apceMedian = this.apceMedian();
    const apceOK = apceMedian === 0 || apceVal >= APCE_RATIO_THRESHOLD * apceMedian;
    const refUpdateOK = refPSR >= REF_PSR_UPDATE_THRESHOLD;
    const shouldUpdate = agreedCommit && apceOK && refUpdateOK;

    this.pushAPCE(apceVal);

    if (shouldUpdate) {
      // 7a. Re-crop at the (now-committed) new centre. The filter
      //     training patch must be aligned with the new bbox position;
      //     using the search-time crop would re-introduce the very
      //     misalignment we just corrected for.
      const { R: R2, G: G2, B: B2 } = cropRGBPatch(pixels, this.frameW, this.frameH, this.centerX, this.centerY, this.fftW, this.fftH);
      const innerMask = innerBoxMask(this.fftW, this.fftH, this.userW, this.userH);
      const { fgHist, bgHist } = buildColorHistograms(R2, G2, B2, innerMask);
      emaArray(this.fgHist, fgHist, HIST_LEARNING_RATE);
      emaArray(this.bgHist, bgHist, HIST_LEARNING_RATE);
      const newMask = bayesPosteriorMask(R2, G2, B2, this.fgHist, this.bgHist, this.fftW, this.fftH, this.userW, this.userH);
      emaArray(this.spatialMask, newMask, HIST_LEARNING_RATE);

      const features2 = extractFeatures(R2, G2, B2, this.fftW, this.fftH);
      const solved = solveDCFFilter(features2, this.hann, this.spatialMask, this.targetRe, this.targetIm, this.fftW, this.fftH);

      // Apply spatial localization to the freshly-trained filter before
      // blending — keeps the EMA from accumulating un-localized energy in
      // the live filter's tails.
      if (this.localizationFalloff) {
        const combinedMask = combinedLocalization(this.localizationFalloff, this.spatialMask);
        applySpatialLocalization(solved.filterRe, solved.filterIm, combinedMask, this.fftW, this.fftH);
      }

      for (let c = 0; c < N_CHANNELS; c++) {
        const hRe = this.filterRe[c];
        const hIm = this.filterIm[c];
        const nRe = solved.filterRe[c];
        const nIm = solved.filterIm[c];
        for (let i = 0; i < N; i++) {
          hRe[i] = (1 - LEARNING_RATE) * hRe[i] + LEARNING_RATE * nRe[i];
          hIm[i] = (1 - LEARNING_RATE) * hIm[i] + LEARNING_RATE * nIm[i];
        }
        this.channelW[c] = (1 - LEARNING_RATE) * this.channelW[c] + LEARNING_RATE * solved.channelW[c];
      }
      normalizeReliability(this.channelW);
    }

    // Report ref-PSR-based score so the caller's `lost` boolean reflects
    // "still looks like the original object" rather than "the (possibly
    // drifted) live filter is matching something."
    return this.makeResult(this.centerX, this.centerY, Math.min(1, refPSR / PSR_NORM));
  }

  dispose(): void {
    this.hann = null;
    this.spatialMask = null;
    this.localizationFalloff = null;
    this.targetRe = null;
    this.targetIm = null;
    this.filterRe = null;
    this.filterIm = null;
    this.refFilterRe = null;
    this.refFilterIm = null;
    this.channelW = null;
    this.refChannelW = null;
    this.fgHist = null;
    this.bgHist = null;
    this.apceHistory = null;
  }

  private makeResult(cx: number, cy: number, score: number): TrackResult {
    const x = Math.round(cx - this.userW / 2);
    const y = Math.round(cy - this.userH / 2);
    const bbox: Bbox = { x, y, w: this.userW, h: this.userH };
    return { bbox, center: { cx, cy }, score };
  }

  private pushAPCE(v: number): void {
    if (!this.apceHistory) return;
    this.apceHistory[this.apceIndex] = v;
    this.apceIndex = (this.apceIndex + 1) % APCE_HISTORY_LEN;
    if (this.apceCount < APCE_HISTORY_LEN) this.apceCount++;
  }

  private apceMedian(): number {
    if (!this.apceHistory || this.apceCount === 0) return 0;
    const a = Array.from(this.apceHistory.subarray(0, this.apceCount));
    a.sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }
}

// ── Filter solver (closed-form multi-channel DCF) ─────────────────

// H_c = G · conj(F_c) / (Σ_d |F_d|² + λ). Returns per-channel
// frequency-domain filters plus their normalised reliability weights
// (per-channel PSR — see perChannelPSR).
function solveDCFFilter(
  features: Float32Array[],
  hann: Float32Array,
  mask: Float32Array,
  Gre: Float64Array, Gim: Float64Array,
  w: number, h: number,
): { filterRe: Float64Array[]; filterIm: Float64Array[]; channelW: Float32Array } {
  const N = w * h;
  const featRe: Float64Array[] = new Array(N_CHANNELS);
  const featIm: Float64Array[] = new Array(N_CHANNELS);
  const denom = new Float64Array(N);
  for (let c = 0; c < N_CHANNELS; c++) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const src = features[c];
    for (let i = 0; i < N; i++) re[i] = src[i] * hann[i] * mask[i];
    fft2d(re, im, w, h, false);
    featRe[c] = re;
    featIm[c] = im;
    for (let i = 0; i < N; i++) denom[i] += re[i] * re[i] + im[i] * im[i];
  }
  for (let i = 0; i < N; i++) denom[i] += LAMBDA;

  const filterRe: Float64Array[] = new Array(N_CHANNELS);
  const filterIm: Float64Array[] = new Array(N_CHANNELS);
  const channelW = new Float32Array(N_CHANNELS);
  for (let c = 0; c < N_CHANNELS; c++) {
    const hRe = new Float64Array(N);
    const hIm = new Float64Array(N);
    const Fre = featRe[c];
    const Fim = featIm[c];
    for (let i = 0; i < N; i++) {
      const numRe = Gre[i] * Fre[i] + Gim[i] * Fim[i];
      const numIm = Gim[i] * Fre[i] - Gre[i] * Fim[i];
      hRe[i] = numRe / denom[i];
      hIm[i] = numIm / denom[i];
    }
    filterRe[c] = hRe;
    filterIm[c] = hIm;
    channelW[c] = perChannelPSR(hRe, hIm, Fre, Fim, w, h);
  }
  normalizeReliability(channelW);
  return { filterRe, filterIm, channelW };
}

// One ADMM step against a fixed spatial prior: IFFT each channel's filter
// into the spatial domain, multiply by the localization mask (which soft-
// zeros the filter outside the object region), FFT back. This is the
// "S" of CSRT — without it, the closed-form DCF gives filter support
// across the entire FFT patch and the periodic tails accumulate
// background correlations in cluttered scenes.
function applySpatialLocalization(
  filterRe: Float64Array[], filterIm: Float64Array[],
  mask: Float32Array, w: number, h: number,
): void {
  for (let c = 0; c < N_CHANNELS; c++) {
    const re = filterRe[c];
    const im = filterIm[c];
    fft2d(re, im, w, h, true);   // → spatial domain
    // Note: the filter's spatial origin lives at (0,0) for FFT-correlation
    // semantics, with quadrant wrap. The localization mask is centred at
    // (w/2, h/2) — so we need to fftshift the mask, equivalent to indexing
    // the mask at (x + w/2, y + h/2) mod (w, h).
    const halfW = w >> 1;
    const halfH = h >> 1;
    for (let y = 0; y < h; y++) {
      const my = (y + halfH) % h;
      for (let x = 0; x < w; x++) {
        const mx = (x + halfW) % w;
        const m = mask[my * w + mx];
        const i = y * w + x;
        re[i] *= m;
        im[i] *= m;
      }
    }
    fft2d(re, im, w, h, false);  // → frequency domain
  }
}

// Combined localization = Gaussian falloff · (0.5 + 0.5 · colour posterior).
// The half-floor keeps the filter from collapsing when the Bayes posterior
// hasn't converged; the multiplicative term emphasises object-colour
// pixels inside the falloff envelope.
function combinedLocalization(falloff: Float32Array, spatialMask: Float32Array): Float32Array {
  const out = new Float32Array(falloff.length);
  for (let i = 0; i < falloff.length; i++) {
    out[i] = falloff[i] * (0.5 + 0.5 * spatialMask[i]);
  }
  return out;
}

// Sum_c w_c · H_c · F_c (Fourier) → IFFT → real spatial response.
function sumChannelResponse(
  filterRe: Float64Array[], filterIm: Float64Array[],
  featRe: Float64Array[], featIm: Float64Array[],
  channelW: Float32Array,
  w: number, h: number,
): Float64Array {
  const N = w * h;
  const accRe = new Float64Array(N);
  const accIm = new Float64Array(N);
  for (let c = 0; c < N_CHANNELS; c++) {
    const hRe = filterRe[c];
    const hIm = filterIm[c];
    const fRe = featRe[c];
    const fIm = featIm[c];
    const wc = channelW[c];
    for (let i = 0; i < N; i++) {
      const aRe = hRe[i] * fRe[i] - hIm[i] * fIm[i];
      const aIm = hRe[i] * fIm[i] + hIm[i] * fRe[i];
      accRe[i] += wc * aRe;
      accIm[i] += wc * aIm;
    }
  }
  fft2d(accRe, accIm, w, h, true);
  return accRe;
}

// ── FFT (Cooley-Tukey radix-2, split re/im) ───────────────────────

function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const aRe = re[i + j];
        const aIm = im[i + j];
        const bRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const bIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = aRe + bRe;
        im[i + j] = aIm + bIm;
        re[i + j + half] = aRe - bRe;
        im[i + j + half] = aIm - bIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

function fft2d(re: Float64Array, im: Float64Array, w: number, h: number, inverse: boolean): void {
  const rowRe = new Float64Array(w);
  const rowIm = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) { rowRe[x] = re[off + x]; rowIm[x] = im[off + x]; }
    fft1d(rowRe, rowIm, inverse);
    for (let x = 0; x < w; x++) { re[off + x] = rowRe[x]; im[off + x] = rowIm[x]; }
  }
  const colRe = new Float64Array(h);
  const colIm = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { colRe[y] = re[y * w + x]; colIm[y] = im[y * w + x]; }
    fft1d(colRe, colIm, inverse);
    for (let y = 0; y < h; y++) { re[y * w + x] = colRe[y]; im[y * w + x] = colIm[y]; }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ── Feature extraction ────────────────────────────────────────────

function extractFeatures(R: Float32Array, G: Float32Array, B: Float32Array, w: number, h: number): Float32Array[] {
  const channels: Float32Array[] = new Array(N_CHANNELS);
  for (let c = 0; c < N_CHANNELS; c++) channels[c] = new Float32Array(w * h);

  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];

  if (USE_INTENSITY) {
    let mean = 0;
    for (let i = 0; i < gray.length; i++) mean += gray[i];
    mean /= gray.length;
    const ch = channels[N_ORIENT_BINS];
    for (let i = 0; i < gray.length; i++) ch[i] = (gray[i] - mean) / 255;
  }

  const binWidth = Math.PI / N_ORIENT_BINS;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy) / 255;
      if (mag < 1e-6) continue;
      let ang = Math.atan2(gy, gx);
      if (ang < 0) ang += Math.PI;
      if (ang >= Math.PI) ang -= Math.PI;
      const bin = ang / binWidth;
      const b0 = Math.floor(bin);
      const frac = bin - b0;
      const b0w = ((b0 % N_ORIENT_BINS) + N_ORIENT_BINS) % N_ORIENT_BINS;
      const b1w = (b0w + 1) % N_ORIENT_BINS;
      channels[b0w][i] += mag * (1 - frac);
      channels[b1w][i] += mag * frac;
    }
  }
  return channels;
}

// ── RGB patch cropping ────────────────────────────────────────────

function cropRGBPatch(
  rgba: Uint8Array, frameW: number, frameH: number,
  cx: number, cy: number, w: number, h: number,
): { R: Float32Array; G: Float32Array; B: Float32Array } {
  const R = new Float32Array(w * h);
  const G = new Float32Array(w * h);
  const B = new Float32Array(w * h);
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - h / 2);
  for (let y = 0; y < h; y++) {
    const sy = clampInt(y0 + y, 0, frameH - 1);
    for (let x = 0; x < w; x++) {
      const sx = clampInt(x0 + x, 0, frameW - 1);
      const p = (sy * frameW + sx) * 4;
      const o = y * w + x;
      R[o] = rgba[p];
      G[o] = rgba[p + 1];
      B[o] = rgba[p + 2];
    }
  }
  return { R, G, B };
}

// ── Spatial mask via Bayes posterior on RGB histograms ────────────

function innerBoxMask(w: number, h: number, innerW: number, innerH: number): Float32Array {
  const out = new Float32Array(w * h);
  const x0 = Math.round((w - innerW) / 2);
  const y0 = Math.round((h - innerH) / 2);
  for (let y = 0; y < innerH; y++) {
    for (let x = 0; x < innerW; x++) {
      const xx = x0 + x;
      const yy = y0 + y;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
    }
  }
  return out;
}

function buildColorHistograms(R: Float32Array, G: Float32Array, B: Float32Array, fgMask: Float32Array): { fgHist: Float32Array; bgHist: Float32Array } {
  const fg = new Float32Array(HIST_BINS * HIST_BINS * HIST_BINS);
  const bg = new Float32Array(HIST_BINS * HIST_BINS * HIST_BINS);
  const scale = HIST_BINS / 256;
  let fgN = 0, bgN = 0;
  for (let i = 0; i < R.length; i++) {
    const r = Math.min(HIST_BINS - 1, (R[i] * scale) | 0);
    const g = Math.min(HIST_BINS - 1, (G[i] * scale) | 0);
    const b = Math.min(HIST_BINS - 1, (B[i] * scale) | 0);
    const idx = (r * HIST_BINS + g) * HIST_BINS + b;
    if (fgMask[i] > 0.5) { fg[idx]++; fgN++; } else { bg[idx]++; bgN++; }
  }
  const fgInv = fgN > 0 ? 1 / fgN : 0;
  const bgInv = bgN > 0 ? 1 / bgN : 0;
  for (let i = 0; i < fg.length; i++) { fg[i] *= fgInv; bg[i] *= bgInv; }
  return { fgHist: fg, bgHist: bg };
}

// P(fg | colour) ≈ P(c|fg) / (P(c|fg) + P(c|bg)).
// - Strong floor inside the user bbox via INNER_PRIOR_WEIGHT — even when
//   the histograms haven't converged the centre always contributes.
// - Outside that prior, posteriors below MASK_HARD_CUTOFF are clipped to
//   zero so the filter is forced to focus on object-colour pixels rather
//   than the surrounding context ring.
function bayesPosteriorMask(
  R: Float32Array, G: Float32Array, B: Float32Array,
  fgHist: Float32Array, bgHist: Float32Array,
  w: number, h: number, innerW: number, innerH: number,
): Float32Array {
  const out = new Float32Array(w * h);
  const scale = HIST_BINS / 256;
  const innerPrior = innerBoxMask(w, h, innerW, innerH);
  for (let i = 0; i < R.length; i++) {
    const r = Math.min(HIST_BINS - 1, (R[i] * scale) | 0);
    const g = Math.min(HIST_BINS - 1, (G[i] * scale) | 0);
    const b = Math.min(HIST_BINS - 1, (B[i] * scale) | 0);
    const idx = (r * HIST_BINS + g) * HIST_BINS + b;
    const pf = fgHist[idx];
    const pb = bgHist[idx];
    const post = pf + pb > 1e-8 ? pf / (pf + pb) : 0.5;
    const clipped = post < MASK_HARD_CUTOFF ? 0 : post;
    out[i] = Math.max(clipped, INNER_PRIOR_WEIGHT * innerPrior[i]);
  }
  return out;
}

// ── Target Gaussian ───────────────────────────────────────────────

function gaussianTarget(w: number, h: number, sigma: number): Float32Array {
  const out = new Float32Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  const k = -0.5 / (sigma * sigma);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      out[y * w + x] = Math.exp(k * (dx * dx + dy * dy));
    }
  }
  return out;
}

// ── Hann window (separable) ───────────────────────────────────────

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

// ── Peak / PSR / APCE / per-channel reliability ───────────────────

function findPeak(resp: Float64Array, w: number, h: number): { x: number; y: number; subX: number; subY: number; value: number } {
  let best = -Infinity;
  let bx = 0, by = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = resp[y * w + x];
      if (v > best) { best = v; bx = x; by = y; }
    }
  }
  let subX = 0, subY = 0;
  if (bx > 0 && bx < w - 1) {
    const L = resp[by * w + (bx - 1)];
    const C = best;
    const R = resp[by * w + (bx + 1)];
    const denom = L - 2 * C + R;
    if (denom < 0) subX = Math.max(-0.5, Math.min(0.5, (L - R) / (2 * denom)));
  }
  if (by > 0 && by < h - 1) {
    const U = resp[(by - 1) * w + bx];
    const C = best;
    const D = resp[(by + 1) * w + bx];
    const denom = U - 2 * C + D;
    if (denom < 0) subY = Math.max(-0.5, Math.min(0.5, (U - D) / (2 * denom)));
  }
  return { x: bx, y: by, subX, subY, value: best };
}

function psr(resp: Float64Array, w: number, h: number, px: number, py: number): number {
  const peak = resp[py * w + px];
  let sum = 0, sumSq = 0, n = 0;
  const r = PSR_EXCLUSION_RADIUS;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(x - px) <= r && Math.abs(y - py) <= r) continue;
      const v = resp[y * w + x];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  if (std < 1e-8) return 0;
  return (peak - mean) / std;
}

// APCE = (peak - min)² / mean((resp - min)²). Penalises flat/noisy
// responses; high APCE means a single sharp spike against a low floor.
function apce(resp: Float64Array, peak: number): number {
  let minV = Infinity;
  for (let i = 0; i < resp.length; i++) if (resp[i] < minV) minV = resp[i];
  let sumSq = 0;
  for (let i = 0; i < resp.length; i++) {
    const d = resp[i] - minV;
    sumSq += d * d;
  }
  const meanSq = sumSq / resp.length;
  if (meanSq < 1e-12) return 0;
  const d = peak - minV;
  return (d * d) / meanSq;
}

// Per-channel PSR via per-channel IFFT. A channel that has truly
// learned the object will produce a sharp solo peak relative to its
// own sidelobe; a channel that latched onto generic texture will
// produce a high but broad response and gets down-weighted.
function perChannelPSR(hRe: Float64Array, hIm: Float64Array, fRe: Float64Array, fIm: Float64Array, w: number, h: number): number {
  const N = w * h;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    re[i] = hRe[i] * fRe[i] - hIm[i] * fIm[i];
    im[i] = hRe[i] * fIm[i] + hIm[i] * fRe[i];
  }
  fft2d(re, im, w, h, true);
  // Locate peak then compute PSR — reuse the same statistic the response
  // gate uses, so per-channel weight semantics match overall confidence.
  let best = -Infinity, bx = 0, by = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = re[y * w + x];
      if (v > best) { best = v; bx = x; by = y; }
    }
  }
  const p = psr(re, w, h, bx, by);
  return Math.max(0, p);
}

function normalizeReliability(w: Float32Array): void {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  if (s < 1e-8) {
    const u = 1 / w.length;
    for (let i = 0; i < w.length; i++) w[i] = u;
    return;
  }
  for (let i = 0; i < w.length; i++) w[i] /= s;
}

// ── Misc helpers ──────────────────────────────────────────────────

function emaArray(dst: Float32Array, src: Float32Array, lr: number): void {
  for (let i = 0; i < dst.length; i++) dst[i] = (1 - lr) * dst[i] + lr * src[i];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  v = v | 0;
  return v < lo ? lo : v > hi ? hi : v;
}

function clampBbox(b: Bbox, w: number, h: number): Bbox {
  b.x = Math.max(0, Math.min(b.x, w - 1));
  b.y = Math.max(0, Math.min(b.y, h - 1));
  b.w = Math.max(1, Math.min(b.w, w - b.x));
  b.h = Math.max(1, Math.min(b.h, h - b.y));
  return b;
}
