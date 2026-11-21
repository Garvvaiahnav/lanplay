// Phone layouts on the host disk (LayoutStore, see layout.ts), one JSON file per phone. A phone that sends its id is filed
// under a hash of that id (`p-<32 hex>.json`); a phone without one, and every file written before ids existed, is filed under
// its normalized IP. The first read with an id adopts the phone's old per-IP file when no id file exists yet.
// Everything written is sanitized; anything unreadable falls back to the default layouts. File names never contain raw input.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeAddress } from '../shared/ipnet.js';
import { defaultStore, legacyDefaultStoreV1, sanitizeStore } from './layout.js';
import type { LayoutStore } from './layout.js';
import { sanitizePhoneId } from './protocol.js';

const LEGACY_DEFAULT_JSON = JSON.stringify(legacyDefaultStoreV1());

export interface LayoutFileStoreOptions {
  /** At most this many phones keep layouts; saving for a new phone drops the least recently saved one. */
  maxPhones?: number;
}

/** "192.168.1.5" -> "192.168.1.5"; IPv6 "fe80::1" -> "fe80__1". Only [0-9a-f._-] survive. */
export function addressKey(address: string): string {
  return normalizeAddress(address).replace(/:/g, '_').replace(/[^0-9a-f._-]/g, '-').replace(/\.{2,}/g, '.').slice(0, 64) || 'unknown';
}

/** File stem for a phone id: a hash, so the id (a bearer-ish value on the wire) never reaches the disk and case cannot collide. */
export function phoneKey(phoneId: string): string {
  return `p-${createHash('sha256').update(phoneId).digest('hex').slice(0, 32)}`;
}

export class LayoutFileStore {
  private readonly maxPhones: number;

  constructor(
    private readonly dir: string,
    o: LayoutFileStoreOptions = {},
  ) {
    this.maxPhones = o.maxPhones ?? 64;
  }

  private addressFile(address: string): string {
    return path.join(this.dir, `${addressKey(address)}.json`);
  }

  /** The file for this phone: the id file when the phone sent a valid id, otherwise the per-IP file. */
  private file(address: string, phoneId: string | undefined): string {
    return phoneId === undefined ? this.addressFile(address) : path.join(this.dir, `${phoneKey(phoneId)}.json`);
  }

  private read(file: string): LayoutStore {
    const stored = sanitizeStore(JSON.parse(readFileSync(file, 'utf8')));
    // Saved but never changed from the old stock layout: give the phone the current default instead.
    return JSON.stringify(stored) === LEGACY_DEFAULT_JSON ? defaultStore() : stored;
  }

  /** A phone id that does not have the documented shape is ignored (the phone is treated as one without an id). */
  get(address: string, phoneId?: string): LayoutStore {
    const id = sanitizePhoneId(phoneId);
    try {
      const target = this.file(address, id);
      if (id !== undefined && !existsSync(target)) this.adopt(address, target);
      return this.read(target);
    } catch {
      return defaultStore();
    }
  }

  /** Sanitizes, writes atomically (temp file + rename) and returns what was stored. */
  put(address: string, input: unknown, phoneId?: string): LayoutStore {
    const store = sanitizeStore(input);
    const id = sanitizePhoneId(phoneId);
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(address, id);
    if (id !== undefined && !existsSync(target)) this.adopt(address, target);
    this.evictFor(target);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(store));
      renameSync(tmp, target);
    } finally {
      rmSync(tmp, { force: true });
    }
    return store;
  }

  /** Moves the pre-id per-IP file to the id file, once. The first phone to ask from that IP gets it; the next one starts clean. */
  private adopt(address: string, target: string): void {
    const old = this.addressFile(address);
    try {
      if (existsSync(old)) renameSync(old, target);
    } catch {
      /* the caller reads or writes the target next and copes with a missing file */
    }
  }

  private evictFor(target: string): void {
    let files: { path: string; mtime: number }[];
    try {
      files = readdirSync(this.dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => path.join(this.dir, n))
        .map((p) => ({ path: p, mtime: statSync(p).mtimeMs }));
    } catch {
      return;
    }
    if (files.some((f) => f.path === target)) return;
    files.sort((a, b) => a.mtime - b.mtime);
    while (files.length >= this.maxPhones) rmSync((files.shift() as { path: string }).path, { force: true });
  }
}
