import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_URL_PREFIX, assetKey, compareVersions, parseManifest, Updater, verifySignature } from '../../src/core/update/update.js';
import type { UpdaterDeps } from '../../src/core/update/update.js';
import { applyScriptBody, planApply } from '../../src/core/update/apply.js';

const keys = generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const OTHER = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const INSTALLER = Buffer.from('pretend this is a Windows installer');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function manifestText(over: Record<string, unknown> = {}, asset: Partial<{ url: string; sha256: string; size: number }> = {}): string {
  return JSON.stringify({
    schema: 1,
    version: '0.3.0',
    notes: 'Faster reconnect',
    assets: { 'win32-x64': { url: `${ASSET_URL_PREFIX}v0.3.0/LanPlay-Setup-0.3.0.exe`, sha256: sha(INSTALLER), size: INSTALLER.length, ...asset } },
    ...over,
  });
}
const signText = (t: string) => sign(null, Buffer.from(t), keys.privateKey).toString('base64');

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });
  it('rejects anything that is not x.y.z', () => {
    expect(() => compareVersions('1.0', '1.0.0')).toThrow();
    expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow();
    expect(() => compareVersions('1.0.0-beta', '1.0.0')).toThrow();
  });
});

describe('parseManifest', () => {
  it('accepts a good manifest', () => {
    const m = parseManifest(manifestText());
    expect(m.version).toBe('0.3.0');
    expect(m.assets['win32-x64']?.size).toBe(INSTALLER.length);
  });
  it('rejects wrong schema, bad version, foreign download URLs, bad hash or size', () => {
    expect(() => parseManifest(manifestText({ schema: 2 }))).toThrow();
    expect(() => parseManifest(manifestText({ version: '3' }))).toThrow();
    expect(() => parseManifest(manifestText({}, { url: 'https://evil.example/LanPlay.exe' }))).toThrow();
    expect(() => parseManifest(manifestText({}, { url: 'http://github.com/Garvvaiahnav/lanplay/releases/download/v1/a.exe' }))).toThrow();
    expect(() => parseManifest(manifestText({}, { sha256: 'abc' }))).toThrow();
    expect(() => parseManifest(manifestText({}, { size: -1 }))).toThrow();
    expect(() => parseManifest('not json')).toThrow();
  });
});

describe('verifySignature', () => {
  it('accepts the real signature only', () => {
    const t = manifestText();
    expect(verifySignature(Buffer.from(t), signText(t), PUB)).toBe(true);
    expect(verifySignature(Buffer.from(t + ' '), signText(t), PUB)).toBe(false); // tampered
    expect(verifySignature(Buffer.from(t), signText(t), OTHER)).toBe(false); // wrong key
    expect(verifySignature(Buffer.from(t), 'not base64 !!', PUB)).toBe(false);
    expect(verifySignature(Buffer.from(t), '', PUB)).toBe(false);
  });
});

