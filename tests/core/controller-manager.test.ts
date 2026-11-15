import { beforeEach, describe, expect, it } from 'vitest';
import { ControllerManager } from '../../src/core/controller/manager.js';
import type { VirtualPad } from '../../src/core/controller/manager.js';
import { BTN, neutralPad } from '../../src/core/controller/protocol.js';
import type { PadState } from '../../src/core/controller/protocol.js';

class FakePad implements VirtualPad {
  updates: PadState[] = [];
  closed = 0;
  constructor(public slot: number) {}
  update(s: PadState) {
    this.updates.push({ ...s });
  }
  close() {
    this.closed++;
  }
  get last(): PadState | undefined {
    return this.updates[this.updates.length - 1];
  }
}

describe('ControllerManager', () => {
  let now: number;
  let pads: FakePad[];
  let failCreate: boolean;
  let m: ControllerManager;
  const A: PadState = { ...neutralPad(), buttons: BTN.A, lx: 1000 };

  beforeEach(() => {
    now = 1000;
    pads = [];
    failCreate = false;
    m = new ControllerManager(
      {
        createPad: (slot) => {
          if (failCreate) throw new Error('ViGEmBus is not installed');
          const p = new FakePad(slot);
          pads.push(p);
          return p;
        },
        now: () => now,
      },
      { maxPlayers: 4, staleMs: 2500, dropMs: 20000 },
    );
  });

  it('hands out the lowest free player number and creates one pad per player', () => {
    expect(m.join('a', 'Pixel', '192.168.1.5')).toEqual({ ok: true, slot: 1 });
    expect(m.join('b', 'iPhone', '192.168.1.6')).toEqual({ ok: true, slot: 2 });
    m.leave('a');
    expect(m.join('c', 'Tab', '192.168.1.7')).toEqual({ ok: true, slot: 1 });
    expect(pads.map((p) => p.slot)).toEqual([1, 2, 1]);
  });

  it('is full after maxPlayers and says so', () => {
    for (const id of ['a', 'b', 'c', 'd']) expect(m.join(id, id, '10.0.0.1').ok).toBe(true);
    expect(m.join('e', 'e', '10.0.0.1')).toEqual({ ok: false, reason: 'full' });
    expect(pads).toHaveLength(4);
  });

  it('joining twice with the same connection id keeps the slot and creates no second pad', () => {
    expect(m.join('a', 'x', '10.0.0.1')).toEqual({ ok: true, slot: 1 });
    expect(m.join('a', 'x', '10.0.0.1')).toEqual({ ok: true, slot: 1 });
    expect(pads).toHaveLength(1);
  });

  it('reports a driver problem instead of throwing, and leaves no half-joined player', () => {
    failCreate = true;
    expect(m.join('a', 'x', '10.0.0.1')).toEqual({ ok: false, reason: 'driver', message: 'ViGEmBus is not installed' });
    expect(m.list()).toEqual([]);
    failCreate = false;
    expect(m.join('a', 'x', '10.0.0.1')).toEqual({ ok: true, slot: 1 });
  });

  it('forwards a changed state to that player pad only, and skips identical repeats', () => {
    m.join('a', 'a', '10.0.0.1');
    m.join('b', 'b', '10.0.0.2');
    m.update('a', A);
    m.update('a', A);
    expect(pads[0]!.updates).toEqual([A]);
    expect(pads[1]!.updates).toEqual([]);
    m.update('a', { ...A, buttons: 0 });
    expect(pads[0]!.updates).toHaveLength(2);
  });

  it('ignores updates from unknown connections', () => {
    expect(() => m.update('nobody', A)).not.toThrow();
    expect(pads).toHaveLength(0);
  });

  it('releases everything (neutral, then close) when a player leaves, and the slot comes back', () => {
    m.join('a', 'a', '10.0.0.1');
    m.update('a', A);
    m.leave('a');
    expect(pads[0]!.last).toEqual(neutralPad());
    expect(pads[0]!.closed).toBe(1);
    expect(m.list()).toEqual([]);
    m.leave('a'); // second leave is harmless
    expect(pads[0]!.closed).toBe(1);
  });

  it('kick removes the player like a leave and tells the caller whether it existed', () => {
    m.join('a', 'a', '10.0.0.1');
    expect(m.kick('a')).toBe(true);
    expect(m.kick('a')).toBe(false);
    expect(pads[0]!.closed).toBe(1);
  });

  it('goes neutral when a phone goes quiet, resumes on the next message, and drops it after a long silence', () => {
    m.join('a', 'a', '10.0.0.1');
    m.update('a', A);
    now += 2400;
    expect(m.tick()).toEqual([]);
    expect(pads[0]!.last).toEqual(A); // not stale yet
    now += 200; // 2600 ms of silence
    expect(m.tick()).toEqual([]);
    expect(pads[0]!.last).toEqual(neutralPad());
    const count = pads[0]!.updates.length;
    now += 1000;
    m.tick();
    expect(pads[0]!.updates).toHaveLength(count); // neutral is sent once, not every tick
    expect(m.list()[0]?.stale).toBe(true);
    m.update('a', A);
    expect(pads[0]!.last).toEqual(A);
    expect(m.list()[0]?.stale).toBe(false);
    now += 21000;
    expect(m.tick()).toEqual(['a']);
    expect(m.list()).toEqual([]);
    expect(pads[0]!.closed).toBe(1);
  });

  it('keepalive counts as activity without sending anything to the pad', () => {
    m.join('a', 'a', '10.0.0.1');
    m.update('a', A);
    const n = pads[0]!.updates.length;
    for (let i = 0; i < 10; i++) {
      now += 1000;
      m.keepalive('a');
      m.tick();
    }
    expect(pads[0]!.updates).toHaveLength(n);
    expect(m.list()[0]?.stale).toBe(false);
  });

  it('a stale pad that gets a keepalive resumes with its last state', () => {
    m.join('a', 'a', '10.0.0.1');
    m.update('a', A);
    now += 3000;
    m.tick();
    expect(pads[0]!.last).toEqual(neutralPad());
    m.keepalive('a');
    expect(pads[0]!.last).toEqual(A);
  });

  it('lists players with name, slot and address, and notifies listeners on every change', () => {
    const events: number[] = [];
    m.onChange(() => events.push(m.list().length));
    m.join('a', 'Pixel', '192.168.1.5');
    m.join('b', 'iPhone', '192.168.1.6');
    m.leave('a');
    expect(events).toEqual([1, 2, 1]);
    expect(m.list()).toMatchObject([{ id: 'b', slot: 2, name: 'iPhone', address: '192.168.1.6', stale: false }]);
  });

  it('closeAll releases every pad', () => {
    m.join('a', 'a', '10.0.0.1');
    m.join('b', 'b', '10.0.0.2');
    m.closeAll();
    expect(pads.map((p) => p.closed)).toEqual([1, 1]);
    expect(m.list()).toEqual([]);
  });
});
