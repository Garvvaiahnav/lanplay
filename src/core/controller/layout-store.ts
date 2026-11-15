// Phone layouts on the host disk, one JSON file per phone IP (LayoutStore, see layout.ts). Everything written is sanitized;
// anything unreadable falls back to the default layouts. File names are derived from the normalized address only.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeAddress } from '../shared/ipnet.js';
import { defaultStore, sanitizeStore } from './layout.js';
import type { LayoutStore } from './layout.js';

export interface LayoutFileStoreOptions {
  /** At most this many phones keep layouts; saving for a new phone drops the least recently saved one. */
  maxPhones?: number;
}

/** "192.168.1.5" -> "192.168.1.5"; IPv6 "fe80::1" -> "fe80__1". Only [0-9a-f._-] survive. */
export function addressKey(address: string): string {
  return normalizeAddress(address).replace(/:/g, '_').replace(/[^0-9a-f._-]/g, '-').replace(/\.{2,}/g, '.').slice(0, 64) || 'unknown';
}

export class LayoutFileStore {
  private readonly maxPhones: number;

  constructor(
    private readonly dir: string,
    o: LayoutFileStoreOptions = {},
  ) {
    this.maxPhones = o.maxPhones ?? 64;
  }

  private file(address: string): string {
    return path.join(this.dir, `${addressKey(address)}.json`);
  }

  get(address: string): LayoutStore {
    try {
      return sanitizeStore(JSON.parse(readFileSync(this.file(address), 'utf8')));
    } catch {
      return defaultStore();
    }
  }

  /** Sanitizes, writes atomically (temp file + rename) and returns what was stored. */
  put(address: string, input: unknown): LayoutStore {
    const store = sanitizeStore(input);
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(address);
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
