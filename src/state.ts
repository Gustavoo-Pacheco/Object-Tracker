export type Phase = 'idle' | 'navigate' | 'setup' | 'origin' | 'scale' | 'bbox' | 'tracking' | 'done';

export type TrackRecord = [
  number,         // frame index
  number,         // time (s)
  number | null,  // x (m, from origin)
  number | null,  // y (m, flipped)
  number | null,  // vx (m/s)
  number | null,  // vy (m/s)
];

export type AppState = {
  phase: Phase;
  video: { fps: number; width: number; height: number; totalFrames: number; src: string } | null;
  frameIdx: number;
  zoom: number;
  pan: { x: number; y: number };
  origin: { x: number; y: number } | null;
  scalePts: [{ x: number; y: number }, { x: number; y: number }] | null;
  metresPerPixel: number | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  startFrame: number | null;
  records: TrackRecord[];
  status: string;
};

const state: AppState = {
  phase: 'idle',
  video: null,
  frameIdx: 0,
  zoom: 1,
  pan: { x: 0, y: 0 },
  origin: null,
  scalePts: null,
  metresPerPixel: null,
  bbox: null,
  startFrame: null,
  records: [],
  status: 'Upload a video to begin',
};

type Listener = (s: AppState) => void;
const listeners = new Set<Listener>();

export const getState = (): AppState => state;
export const setState = (patch: Partial<AppState>): void => {
  Object.assign(state, patch);
  listeners.forEach(l => l(state));
};
export const subscribe = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const triggerRender = (): void => { listeners.forEach(l => l(state)); };
