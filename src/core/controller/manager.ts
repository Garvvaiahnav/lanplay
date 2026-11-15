// Phone-controller players (pure; no sockets, no driver): slots 1..N, one virtual pad per player, and the safety rules
// that keep a dead phone from leaving a button held down on the host.
import { MAX_PLAYERS, neutralPad } from './protocol.js';
import type { PadState } from './protocol.js';

/** A virtual controller on the host (src/core/controller/vigem.ts implements it for ViGEmBus). */
export interface VirtualPad {
  update(state: PadState): void;
  close(): void;
}

export interface ControllerManagerDeps {
  /** May throw (e.g. driver missing): join() turns that into { ok: false, reason: 'driver' }. */
  createPad(slot: number): VirtualPad;
  now(): number;
}

export interface ControllerManagerConfig {
  maxPlayers: number;
  /** No message for this long: the pad is set to neutral (until the phone speaks again). */
  staleMs: number;
  /** No message for this long: the player is removed. */
  dropMs: number;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerManagerConfig = Object.freeze({ maxPlayers: MAX_PLAYERS, staleMs: 2500, dropMs: 20_000 });

export interface PlayerInfo {
  /** Connection id (opaque). */
  id: string;
  /** Player number, 1-based. */
  slot: number;
  name: string;
  address: string;
  joinedAt: number;
  /** True while the phone is silent and its pad is held at neutral. */
  stale: boolean;
}

export type JoinResult = { ok: true; slot: number } | { ok: false; reason: 'full' } | { ok: false; reason: 'driver'; message: string };

interface Player extends PlayerInfo {
  pad: VirtualPad;
  lastSeen: number;
  last: PadState;
}

const same = (a: PadState, b: PadState): boolean => a.buttons === b.buttons && a.lt === b.lt && a.rt === b.rt && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx && a.ry === b.ry;

export class ControllerManager {
  private readonly players = new Map<string, Player>();
  private readonly listeners = new Set<() => void>();
  private readonly cfg: ControllerManagerConfig;

  constructor(
    private readonly d: ControllerManagerDeps,
    cfg: Partial<ControllerManagerConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_CONTROLLER_CONFIG, ...cfg };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  join(id: string, name: string, address: string): JoinResult {
    const have = this.players.get(id);
    if (have) return { ok: true, slot: have.slot };
    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0;
    for (let s = 1; s <= this.cfg.maxPlayers; s++) {
      if (!used.has(s)) {
        slot = s;
        break;
      }
    }
    if (slot === 0) return { ok: false, reason: 'full' };
    let pad: VirtualPad;
    try {
      pad = this.d.createPad(slot);
    } catch (e) {
      return { ok: false, reason: 'driver', message: (e as Error).message };
    }
    const now = this.d.now();
    this.players.set(id, { id, slot, name, address, joinedAt: now, stale: false, pad, lastSeen: now, last: neutralPad() });
    this.changed();
    return { ok: true, slot };
  }

  update(id: string, state: PadState): void {
    const p = this.players.get(id);
    if (!p) return;
    p.lastSeen = this.d.now();
    const wasStale = p.stale;
    p.stale = false;
    if (!wasStale && same(p.last, state)) return;
    p.last = { ...state };
    p.pad.update(p.last);
    if (wasStale) this.changed();
  }

  keepalive(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.lastSeen = this.d.now();
    if (p.stale) {
      p.stale = false;
      p.pad.update(p.last);
      this.changed();
    }
  }

  leave(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.release(p);
    this.changed();
  }

  kick(id: string): boolean {
    if (!this.players.has(id)) return false;
    this.leave(id);
    return true;
  }

  /** Call about once a second. Returns the ids that were dropped for silence (the server closes those sockets). */
  tick(): string[] {
    const now = this.d.now();
    const dropped: string[] = [];
    for (const p of [...this.players.values()]) {
      const quiet = now - p.lastSeen;
      if (quiet > this.cfg.dropMs) {
        dropped.push(p.id);
        this.leave(p.id);
      } else if (quiet > this.cfg.staleMs && !p.stale) {
        p.stale = true;
        p.pad.update(neutralPad());
        this.changed();
      }
    }
    return dropped;
  }

  list(): PlayerInfo[] {
    return [...this.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map(({ id, slot, name, address, joinedAt, stale }) => ({ id, slot, name, address, joinedAt, stale }));
  }

  closeAll(): void {
    for (const id of [...this.players.keys()]) this.leave(id);
  }

  private release(p: Player): void {
    try {
      p.pad.update(neutralPad());
    } finally {
      p.pad.close();
    }
  }
}
