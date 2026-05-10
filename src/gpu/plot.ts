// WebGPU polyline trajectory plot.
//
// Renders (x, y) world-metre coords as a line-strip into a <canvas> element.
// The view is fixed to the full image extent (passed in by the caller) and
// drawn with a preserved aspect ratio — 1 metre on X equals 1 metre on Y in
// pixels. No auto-zoom: the plot mirrors the image's coordinate system.

import { getDevice } from './device';
import type { TrackRecord } from '../state';

type Ctx2D = CanvasRenderingContext2D;

export type PlotView = {
  minX: number; maxX: number;
  minY: number; maxY: number;
};

const SHADER = /* wgsl */`
struct U { scale: vec2f, offset: vec2f };
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f {
  let q = p * u.scale + u.offset;
  return vec4f(q, 0.0, 1.0);
}

@fragment fn fs() -> @location(0) vec4f {
  // Lime — matches the live tracker bbox accent.
  return vec4f(0.639, 0.902, 0.208, 1.0);
}
`;

type GpuState = {
  device: GPUDevice;
  ctx: GPUCanvasContext;
  format: string;
  pipeline: GPURenderPipeline;
  ubo: GPUBuffer;
  bindGroup: any;
  vbo?: GPUBuffer;
  vboCap: number; // capacity in float pairs
};

let gpu: GpuState | null = null;

async function ensureGpu(canvas: HTMLCanvasElement): Promise<GpuState | null> {
  if (gpu) return gpu;
  const device = await getDevice();
  if (!device) return null;
  const ctx: any = canvas.getContext('webgpu');
  if (!ctx) return null;
  const format = (navigator as any).gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'premultiplied' });

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module, entryPoint: 'vs',
      buffers: [{
        arrayStride: 8,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
      }],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'line-strip' },
  });
  const ubo = device.createBuffer({ size: 16, usage: 0x40 | 0x08 }); // UNIFORM | COPY_DST
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubo } }],
  });
  gpu = { device, ctx, format, pipeline, ubo, bindGroup, vboCap: 0 };
  return gpu;
}

// Fit the world view into the canvas with equal X/Y scale (letterbox).
// Returns the per-axis scale (in NDC units per world metre) and the NDC
// offset that places (cx, cy) at NDC origin.
function fit(view: PlotView, w: number, h: number): {
  sx: number; sy: number;        // world → NDC
  cx: number; cy: number;        // world centre
  pxPerM: number;                // shared pixel-per-metre (for axes)
} {
  const Ww = view.maxX - view.minX;
  const Wh = view.maxY - view.minY;
  const pxPerM = Math.min(w / Ww, h / Wh);
  // NDC half-extent is 1, so scale = pxPerM / (canvasPx / 2).
  const sx = (pxPerM * 2) / w;
  const sy = (pxPerM * 2) / h;
  const cx = (view.minX + view.maxX) / 2;
  const cy = (view.minY + view.maxY) / 2;
  return { sx, sy, cx, cy, pxPerM };
}

// World (x, y) → canvas pixel (px from top-left). Axes-canvas helper.
function worldToPx(
  x: number, y: number,
  view: PlotView, w: number, h: number,
): { x: number; y: number } {
  const { sx, sy, cx, cy } = fit(view, w, h);
  const ndcX = (x - cx) * sx;
  const ndcY = (y - cy) * sy;
  return { x: (ndcX * 0.5 + 0.5) * w, y: (1 - (ndcY * 0.5 + 0.5)) * h };
}

// Pick a "nice" tick interval (1/2/5 × 10^n) given roughly N ticks per range.
function niceStep(range: number, target: number): number {
  if (range <= 0 || !isFinite(range)) return 1;
  const raw = range / Math.max(1, target);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * pow;
}

