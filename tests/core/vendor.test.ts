import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUNSHINE } from '../../src/contracts.js';
import { SUNSHINE_MSI_SHA256 } from '../../src/core/host/vendor.js';

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'vendor', 'manifest.json'), 'utf8')) as {
  artifacts: Array<{ id: string; url: string; sha256: string; asset: string; extracted?: { file: string; sha256: string; sizeBytes: number; requiredExports: string[] } }>;
  devTools: Array<{ id: string; sha256: Record<string, string> }>;
};

/** Just enough glob for the one pattern checked above: `a/{x-*,y}/**` against `a/x-1/file`. */
function minimatchBraces(pattern: string, file: string): boolean {
  const m = /^(.*)\{([^}]*)\}(.*)$/.exec(pattern);
  if (!m) return false;
  return m[2]!.split(',').some((alt) => {
    const re = new RegExp('^' + (m[1]! + alt + m[3]!).replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
    return re.test(file);
  });
}

describe('vendor pinning', () => {
  it('the MSI hash in code equals vendor/manifest.json', () => {
    const msi = manifest.artifacts.find((a) => a.id === 'sunshine-windows-msi')!;
    expect(msi.asset).toBe(SUNSHINE.msiAsset);
    expect(msi.sha256).toBe(SUNSHINE_MSI_SHA256);
  });
  it('every artifact is an allow-listed GitHub release URL with a SHA256', () => {
    const src = readFileSync(path.join(ROOT, 'scripts', 'fetch-vendor.mjs'), 'utf8');
    const prefixes = [...src.matchAll(/'(https:\/\/github\.com\/[^']+\/releases\/download\/)'/g)].map((m) => m[1]!);
    expect(prefixes).toEqual([
      'https://github.com/LizardByte/Sunshine/releases/download/',
      'https://github.com/moonlight-stream/moonlight-qt/releases/download/',
      'https://github.com/PowerShell/PowerShell/releases/download/',
      'https://github.com/nefarius/ViGEmBus/releases/download/',
    ]);
    // the one non-GitHub source: the official NuGet package that carries ViGEmClient.dll, pinned to one exact version
    const nuget = 'https://api.nuget.org/v3-flatcontainer/nefarius.vigem.client/';
    expect(src).toContain(`'${nuget}'`);
    for (const a of manifest.artifacts) {
      expect(prefixes.some((p) => a.url.startsWith(p)) || a.url.startsWith(nuget), a.url).toBe(true);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const t of manifest.devTools) for (const h of Object.values(t.sha256)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('pins ViGEmBus and ViGEmClient (installer, nupkg and the extracted DLL) by SHA256', () => {
    const bus = manifest.artifacts.find((a) => a.id === 'vigembus-windows-installer')!;
    expect(bus.asset).toBe('ViGEmBus_1.22.0_x64_x86_arm64.exe');
    expect(bus.sha256).toBe('89220a7865076b342892f98865f3499fb7c4cfd673159e89d352c360fd014c6a');
    const client = manifest.artifacts.find((a) => a.id === 'vigemclient-windows-x64')!;
    expect(client.url).toContain('/nefarius.vigem.client/1.21.256/');
    expect(client.extracted).toMatchObject({ file: 'ViGEmClient.dll', sizeBytes: 141312, sha256: '00303f99e1968d523fbd08a7c691d60d145b7335059ec593947841d124c10875' });
    expect(client.extracted!.requiredExports).toEqual(expect.arrayContaining(['vigem_alloc', 'vigem_connect', 'vigem_target_x360_alloc', 'vigem_target_add', 'vigem_target_x360_update']));
    // the wrapper that installs the driver pins the same installer hash as the manifest
    const ps = readFileSync(path.join(ROOT, 'scripts', 'windows', 'install-vigembus.ps1'), 'utf8');
    expect(ps).toContain(bus.sha256);
    expect(ps).toContain('/exenoui');
  });
  it('verifies the downloaded ViGEm files when they are present (hash, PE x64, exports)', async () => {
    const dll = path.join(ROOT, 'vendor', 'vigemclient-windows-x64', 'ViGEmClient.dll');
    const exe = path.join(ROOT, 'vendor', 'vigembus-windows-installer', 'ViGEmBus_1.22.0_x64_x86_arm64.exe');
    if (!existsSync(dll) || !existsSync(exe)) return; // fetched with: node scripts/fetch-vendor.mjs --windows
    const tools = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'pe-tools.mjs')).href)) as {
      parsePe(b: Buffer): { machine: number; isDll: boolean };
      peExports(b: Buffer): string[];
    };
    const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
    const client = manifest.artifacts.find((a) => a.id === 'vigemclient-windows-x64')!;
    const bus = manifest.artifacts.find((a) => a.id === 'vigembus-windows-installer')!;
    expect(sha(dll)).toBe(client.extracted!.sha256);
    expect(sha(exe)).toBe(bus.sha256);
    const buf = readFileSync(dll);
    expect(tools.parsePe(buf)).toMatchObject({ machine: 0x8664, isDll: true });
    expect(tools.peExports(buf)).toEqual(expect.arrayContaining(client.extracted!.requiredExports));
  });
  it('pe-tools rejects garbage instead of reading past the buffer', async () => {
    const tools = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'pe-tools.mjs')).href)) as {
      parsePe(b: Buffer): unknown;
      peExports(b: Buffer): string[];
      extractEmbeddedNativeDll(b: Buffer, machine: number): Buffer;
    };
    expect(() => tools.parsePe(Buffer.from('not a pe file at all, just text'))).toThrow(/malformed PE/);
    const mz = Buffer.alloc(0x100);
    mz.write('MZ');
    mz.writeUInt32LE(0xfffffff0, 0x3c); // e_lfanew far past the end
    expect(() => tools.peExports(mz)).toThrow(/malformed PE/);
    expect(() => tools.extractEmbeddedNativeDll(mz, 0x8664)).toThrow(/malformed PE/);
  });
  it('electron-builder ships the MSI, the PS wrappers, licenses and the Local Network keys', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(path.join(ROOT, 'scripts', 'electron-builder.config.cjs'));
    expect(cfg.win.signAndEditExecutable).toBe(false);
    expect(cfg.win.target.map((t: { target: string }) => t.target)).toEqual(['dir', 'zip', 'nsis']);
    expect(cfg.nsis).toMatchObject({ oneClick: true, perMachine: false, runAfterFinish: true, artifactName: 'LanPlay-Setup-${version}.${ext}' });
    expect(cfg.win.extraResources).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'vendor/moonlight-windows', to: 'vendor/moonlight-windows', filter: ['**/*', '!MoonlightPortable-*.zip'] })]));
    expect(cfg.win.extraResources).toEqual(expect.arrayContaining([expect.objectContaining({ to: 'vendor/Sunshine-Windows-AMD64-installer.msi' }), expect.objectContaining({ from: 'scripts/windows', to: 'ps' })]));
    // phone controllers: the driver installer + client DLL land next to the MSI, license texts next to the GPL ones
    expect(cfg.win.extraResources).toEqual(
      expect.arrayContaining([
        { from: 'vendor/vigemclient-windows-x64/ViGEmClient.dll', to: 'vendor/ViGEmClient.dll' },
        { from: 'vendor/vigembus-windows-installer/ViGEmBus_1.22.0_x64_x86_arm64.exe', to: 'vendor/ViGEmBus_1.22.0_x64_x86_arm64.exe' },
        { from: 'third-party-licenses/ViGEmBus-BSD-3-Clause.txt', to: 'licenses/ViGEmBus-BSD-3-Clause.txt' },
        { from: 'third-party-licenses/ViGEmClient-MIT.txt', to: 'licenses/ViGEmClient-MIT.txt' },
      ]),
    );
    // koffi: the Windows x64 addon is unpacked from the asar; no other platform's binary is packed
    expect(cfg.asarUnpack).toEqual(['node_modules/@koromix/koffi-win32-x64/**']);
    const dropped = cfg.files.filter((f: string) => f.startsWith('!node_modules/@koromix/'));
    expect(dropped).toHaveLength(1);
    for (const plat of ['android-arm64', 'darwin-arm64', 'darwin-x64', 'freebsd-x64', 'linux-x64', 'openbsd-x64', 'win32-arm64', 'win32-ia32']) {
      expect(minimatchBraces(dropped[0].slice(1), `node_modules/@koromix/koffi-${plat}/index.js`), plat).toBe(true);
    }
    expect(minimatchBraces(dropped[0].slice(1), 'node_modules/@koromix/koffi-win32-x64/index.js')).toBe(false);
    expect(cfg.extraResources.map((r: { to: string }) => r.to)).toEqual(expect.arrayContaining(['LICENSE', 'SOURCE-OFFER.md']));
    expect(cfg.mac.extendInfo.NSBonjourServices).toEqual(['_nvstream._tcp']);
    expect(cfg.mac.extendInfo.NSLocalNetworkUsageDescription).toBeTruthy();
    expect(cfg.mac.identity).toBeNull();
    // dmg targets would pull extra helper binaries from outside the download allow-list
    expect(cfg.mac.target.map((t: { target: string }) => t.target)).toEqual(['dir']);
  });
  it('npm pack scripts actually use that config (without it the Mac app ships without Moonlight and the Local Network keys)', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const name of ['pack:mac', 'pack:win']) expect(pkg.scripts[name], name).toContain('--config scripts/electron-builder.config.cjs');
    expect(pkg.scripts['pack:mac']).toMatch(/--mac dir --arm64/);
    // a Windows build made on a Mac needs koffi's win32-x64 package installed first
    expect(pkg.scripts['pack:win']).toContain('node scripts/ensure-koffi-native.mjs win32-x64 && electron-builder');
  });
});
