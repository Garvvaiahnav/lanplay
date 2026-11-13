import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUNSHINE } from '../../src/contracts.js';
import { SUNSHINE_MSI_SHA256 } from '../../src/core/host/vendor.js';

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'vendor', 'manifest.json'), 'utf8')) as {
  artifacts: Array<{ id: string; url: string; sha256: string; asset: string }>;
  devTools: Array<{ id: string; sha256: Record<string, string> }>;
};

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
    ]);
    for (const a of manifest.artifacts) {
      expect(prefixes.some((p) => a.url.startsWith(p)), a.url).toBe(true);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const t of manifest.devTools) for (const h of Object.values(t.sha256)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('electron-builder ships the MSI, the PS wrappers, licenses and the Local Network keys', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(path.join(ROOT, 'scripts', 'electron-builder.config.cjs'));
    expect(cfg.win.signAndEditExecutable).toBe(false);
    expect(cfg.win.target.map((t: { target: string }) => t.target)).toEqual(['dir', 'zip']);
    expect(cfg.win.extraResources).toEqual(expect.arrayContaining([expect.objectContaining({ to: 'vendor/Sunshine-Windows-AMD64-installer.msi' }), expect.objectContaining({ from: 'scripts/windows', to: 'ps' })]));
    expect(cfg.extraResources.map((r: { to: string }) => r.to)).toEqual(expect.arrayContaining(['LICENSE', 'SOURCE-OFFER.md']));
    expect(cfg.mac.extendInfo.NSBonjourServices).toEqual(['_nvstream._tcp']);
    expect(cfg.mac.extendInfo.NSLocalNetworkUsageDescription).toBeTruthy();
    expect(cfg.mac.identity).toBeNull();
    // dmg/nsis targets would pull extra helper binaries from outside the download allow-list
    expect(cfg.mac.target.map((t: { target: string }) => t.target)).toEqual(['dir']);
  });
  it('npm pack scripts actually use that config (without it the Mac app ships without Moonlight and the Local Network keys)', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const name of ['pack:mac', 'pack:win']) expect(pkg.scripts[name], name).toContain('--config scripts/electron-builder.config.cjs');
    expect(pkg.scripts['pack:mac']).toMatch(/--mac dir --arm64/);
  });
});