function drawAxes(ctx: Ctx2D, w: number, h: number, view: PlotView): void {
  ctx.clearRect(0, 0, w, h);

  const Ww = view.maxX - view.minX;
  const Wh = view.maxY - view.minY;
  const stepX = niceStep(Ww, 8);
  const stepY = niceStep(Wh, 6);

  // Grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const x0 = Math.ceil(view.minX / stepX) * stepX;
  for (let x = x0; x <= view.maxX + 1e-9; x += stepX) {
    const p = worldToPx(x, view.minY, view, w, h).x;
    ctx.moveTo(p, 0); ctx.lineTo(p, h);
  }
  const y0 = Math.ceil(view.minY / stepY) * stepY;
  for (let y = y0; y <= view.maxY + 1e-9; y += stepY) {
    const p = worldToPx(view.minX, y, view, w, h).y;
    ctx.moveTo(0, p); ctx.lineTo(w, p);
  }
  ctx.stroke();

  // World-origin axes (x=0, y=0) if inside view.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  if (view.minX <= 0 && 0 <= view.maxX) {
    const p = worldToPx(0, view.minY, view, w, h).x;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, h); ctx.stroke();
  }
  if (view.minY <= 0 && 0 <= view.maxY) {
    const p = worldToPx(view.minX, 0, view, w, h).y;
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(w, p); ctx.stroke();
  }

  // Tick labels.
  ctx.fillStyle = 'rgba(138, 147, 164, 0.85)';
  ctx.font = '10px ui-monospace, monospace';
  const decimals = Math.max(0, -Math.floor(Math.log10(stepX)));
  const decimalsY = Math.max(0, -Math.floor(Math.log10(stepY)));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let x = x0; x <= view.maxX + 1e-9; x += stepX) {
    const p = worldToPx(x, view.minY, view, w, h).x;
    if (p < 14 || p > w - 14) continue;
    ctx.fillText(x.toFixed(decimals), p, h - 2);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let y = y0; y <= view.maxY + 1e-9; y += stepY) {
    const p = worldToPx(view.minX, y, view, w, h).y;
    if (p < 8 || p > h - 8) continue;
    ctx.fillText(y.toFixed(decimalsY), 4, p);
  }

  // Corner extent label.
  ctx.fillStyle = 'rgba(138, 147, 164, 0.6)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${Ww.toFixed(2)} × ${Wh.toFixed(2)} m`, w - 4, h - 2);
}

// Public entry — renders WebGPU strip + Canvas2D axes.
export async function renderPlot(
  glCanvas: HTMLCanvasElement,
  axesCanvas: HTMLCanvasElement,
  records: TrackRecord[],
  view: PlotView,
): Promise<void> {
  const w = glCanvas.clientWidth || 320;
  const h = glCanvas.clientHeight || 200;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const c of [glCanvas, axesCanvas]) {
    const tw = Math.max(1, Math.floor(w * dpr));
    const th = Math.max(1, Math.floor(h * dpr));
    if (c.width !== tw) c.width = tw;
    if (c.height !== th) c.height = th;
  }

  const ctx2d = axesCanvas.getContext('2d')!;
  drawAxes(ctx2d, axesCanvas.width, axesCanvas.height, view);

  const verts = recordVerts(records, view, glCanvas.width, glCanvas.height);

  const g = await ensureGpu(glCanvas);
  if (g && verts.length >= 4) {
    const byteSize = verts.byteLength;
    if (!g.vbo || g.vboCap < verts.length) {
      g.vbo?.destroy?.();
      g.vbo = g.device.createBuffer({ size: Math.max(byteSize, 4096), usage: 0x20 | 0x08 }); // VERTEX | COPY_DST
      g.vboCap = Math.max(verts.length, 1024);
    }
    g.device.queue.writeBuffer(g.vbo, 0, verts.buffer, verts.byteOffset, byteSize);

    // Verts are already NDC.
    const u = new Float32Array([1, 1, 0, 0]);
    g.device.queue.writeBuffer(g.ubo, 0, u.buffer);

    const enc = g.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: g.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(g.pipeline);
    pass.setBindGroup(0, g.bindGroup);
    pass.setVertexBuffer(0, g.vbo);
    pass.draw(verts.length / 2, 1, 0, 0);
    pass.end();
    g.device.queue.submit([enc.finish()]);
  } else {
    // Canvas2D fallback over the same canvas.
    const c2d = (glCanvas.getContext('2d') as Ctx2D | null);
    if (!c2d) return;
    c2d.clearRect(0, 0, glCanvas.width, glCanvas.height);
    c2d.strokeStyle = '#a3e635';
    c2d.lineWidth = 2;
    c2d.beginPath();
    let started = false;
    for (let i = 0; i < verts.length; i += 2) {
      const px = (verts[i] * 0.5 + 0.5) * glCanvas.width;
      const py = (1 - (verts[i + 1] * 0.5 + 0.5)) * glCanvas.height;
      if (!started) { c2d.moveTo(px, py); started = true; } else c2d.lineTo(px, py);
    }
    c2d.stroke();
  }
}

// Records → NDC vertex pairs using the fixed view (aspect-preserving fit).
function recordVerts(records: TrackRecord[], view: PlotView, w: number, h: number): Float32Array {
  const { sx, sy, cx, cy } = fit(view, w, h);
  const out: number[] = [];
  for (const r of records) {
    const x = r[2], y = r[3];
    if (x == null || y == null) continue;
    out.push((x - cx) * sx);
    out.push((y - cy) * sy);
  }
  return new Float32Array(out);
}
