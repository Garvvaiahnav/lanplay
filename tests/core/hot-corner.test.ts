import { describe, expect, it } from 'vitest';
import { cornerAt, HotCornerTracker } from '../../src/core/client/hot-corner.js';
import type { Rect } from '../../src/core/client/hot-corner.js';

const D1: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const D2: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };

describe('cornerAt', () => {
  it('finds each corner of a single display within the margin', () => {
    expect(cornerAt({ x: 0, y: 0 }, [D1], 4)?.corner).toBe('top-left');
    expect(cornerAt({ x: 1919, y: 0 }, [D1], 4)?.corner).toBe('top-right');
    expect(cornerAt({ x: 0, y: 1079 }, [D1], 4)?.corner).toBe('bottom-left');
    expect(cornerAt({ x: 1919, y: 1079 }, [D1], 4)?.corner).toBe('bottom-right');
    expect(cornerAt({ x: 3, y: 3 }, [D1], 4)?.corner).toBe('top-left');
  });

  it('ignores points outside the margin, on a lone edge, or outside every display', () => {
    expect(cornerAt({ x: 4, y: 4 }, [D1], 4)).toBeNull();
    expect(cornerAt({ x: 960, y: 0 }, [D1], 4)).toBeNull();
    expect(cornerAt({ x: 0, y: 540 }, [D1], 4)).toBeNull();
    expect(cornerAt({ x: -5, y: -5 }, [D1], 4)).toBeNull();
    expect(cornerAt({ x: 100, y: 100 }, [], 4)).toBeNull();
  });

  it('on two side-by-side displays only the outer corners are hot', () => {
    // Shared edge between D1 and D2 (x=1919/1920): the corners there are not real screen corners.
    expect(cornerAt({ x: 1919, y: 0 }, [D1, D2], 4)).toBeNull();
    expect(cornerAt({ x: 1920, y: 0 }, [D1, D2], 4)).toBeNull();
    expect(cornerAt({ x: 1919, y: 1079 }, [D1, D2], 4)).toBeNull();
    expect(cornerAt({ x: 0, y: 0 }, [D1, D2], 4)?.corner).toBe('top-left');
    expect(cornerAt({ x: 3839, y: 0 }, [D1, D2], 4)?.corner).toBe('top-right');
    expect(cornerAt({ x: 3839, y: 1079 }, [D1, D2], 4)?.display).toEqual(D2);
  });
});

describe('HotCornerTracker', () => {
  const cfg = { marginPx: 4, dwellMs: 500 };

  it('fires once after the cursor rests in a corner for dwellMs', () => {
    const t = new HotCornerTracker(cfg);
    expect(t.update({ x: 1919, y: 0 }, [D1], 1000)).toBeNull();
    expect(t.update({ x: 1919, y: 0 }, [D1], 1499)).toBeNull();
    const hit = t.update({ x: 1918, y: 1 }, [D1], 1500);
    expect(hit?.corner).toBe('top-right');
    expect(t.update({ x: 1919, y: 0 }, [D1], 3000)).toBeNull();
  });

  it('a fly-through shorter than dwellMs never fires', () => {
    const t = new HotCornerTracker(cfg);
    expect(t.update({ x: 0, y: 0 }, [D1], 0)).toBeNull();
    expect(t.update({ x: 400, y: 400 }, [D1], 300)).toBeNull();
    expect(t.update({ x: 0, y: 0 }, [D1], 400)).toBeNull();
    expect(t.update({ x: 0, y: 0 }, [D1], 800)).toBeNull();
    expect(t.update({ x: 0, y: 0 }, [D1], 900)?.corner).toBe('top-left');
  });

  it('re-arms after the cursor leaves, and moving to another corner restarts the timer', () => {
    const t = new HotCornerTracker(cfg);
    t.update({ x: 0, y: 0 }, [D1], 0);
    expect(t.update({ x: 0, y: 0 }, [D1], 500)?.corner).toBe('top-left');
    t.update({ x: 500, y: 500 }, [D1], 600);
    t.update({ x: 0, y: 0 }, [D1], 700);
    expect(t.update({ x: 0, y: 0 }, [D1], 1200)?.corner).toBe('top-left');
    t.update({ x: 1919, y: 1079 }, [D1], 1300);
    expect(t.update({ x: 1919, y: 1079 }, [D1], 1700)).toBeNull();
    expect(t.update({ x: 1919, y: 1079 }, [D1], 1800)?.corner).toBe('bottom-right');
  });

  it('reset() lets a cursor that stayed in the corner fire again', () => {
    const t = new HotCornerTracker(cfg);
    t.update({ x: 0, y: 0 }, [D1], 0);
    expect(t.update({ x: 0, y: 0 }, [D1], 500)).not.toBeNull();
    t.reset();
    expect(t.update({ x: 0, y: 0 }, [D1], 600)).toBeNull();
    expect(t.update({ x: 0, y: 0 }, [D1], 1100)).not.toBeNull();
  });
});
