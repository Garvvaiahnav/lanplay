import { beforeEach, describe, expect, it } from 'vitest';
import { ControllerManager } from '../../src/core/controller/manager.js';
import type { VirtualPad } from '../../src/core/controller/manager.js';
import { BTN, neutralPad, parseClientMessage } from '../../src/core/controller/protocol.js';
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

const ID_A = 'phoneAAAAAAAAAAAA';
const ID_B = 'phoneBBBBBBBBBBBB';
const A: PadState = { ...neutralPad(), buttons: BTN.A, lx: 1000 };

describe('ControllerManager sticky slots', () => {
  let now: number;
  let pads: FakePad[];
  let m: ControllerManager;

  beforeEach(() => {
    now = 1000;
    pads = [];
    m = new ControllerManager(
      {
        createPad: (slot) => {
          const p = new FakePad(slot);
          pads.push(p);
          return p;
        },
        now: () => now,
      },
      { maxPlayers: 4, staleMs: 2500, dropMs: 20000, graceMs: 15000 },
    );
  });

  it('rejoin with the same id inside 15 s gives the same slot and creates the pad once', () => {
    expect(m.join('c1', 'Pixel', '192.168.1.5', ID_A)).toEqual({ ok: true, slot: 1 });
    m.update('c1', A);
    m.detach('c1');
    now += 3000;
    m.tick();
    expect(pads).toHaveLength(1);
    expect(pads[0]!.closed).toBe(0);
    expect(pads[0]!.last).toEqual(neutralPad());
    expect(m.join('c2', 'Pixel', '192.168.1.77', ID_A)).toEqual({ ok: true, slot: 1, resumed: true });
    expect(pads).toHaveLength(1);
    expect(pads[0]!.closed).toBe(0);
    expect(m.list()).toMatchObject([{ id: 'c2', slot: 1, address: '192.168.1.77', stale: false, detached: false }]);
  });

  it('holds the pad neutral while detached and ignores late frames from the dead connection', () => {
    m.join('c1', 'x', '10.0.0.1', ID_A);
    m.update('c1', A);
    m.detach('c1');
    const n = pads[0]!.updates.length;
    m.update('c1', A);
    m.keepalive('c1');
    expect(pads[0]!.updates).toHaveLength(n);
    expect(pads[0]!.last).toEqual(neutralPad());
    expect(m.list()[0]).toMatchObject({ slot: 1, detached: true });
  });

  it('after the resume the old state is not pressed again; the first new frame goes through', () => {
    m.join('c1', 'x', '10.0.0.1', ID_A);
    m.update('c1', A);
    m.detach('c1');
    m.join('c2', 'x', '10.0.0.1', ID_A);
    expect(pads[0]!.last).toEqual(neutralPad());
    m.update('c2', A);
    expect(pads[0]!.last).toEqual(A);
  });

  it('after 15 s the pad is released and closed, the slot is free and the id gets a new pad', () => {
    m.join('c1', 'x', '10.0.0.1', ID_A);
    m.detach('c1');
    now += 14_900;
    m.tick();
    expect(pads[0]!.closed).toBe(0);
    now += 200;
    expect(m.tick()).toEqual([]);
    expect(pads[0]!.closed).toBe(1);
    expect(m.list()).toEqual([]);
    expect(m.join('c2', 'x', '10.0.0.1', ID_A)).toEqual({ ok: true, slot: 1 });
    expect(pads).toHaveLength(2);
  });

  it('a detached slot stays reserved: another phone gets the next number, and the full check counts it', () => {
    m.join('c1', 'a', '10.0.0.1', ID_A);
    m.detach('c1');
    expect(m.join('c2', 'b', '10.0.0.2', ID_B)).toEqual({ ok: true, slot: 2 });
    m.join('c3', 'c', '10.0.0.3');
    m.join('c4', 'd', '10.0.0.4');
    expect(m.join('c5', 'e', '10.0.0.5')).toEqual({ ok: false, reason: 'full' });
    expect(m.join('c6', 'a', '10.0.0.1', ID_A)).toEqual({ ok: true, slot: 1, resumed: true });
  });

  it('two different ids never share a slot', () => {
    m.join('c1', 'a', '10.0.0.1', ID_A);
    m.join('c2', 'b', '10.0.0.1', ID_B);
    m.detach('c1');
    m.detach('c2');
    expect(m.join('c3', 'b', '10.0.0.1', ID_B)).toEqual({ ok: true, slot: 2, resumed: true });
    expect(m.join('c4', 'a', '10.0.0.1', ID_A)).toEqual({ ok: true, slot: 1, resumed: true });
  });

  it('a phone with no id is removed the moment its socket closes', () => {
    m.join('c1', 'old page', '10.0.0.1');
    m.detach('c1');
    expect(pads[0]!.closed).toBe(1);
    expect(m.list()).toEqual([]);
  });

  it('a second socket with an attached id takes the slot over and names the old connection to close', () => {
    m.join('c1', 'x', '10.0.0.1', ID_A);
    m.update('c1', A);
    expect(m.join('c2', 'x', '10.0.0.1', ID_A)).toEqual({ ok: true, slot: 1, resumed: true, replaced: 'c1' });
    expect(pads).toHaveLength(1);
    expect(pads[0]!.last).toEqual(neutralPad());
    m.detach('c1'); // the old socket closing afterwards must not touch the new owner
    expect(m.list()).toMatchObject([{ id: 'c2', detached: false }]);
    expect(pads[0]!.closed).toBe(0);
  });

  it('kick removes a detached player for good, and closeAll releases it', () => {
    m.join('c1', 'x', '10.0.0.1', ID_A);
    m.join('c2', 'y', '10.0.0.2', ID_B);
    m.detach('c1');
    m.detach('c2');
    expect(m.kick('c1')).toBe(true);
    expect(pads[0]!.closed).toBe(1);
    m.closeAll();
    expect(pads[1]!.closed).toBe(1);
    expect(m.list()).toEqual([]);
  });

  it('notifies listeners when a player detaches and when it resumes', () => {
    const seen: boolean[] = [];
    m.join('c1', 'x', '10.0.0.1', ID_A);
    m.onChange(() => seen.push(m.list()[0]?.detached ?? false));
    m.detach('c1');
    m.join('c2', 'x', '10.0.0.1', ID_A);
    expect(seen).toEqual([true, false]);
  });
});

describe('host handling time', () => {
  it('parse + update stays far under 1 ms at p99 over 10,000 frames with a fake pad', () => {
    const m = new ControllerManager({ createPad: () => new FakePad(1), now: () => Date.now() });
    m.join('c', 'x', '10.0.0.1');
    const times: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const raw = `{"t":"s","b":${i & 0xf000},"lt":${i & 255},"rt":0,"lx":${(i * 7) % 30000},"ly":${-(i % 30000)},"rx":0,"ry":0}`;
      const t0 = performance.now();
      const msg = parseClientMessage(raw);
      if (msg && msg.t === 's') m.update('c', msg.pad);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.99)]!).toBeLessThan(1);
  });
});