describe('Updater', () => {
  let dir: string;
  let downloads: string[];
  let served: { manifest: string; sig: string; file: Buffer };
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-upd-'));
    downloads = [];
    const m = manifestText();
    served = { manifest: m, sig: signText(m), file: INSTALLER };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (over: Partial<UpdaterDeps> = {}) =>
    new Updater({
      currentVersion: '0.2.0',
      platform: 'win32',
      arch: 'x64',
      stageDir: dir,
      publicKeyB64: PUB,
      fetchBytes: async (url) => Buffer.from(url.endsWith('manifest.sig') ? served.sig : served.manifest),
      downloadTo: async (url, dest) => {
        downloads.push(url);
        writeFileSync(dest, served.file);
      },
      ...over,
    });

  it('downloads, verifies and stages a newer signed release', async () => {
    const r = await make().check();
    expect(r).toMatchObject({ status: 'ready', version: '0.3.0', notes: 'Faster reconnect' });
    expect(downloads).toEqual([`${ASSET_URL_PREFIX}v0.3.0/LanPlay-Setup-0.3.0.exe`]);
    const staged = make().staged();
    expect(staged?.version).toBe('0.3.0');
    expect(readFileSync(staged!.file)).toEqual(INSTALLER);
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('does not download again once the update is staged', async () => {
    const u = make();
    await u.check();
    await u.check();
    expect(downloads).toHaveLength(1);
  });

  it('says up-to-date for the same or an older version', async () => {
    expect((await make({ currentVersion: '0.3.0' }).check()).status).toBe('up-to-date');
    expect((await make({ currentVersion: '0.4.0' }).check()).status).toBe('up-to-date');
    expect(downloads).toEqual([]);
  });

  it('refuses a manifest with a bad or foreign signature, and downloads nothing', async () => {
    served.sig = signText(served.manifest + 'x');
    const r = await make().check();
    expect(r).toMatchObject({ status: 'error', reason: 'bad-signature' });
    expect(await make({ publicKeyB64: OTHER }).check()).toMatchObject({ status: 'error', reason: 'bad-signature' });
    expect(downloads).toEqual([]);
  });

  it('refuses a download whose hash or size does not match, and stages nothing', async () => {
    served.file = Buffer.from('a different file of the same..........'.slice(0, INSTALLER.length));
    expect(await make().check()).toMatchObject({ status: 'error', reason: 'hash-mismatch' });
    expect(make().staged()).toBeNull();
    expect(readdirSync(dir).filter((f) => f !== 'staged.json')).toEqual([]);
  });

  it('reports no-asset when the release has no build for this platform', async () => {
    expect(await make({ platform: 'darwin', arch: 'arm64' }).check()).toMatchObject({ status: 'up-to-date', reason: 'no-asset' });
  });

  it('turns network failures into an error result, never a throw', async () => {
    const u = make({
      fetchBytes: async () => {
        throw new Error('offline');
      },
    });
    expect(await u.check()).toMatchObject({ status: 'error', reason: 'network' });
  });

  it('staged() drops an update that is not newer than the running app, or whose file changed', async () => {
    await make().check();
    expect(make({ currentVersion: '0.3.0' }).staged()).toBeNull();
    await make().check();
    const f = make().staged()!.file;
    writeFileSync(f, 'tampered');
    expect(make().staged()).toBeNull();
    expect(existsSync(f)).toBe(false);
  });

  it('markAttempted() lets the launch-time apply run only once per staged update', async () => {
    const u = make();
    await u.check();
    expect(u.staged()?.attempted).toBe(false);
    u.markAttempted();
    expect(make().staged()?.attempted).toBe(true);
  });
});

describe('assetKey / planApply', () => {
  it('keys assets by platform and arch', () => {
    expect(assetKey('win32', 'x64')).toBe('win32-x64');
    expect(assetKey('darwin', 'arm64')).toBe('darwin-arm64');
  });

  it('Windows runs the installer silently and asks it to restart the app', () => {
    const p = planApply({ platform: 'win32', file: 'C:\\x\\LanPlay-Setup-0.3.0.exe', appPath: null, pid: 42, stageDir: 'C:\\x' });
    expect(p).toEqual({ command: 'C:\\x\\LanPlay-Setup-0.3.0.exe', args: ['--updated', '/S', '--force-run'] });
  });

  it('macOS swaps the .app with a helper script after the app exits', () => {
    const p = planApply({ platform: 'darwin', file: '/stage/LanPlay-mac-arm64.zip', appPath: '/Applications/LanPlay.app', pid: 42, stageDir: '/stage' });
    expect(p).toMatchObject({ command: '/bin/sh', args: ['/stage/apply-update.sh', '42', '/stage/LanPlay-mac-arm64.zip', '/Applications/LanPlay.app'] });
    expect(p?.script).toBe(applyScriptBody());
    expect(applyScriptBody()).toContain('ditto -x -k');
    expect(applyScriptBody()).toContain('kill -0');
  });

  it('macOS from a dev checkout (no .app) and unknown platforms cannot self-update', () => {
    expect(planApply({ platform: 'darwin', file: '/s/a.zip', appPath: null, pid: 1, stageDir: '/s' })).toBeNull();
    expect(planApply({ platform: 'linux', file: '/s/a', appPath: null, pid: 1, stageDir: '/s' })).toBeNull();
  });
});
