// Hot-corner detection (pure, no Electron). The exit menu opens when the cursor rests in a screen corner.
// Coordinates are whatever the caller uses consistently (Electron: DIP, from screen.getCursorScreenPoint / display.bounds).

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CornerHit {
  corner: Corner;
  /** The display the corner belongs to. */
  display: Rect;
}
export interface HotCornerConfig {
  /** How close to both edges the cursor must be, in px (inclusive of the edge pixel). */
  marginPx: number;
  /** How long the cursor must rest in the corner before the menu opens. */
  dwellMs: number;
}

export const DEFAULT_HOT_CORNER: HotCornerConfig = Object.freeze({ marginPx: 4, dwellMs: 500 });

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/**
 * The hot corner the point is in, or null. Only OUTER corners count: a corner whose horizontal or vertical neighbour pixel
 * belongs to another display sits inside the combined desktop (e.g. where two monitors meet) and is ignored, so moving the
 * mouse between monitors never opens the menu.
 */
export function cornerAt(p: Point, displays: readonly Rect[], marginPx: number): CornerHit | null {
  const d = displays.find((r) => contains(r, p));
  if (!d) return null;
  const left = p.x - d.x < marginPx;
  const right = d.x + d.width - 1 - p.x < marginPx;
  const top = p.y - d.y < marginPx;
  const bottom = d.y + d.height - 1 - p.y < marginPx;
  if ((left === right) || (top === bottom)) return null; // not in exactly one horizontal and one vertical margin (needs both axes)
  const horizontal = left ? 'left' : 'right';
  const vertical = top ? 'top' : 'bottom';
  // The pixel of the corner itself and the neighbours just outside it, along each axis.
  const cx = left ? d.x : d.x + d.width - 1;
  const cy = top ? d.y : d.y + d.height - 1;
  const outX = left ? cx - 1 : cx + 1;
  const outY = top ? cy - 1 : cy + 1;
  const adjacent = displays.some((r) => r !== d && (contains(r, { x: outX, y: cy }) || contains(r, { x: cx, y: outY })));
  if (adjacent) return null;
  return { corner: `${vertical}-${horizontal}` as Corner, display: d };
}

/** Fires once per visit: the cursor must stay in the same corner for dwellMs, and leave it before it can fire again. */
export class HotCornerTracker {
  private key: string | null = null;
  private since = 0;
  private fired = false;

  constructor(private readonly cfg: HotCornerConfig = DEFAULT_HOT_CORNER) {}

  update(p: Point, displays: readonly Rect[], nowMs: number): CornerHit | null {
    const hit = cornerAt(p, displays, this.cfg.marginPx);
    if (!hit) {
      this.reset();
      return null;
    }
    const key = `${displays.indexOf(hit.display)}:${hit.corner}`;
    if (key !== this.key) {
      this.key = key;
      this.since = nowMs;
      this.fired = false;
      return null;
    }
    if (!this.fired && nowMs - this.since >= this.cfg.dwellMs) {
      this.fired = true;
      return hit;
    }
    return null;
  }

  /** Forget the current visit (e.g. after the menu closed): a cursor still in the corner must dwell again. */
  reset(): void {
    this.key = null;
    this.since = 0;
    this.fired = false;
  }
}
