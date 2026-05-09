type Painter = (ctx: CanvasRenderingContext2D, dw: number, dh: number) => void;
let current: Painter | null = null;
export const setOverlayPainter = (p: Painter | null): void => { current = p; };
export const clearOverlayPainter = (): void => { current = null; };
export const getOverlayPainter = (): Painter | null => current;
