import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStore, legacyDefaultStoreV1 } from '../../src/core/controller/layout.js';
import { LayoutFileStore } from '../../src/core/controller/layout-store.js';

describe('LayoutFileStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'lanplay-layouts-')), 'layouts');
  });
  afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

  const custom = (name: string) => ({ version: 1, activeId: 'mine', layouts: [{ id: 'mine', name, controls: [{ id: 'd', type: 'dpad', x: 20, y: 20, size: 30 }] }] });

  it('gives the default store to a phone that never saved anything', () => {
    expect(new LayoutFileStore(dir).get('192.168.1.5')).toEqual(defaultStore());
  });

  it('saves per IP, returns the sanitized store, and keeps phones apart', () => {
    const s = new LayoutFileStore(dir);
    const saved = s.put('192.168.1.5', custom('Racing'));
    expect(saved.layouts[0]!.name).toBe('Racing');
    expect(s.get('192.168.1.5')).toEqual(saved);
    expect(s.get('192.168.1.6')).toEqual(defaultStore());
    s.put('192.168.1.6', custom('Shooter'));
    expect(s.get('192.168.1.5').layouts[0]!.name).toBe('Racing');
    expect(s.get('192.168.1.6').layouts[0]!.name).toBe('Shooter');
  });

  it('survives a new instance (really on disk) and creates the folder itself', () => {
    new LayoutFileStore(dir).put('10.0.0.2', custom('Disk'));
    expect(new LayoutFileStore(dir).get('10.0.0.2').layouts[0]!.name).toBe('Disk');
  });

  it('sanitizes what it stores: garbage in, valid store out', () => {
    const s = new LayoutFileStore(dir);
    expect(s.put('10.0.0.2', { layouts: 'no' })).toEqual(defaultStore());
    const odd = s.put('10.0.0.2', { version: 1, activeId: 'x', layouts: [{ id: 'x', name: 'N', controls: [{ id: 'z', type: 'laser' }] }] });
    expect(odd.layouts[0]!.controls).toEqual([]);
  });

  it('treats IPv4-mapped IPv6 and the plain address as the same phone', () => {
    const s = new LayoutFileStore(dir);
    s.put('::ffff:192.168.1.9', custom('Same'));
    expect(s.get('192.168.1.9').layouts[0]!.name).toBe('Same');
  });

  it('never lets an address escape the folder or create odd file names', () => {
    const s = new LayoutFileStore(dir);
    s.put('../../etc/passwd', custom('Evil'));
    s.put('fe80::1%en0', custom('V6'));
    const files = readdirSync(dir);
    expect(files.every((f) => /^[0-9a-f._-]+\.json$/.test(f))).toBe(true);
    expect(readdirSync(path.dirname(dir)).sort()).toEqual(['layouts']);
  });

  it('a corrupt file falls back to the default store instead of failing', () => {
    const s = new LayoutFileStore(dir);
    s.put('10.0.0.3', custom('X'));
    const f = path.join(dir, readdirSync(dir)[0]!);
    writeFileSync(f, '{not json');
    expect(s.get('10.0.0.3')).toEqual(defaultStore());
    expect(s.put('10.0.0.3', custom('Fixed')).layouts[0]!.name).toBe('Fixed');
  });

  it('keeps at most maxPhones files, dropping the least recently saved', () => {
    const s = new LayoutFileStore(dir, { maxPhones: 3 });
    for (let i = 1; i <= 3; i++) {
      s.put(`10.0.0.${i}`, custom(`P${i}`));
      const f = path.join(dir, readdirSync(dir).find((n) => n.startsWith(`10.0.0.${i}.`))!);
      utimesSync(f, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000));
    }
    s.put('10.0.0.4', custom('P4'));
    expect(readdirSync(dir)).toHaveLength(3);
    expect(s.get('10.0.0.1')).toEqual(defaultStore()); // oldest was dropped
    expect(s.get('10.0.0.4').layouts[0]!.name).toBe('P4');
  });

  it('a phone that saved the old stock layout unchanged gets the new default; a customised one is kept', () => {
    const s = new LayoutFileStore(dir);
    s.put('10.0.0.7', legacyDefaultStoreV1());
    expect(s.get('10.0.0.7')).toEqual(defaultStore());
    expect(defaultStore()).not.toEqual(legacyDefaultStoreV1());
    const tweaked = legacyDefaultStoreV1();
    (tweaked.layouts[0]!.controls[0] as { x: number }).x = 12;
    s.put('10.0.0.8', tweaked);
    expect(s.get('10.0.0.8')).toEqual(tweaked);
  });

  it('leaves no temporary files behind', () => {
    const s = new LayoutFileStore(dir);
    s.put('10.0.0.2', custom('A'));
    s.put('10.0.0.2', custom('B'));
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8')).layouts[0].name).toBe('B');
    mkdirSync(path.join(dir, 'sub'), { recursive: true }); // stray folders do not break eviction/listing
    expect(() => s.put('10.0.0.9', custom('C'))).not.toThrow();
  });
});
