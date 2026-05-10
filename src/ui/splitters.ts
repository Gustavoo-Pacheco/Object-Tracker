// Drag-to-resize splitters between stage|panel and plot|table.
// Sizes persist to localStorage so the layout survives reloads.

const STORE_KEY = 'tracker.layout.v1';

type Layout = { panelW?: number; tableH?: number };

function load(): Layout {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch { return {}; }
}

function save(l: Layout): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(l)); } catch { /* quota etc. */ }
}

export function mountSplitters(): void {
  const main = document.querySelector('main') as HTMLElement;
  const panel = document.getElementById('panel') as HTMLElement;
  const tableWrap = document.getElementById('table-wrap') as HTMLElement;
  const splitMain = document.getElementById('split-main') as HTMLElement;
  const splitPanel = document.getElementById('split-panel') as HTMLElement;

  const stored = load();
  if (stored.panelW) panel.style.width = `${clamp(stored.panelW, 240, window.innerWidth * 0.8)}px`;
  if (stored.tableH) tableWrap.style.flexBasis = `${clamp(stored.tableH, 60, window.innerHeight * 0.8)}px`;

  // Vertical splitter (panel width)
  attachDrag(splitMain, 'col', (e, start) => {
    const dx = start.clientX - e.clientX; // dragging left grows panel
    const next = clamp(start.size + dx, 240, main.clientWidth - 320);
    panel.style.width = `${next}px`;
    return next;
  }, () => panel.clientWidth, (v) => save({ ...load(), panelW: v }));

  // Horizontal splitter (table height inside panel)
  attachDrag(splitPanel, 'row', (e, start) => {
    const dy = start.clientY - e.clientY; // dragging up grows table
    const next = clamp(start.size + dy, 60, panel.clientHeight - 80);
    tableWrap.style.flexBasis = `${next}px`;
    return next;
  }, () => tableWrap.clientHeight, (v) => save({ ...load(), tableH: v }));
}

function attachDrag(
  handle: HTMLElement,
  kind: 'col' | 'row',
  onMove: (e: MouseEvent, start: { clientX: number; clientY: number; size: number }) => number,
  initialSize: () => number,
  onEnd: (finalSize: number) => void,
): void {
  let start: { clientX: number; clientY: number; size: number } | null = null;
  let last = 0;
  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    start = { clientX: e.clientX, clientY: e.clientY, size: initialSize() };
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    if (kind === 'row') document.body.classList.add('h');
    window.addEventListener('mousemove', onMove2);
    window.addEventListener('mouseup', onUp, { once: true });
  };
  const onMove2 = (e: MouseEvent): void => {
    if (!start) return;
    last = onMove(e, start);
    window.dispatchEvent(new Event('resize')); // trigger plot/canvas re-layout
  };
  const onUp = (): void => {
    start = null;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing', 'h');
    window.removeEventListener('mousemove', onMove2);
    if (last) onEnd(last);
  };
  handle.addEventListener('mousedown', onDown);

  // Double-click to reset to default.
  handle.addEventListener('dblclick', () => {
    if (kind === 'col') {
      (handle.parentElement!.querySelector('#panel') as HTMLElement).style.width = '380px';
      onEnd(380);
    } else {
      (document.getElementById('table-wrap') as HTMLElement).style.flexBasis = '220px';
      onEnd(220);
    }
    window.dispatchEvent(new Event('resize'));
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
