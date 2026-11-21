import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStore } from '../../src/core/controller/layout.js';
import { LayoutFileStore, phoneKey } from '../../src/core/controller/layout-store.js';

const ID_A = 'phoneAAAAAAAAAAAA';
const ID_B = 'phoneBBBBBBBBBBBB';

describe('LayoutFileStore keyed by phone id', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'lanplay-layout-ids-')), 'layouts');
  });
  afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

  const custom = (name: string) => ({ version: 1, activeId: 'mine', layouts: [{ id: 'mine', name, controls: [{ id: 'd', type: 'dpad', x: 20, y: 20, size: 30 }] }] });
  const nameOf = (s: { layouts: { name: string }[] }) => s.layouts[0]!.name;

  it('the same id from two IPs gets the same layouts', () => {
    const s = new LayoutFileStore(dir);
    s.put('192.168.1.5', custom('Racing'), ID_A);
    expect(nameOf(s.get('192.168.1.5', ID_A))).toBe('Racing');
    expect(nameOf(s.get('192.168.1.99', ID_A))).toBe('Racing');
    expect(nameOf(s.get('10.1.2.3', ID_A))).toBe('Racing');
  });

  it('two ids on one IP get separate layouts, and neither leaks into the id-less IP file', () => {
    const s = new LayoutFileStore(dir);
    s.put('192.168.1.5', custom('Racing'), ID_A);
    s.put('192.168.1.5', custom('Shooter'), ID_B);
    expect(nameOf(s.get('192.168.1.5', ID_A))).toBe('Racing');
    expect(nameOf(s.get('192.168.1.5', ID_B))).toBe('Shooter');
    expect(s.get('192.168.1.5')).toEqual(defaultStore());
  });

  it('an old per-IP file is adopted by the first id that asks, once; the next phone on that IP starts clean', () => {
    const s = new LayoutFileStore(dir);
    s.put('192.168.1.5', custom('Old'));
    expect(nameOf(s.get('192.168.1.5', ID_A))).toBe('Old');
    expect(readdirSync(dir)).toEqual([`${phoneKey(ID_A)}.json`]);
    expect(s.get('192.168.1.5', ID_B)).toEqual(defaultStore());
    expect(nameOf(s.get('192.168.1.77', ID_A))).toBe('Old');
  });

  it('saving with an id also adopts the old per-IP file, so it is not inherited later', () => {
    const s = new LayoutFileStore(dir);
    s.put('192.168.1.5', custom('Old'));
    s.put('192.168.1.5', custom('New'), ID_A);
    expect(readdirSync(dir)).toEqual([`${phoneKey(ID_A)}.json`]);
    expect(s.get('192.168.1.5', ID_B)).toEqual(defaultStore());
  });

  it('a phone without an id keeps using its per-IP file as before', () => {
    const s = new LayoutFileStore(dir);
    s.put('192.168.1.5', custom('ByIp'));
    expect(nameOf(s.get('192.168.1.5'))).toBe('ByIp');
    s.put('192.168.1.5', custom('ByIp2'));
    expect(readdirSync(dir)).toEqual(['192.168.1.5.json']);
  });

  it('an invalid id is treated as no id', () => {
    const s = new LayoutFileStore(dir);
    s.put('192.168.1.5', custom('ByIp'));
    for (const bad of ['', 'short', '../../etc/passwd', 'x'.repeat(33), 'a b c d e f g h i j k l']) {
      expect(nameOf(s.get('192.168.1.5', bad))).toBe('ByIp');
    }
    s.put('192.168.1.5', custom('Still'), '../../../evil/evil/evil');
    expect(nameOf(s.get('192.168.1.5'))).toBe('Still');
    expect(readdirSync(path.dirname(dir)).sort()).toEqual(['layouts']);
  });

  it('files are named from a hash, never from the raw id, and stay inside the folder', () => {
    const s = new LayoutFileStore(dir);
    s.put('10.0.0.1', custom('X'), ID_A);
    const files = readdirSync(dir);
    expect(files).toEqual([`${phoneKey(ID_A)}.json`]);
    expect(files[0]).toMatch(/^p-[0-9a-f]{32}\.json$/);
    expect(files[0]).not.toContain(ID_A);
    expect(phoneKey('phoneAAAAAAAAAAAA')).not.toBe(phoneKey('PHONEAAAAAAAAAAAA')); // case-insensitive file systems cannot merge two ids
  });

  it('sanitizes what it stores for an id, and a corrupt id file falls back to the default', () => {
    const s = new LayoutFileStore(dir);
    expect(s.put('10.0.0.1', { layouts: 'no' }, ID_A)).toEqual(defaultStore());
    s.put('10.0.0.1', custom('X'), ID_A);
    writeFileSync(path.join(dir, `${phoneKey(ID_A)}.json`), '{not json');
    expect(s.get('10.0.0.1', ID_A)).toEqual(defaultStore());
    expect(nameOf(s.put('10.0.0.1', custom('Fixed'), ID_A))).toBe('Fixed');
    expect(JSON.parse(readFileSync(path.join(dir, `${phoneKey(ID_A)}.json`), 'utf8')).layouts[0].name).toBe('Fixed');
  });

  it('id files count towards maxPhones and a stray folder does not break it', () => {
    const s = new LayoutFileStore(dir, { maxPhones: 2 });
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    s.put('10.0.0.1', custom('1'), ID_A);
    s.put('10.0.0.1', custom('2'), ID_B);
    s.put('10.0.0.1', custom('3'), 'phoneCCCCCCCCCCCC');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(2);
  });
});
