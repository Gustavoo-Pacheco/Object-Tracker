// WebGPU device singleton + frame-pixel readback path with Canvas2D fallback.
//
// framePixels(video, w, h) returns RGBA bytes for the current video frame.
//   - WebGPU path: importExternalTexture from <video>, blit into an RGBA8 texture,
//     copy to a buffer, mapAsync to CPU. Works fully offline.
//   - Fallback: OffscreenCanvas 2D + getImageData, used when WebGPU is unavailable.

let devicePromise: Promise<GPUDevice | null> | null = null;
let cachedDevice: GPUDevice | null = null;

export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
}

export function getDevice(): Promise<GPUDevice | null> {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    if (!hasWebGPU()) return null;
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (!adapter) return null;
      const dev = await adapter.requestDevice();
      cachedDevice = dev;
      return dev;
    } catch {
      return null;
    }
  })();
  return devicePromise;
}

export function getDeviceSync(): GPUDevice | null { return cachedDevice; }

// ── Pixel readback ───────────────────────────────────────────────
// We render the external texture into a sampled-storage texture via a
// fullscreen-triangle pipeline, then copy that texture into a buffer.
// Buffer rows must be 256-byte aligned (WebGPU spec).

type Pipeline = {
  device: GPUDevice;
  pipeline: GPURenderPipeline;
  sampler: any;
  layout: any;
  destTex: GPUTexture;
  destW: number;
  destH: number;
  buf: GPUBuffer;
  bytesPerRow: number;
};

let pipe: Pipeline | null = null;

const SHADER = /* wgsl */`
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  // Fullscreen triangle.
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 2.0), vec2f(0.0, 0.0), vec2f(2.0, 0.0));
  var o: VOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = uv[i];
  return o;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(tex, samp, in.uv);
}
`;

async function ensurePipeline(device: GPUDevice, w: number, h: number): Promise<Pipeline> {
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  if (pipe && pipe.device === device && pipe.destW === w && pipe.destH === h) return pipe;

  // Tear down old resources if size changed.
  if (pipe) {
    (pipe.destTex as any)?.destroy?.();
    (pipe.buf as any)?.destroy?.();
  }

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const destTex = device.createTexture({
    size: [w, h, 1],
    format: 'rgba8unorm',
    usage: 0x10 | 0x01, // RENDER_ATTACHMENT (0x10) | COPY_SRC (0x01)
  });
  const buf = device.createBuffer({
    size: bytesPerRow * h,
    usage: 0x09, // COPY_DST (0x08) | MAP_READ (0x01)
  });

  pipe = {
    device,
    pipeline,
    sampler,
    layout: pipeline.getBindGroupLayout(0),
    destTex,
    destW: w,
    destH: h,
    buf,
    bytesPerRow,
  };
  return pipe;
}

// ── Fallback canvas ─────────────────────────────────────────────
let fbCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let fbCtx: any = null;

function fallbackPixels(video: HTMLVideoElement, w: number, h: number): Uint8Array {
  if (!fbCanvas || (fbCanvas as any).width !== w || (fbCanvas as any).height !== h) {
    fbCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    (fbCanvas as any).width = w;
    (fbCanvas as any).height = h;
    fbCtx = (fbCanvas as any).getContext('2d', { willReadFrequently: true });
  }
  fbCtx.drawImage(video, 0, 0, w, h);
  const img = fbCtx.getImageData(0, 0, w, h);
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

// Returns tightly-packed RGBA8 (length = w * h * 4).
export async function framePixels(video: HTMLVideoElement, w: number, h: number): Promise<Uint8Array> {
  const dev = await getDevice();
  if (!dev) return fallbackPixels(video, w, h);

  let p: Pipeline;
  try {
    p = await ensurePipeline(dev, w, h);
  } catch {
    return fallbackPixels(video, w, h);
  }

  let extTex: GPUExternalTexture;
  try {
    extTex = (dev as any).importExternalTexture({ source: video });
  } catch {
    return fallbackPixels(video, w, h);
  }

  const bg = dev.createBindGroup({
    layout: p.layout,
    entries: [
      { binding: 0, resource: p.sampler },
      { binding: 1, resource: extTex },
    ],
  });

  const enc = dev.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: p.destTex!.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear',
      storeOp: 'store',
    }],
  });
  pass.setPipeline(p.pipeline);
  pass.setBindGroup(0, bg);
  pass.draw(3, 1, 0, 0);
  pass.end();

  enc.copyTextureToBuffer(
    { texture: p.destTex },
    { buffer: p.buf, bytesPerRow: p.bytesPerRow, rowsPerImage: h },
    [w, h, 1],
  );
  dev.queue.submit([enc.finish()]);

  await (p.buf as any).mapAsync(0x01); // MAP_READ
  const padded = new Uint8Array((p.buf as any).getMappedRange().slice(0));
  (p.buf as any).unmap();

  // Strip row padding into a tightly packed buffer.
  if (p.bytesPerRow === w * 4) return padded;
  const tight = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    tight.set(padded.subarray(y * p.bytesPerRow, y * p.bytesPerRow + w * 4), y * w * 4);
  }
  return tight;
}
