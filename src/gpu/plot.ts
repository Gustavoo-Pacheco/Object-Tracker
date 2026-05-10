// WebGPU polyline trajectory plot.
//
// Renders (x, y) world-metre coords as a line-strip into a <canvas> element.
// Uses a tiny vertex buffer (rebuilt per draw) and a single-pipeline pass.
// If WebGPU is not available, falls back to a Canvas2D polyline.

import { getDevice } from './device';
import type { TrackRecord } from '../state';

type Ctx2D = CanvasRenderingContext2D;

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

function bounds(records: TrackRecord[]): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of records) {
    const x = r[2], y = r[3];
    if (x == null || y == null) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return null;
  if (minX === maxX) { minX -= 0.5; maxX += 0.5; }
  if (minY === maxY) { minY -= 0.5; maxY += 0.5; }
  return { minX, maxX, minY, maxY };
}

function pad(v: { minX: number; maxX: number; minY: number; maxY: number }): typeof v {
  const padX = (v.maxX - v.minX) * 0.08;
  const padY = (v.maxY - v.minY) * 0.08;
  return { minX: v.minX - padX, maxX: v.maxX + padX, minY: v.minY - padY, maxY: v.maxY + padY };
}

function drawAxes(ctx: Ctx2D, w: number, h: number, b: ReturnType<typeof pad>): void {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 5; i++) {
    const y = (i / 5) * h;
    ctx.moveTo(0, y); ctx.lineTo(w, y);
    const x = (i / 5) * w;
    ctx.moveTo(x, 0); ctx.lineTo(x, h);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(138, 147, 164, 0.85)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`x: ${b.minX.toFixed(2)} → ${b.maxX.toFixed(2)} m`, 6, h - 6);
  ctx.textAlign = 'right';
  ctx.fillText(`y: ${b.minY.toFixed(2)} → ${b.maxY.toFixed(2)} m`, w - 6, 12);
}

// Public entry — renders WebGPU strip + Canvas2D axes.
export async function renderPlot(
  glCanvas: HTMLCanvasElement,
  axesCanvas: HTMLCanvasElement,
  records: TrackRecord[],
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

  const b0 = bounds(records);
  const ctx2d = axesCanvas.getContext('2d')!;
  if (!b0) {
    ctx2d.clearRect(0, 0, axesCanvas.width, axesCanvas.height);
    return;
  }
  const b = pad(b0);
  drawAxes(ctx2d, axesCanvas.width, axesCanvas.height, b);

  const verts = recordVerts(records, b);

  // Try WebGPU.
  const g = await ensureGpu(glCanvas);
  if (g && verts.length >= 4) {
    const byteSize = verts.byteLength;
    if (!g.vbo || g.vboCap < verts.length) {
      g.vbo?.destroy?.();
      g.vbo = g.device.createBuffer({ size: Math.max(byteSize, 4096), usage: 0x20 | 0x08 }); // VERTEX | COPY_DST
      g.vboCap = Math.max(verts.length, 1024);
    }
    g.device.queue.writeBuffer(g.vbo, 0, verts.buffer, verts.byteOffset, byteSize);

    // Identity transform — verts are already NDC.
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

// Records → NDC vertex pairs, skipping null gaps with a degenerate split.
function recordVerts(records: TrackRecord[], b: ReturnType<typeof pad>): Float32Array {
  const sx = 2 / (b.maxX - b.minX);
  const sy = 2 / (b.maxY - b.minY);
  const out: number[] = [];
  for (const r of records) {
    const x = r[2], y = r[3];
    if (x == null || y == null) continue;
    out.push((x - b.minX) * sx - 1);
    out.push((y - b.minY) * sy - 1);
  }
  return new Float32Array(out);
}
