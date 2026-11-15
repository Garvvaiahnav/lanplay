import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_ID, defaultLayout, defaultStore, LIMITS, sanitizeStore } from '../../src/core/controller/layout.js';

describe('default layout', () => {
  it('has every Xbox control exactly once and survives sanitizing unchanged', () => {
    const l = defaultLayout();
    const buttons = l.controls.filter((c) => c.type === 'button').map((c) => (c as { button: string }).button).sort();
    expect(buttons).toEqual(['A', 'B', 'BACK', 'LB', 'LT', 'RB', 'RT', 'START', 'X', 'Y']);
    expect(l.controls.filter((c) => c.type === 'stick').map((c) => (c as { stick: string }).stick).sort()).toEqual(['left', 'right']);
    expect(l.controls.filter((c) => c.type === 'dpad')).toHaveLength(1);
    expect(new Set(l.controls.map((c) => c.id)).size).toBe(l.controls.length);
    expect(sanitizeStore(defaultStore()).layouts[0]).toEqual(l);
  });
});

describe('sanitizeStore', () => {
  it('turns garbage into the default store and never throws', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { layouts: 'no' }, { version: 1, layouts: [] }]) {
      const s = sanitizeStore(bad);
      expect(s.layouts.length).toBeGreaterThanOrEqual(1);
      expect(s.layouts.some((l) => l.id === s.activeId)).toBe(true);
    }
    expect(sanitizeStore(null)).toEqual(defaultStore());
  });

  it('clamps numbers into their ranges and fixes non-numbers', () => {
    const s = sanitizeStore({
      version: 1,
      activeId: 'a',
      layouts: [
        {
          id: 'a',
          name: 'Mine',
          controls: [
            { id: 's1', type: 'stick', stick: 'left', x: -50, y: 500, size: 9999, deadzone: 5, sensitivity: 0, opacity: 7, mode: 'floating', curve: 'precise', invertY: true },
            { id: 'b1', type: 'button', button: 'A', x: 'x', y: NaN, w: 0, h: -3, shape: 'circle', label: 'Jump', latch: true, turbo: true, value: 999, opacity: 0.5 },
          ],
        },
      ],
    });
    const [stick, btn] = s.layouts[0]!.controls as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(stick).toMatchObject({ type: 'stick', stick: 'left', x: 0, y: 100, size: LIMITS.size.max, deadzone: LIMITS.deadzone.max, sensitivity: LIMITS.sensitivity.min, opacity: 1, mode: 'floating', curve: 'precise', invertY: true });
    expect(btn).toMatchObject({ type: 'button', button: 'A', x: 50, y: 50, w: LIMITS.size.min, h: LIMITS.size.min, shape: 'circle', label: 'Jump', latch: true, turbo: true, value: 255, opacity: 0.5 });
  });

  it('drops unknown control types and unknown buttons, keeps the rest', () => {
    const s = sanitizeStore({
      version: 1,
      activeId: 'a',
      layouts: [{ id: 'a', name: 'x', controls: [{ id: 'q', type: 'laser' }, { id: 'b', type: 'button', button: 'EJECT' }, { id: 'ok', type: 'dpad', x: 10, y: 10, size: 20 }] }],
    });
    expect(s.layouts[0]!.controls.map((c) => c.id)).toEqual(['ok']);
  });

  it('makes ids unique and safe, names short and clean', () => {
    const s = sanitizeStore({
      version: 1,
      activeId: 'x y!',
      layouts: [
        { id: 'x y!', name: '  A'.padEnd(200, 'z'), controls: [{ id: 'd', type: 'dpad' }, { id: 'd', type: 'dpad' }] },
        { id: 'x y!', name: '', controls: [] },
      ],
    });
    const ids = s.layouts.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of s.layouts) {
      expect(l.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
      expect(l.name.length).toBeGreaterThan(0);
      expect(l.name.length).toBeLessThanOrEqual(LIMITS.nameChars);
      expect(new Set(l.controls.map((c) => c.id)).size).toBe(l.controls.length);
      for (const c of l.controls) expect(c.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    }
    expect(ids).toContain(s.activeId);
  });

  it('caps the number of layouts and controls', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, controls: Array.from({ length: 200 }, (_, j) => ({ id: `c${j}`, type: 'dpad' })) }));
    const s = sanitizeStore({ version: 1, activeId: 'l0', layouts: many });
    expect(s.layouts).toHaveLength(LIMITS.layouts);
    expect(s.layouts[0]!.controls).toHaveLength(LIMITS.controls);
  });

  it('keeps an active id that exists and repairs one that does not', () => {
    const base = { version: 1, layouts: [{ id: 'one', name: 'One', controls: [] }, { id: 'two', name: 'Two', controls: [] }] };
    expect(sanitizeStore({ ...base, activeId: 'two' }).activeId).toBe('two');
    expect(sanitizeStore({ ...base, activeId: 'nope' }).activeId).toBe('one');
  });

  it('an empty layout (all controls deleted) is allowed; a store with no layouts is not', () => {
    expect(sanitizeStore({ version: 1, activeId: 'e', layouts: [{ id: 'e', name: 'Empty', controls: [] }] }).layouts[0]!.controls).toEqual([]);
    expect(sanitizeStore({ version: 1, activeId: 'e', layouts: [] }).layouts[0]!.id).toBe(DEFAULT_LAYOUT_ID);
  });

  it('is idempotent', () => {
    const once = sanitizeStore({ version: 1, activeId: 'a', layouts: [{ id: 'a', name: 'n', controls: [{ id: 'x', type: 'stick', stick: 'right', sensitivity: 1.4 }] }] });
    expect(sanitizeStore(once)).toEqual(once);
  });
});
