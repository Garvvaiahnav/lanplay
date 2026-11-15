import { describe, expect, it } from 'vitest';
import { SUNSHINE_MANAGED_CONFIG, SUNSHINE_MAC } from '../../src/contracts.js';
import type { ExecRequest, ExecResult, ProcessRunner } from '../../src/contracts.js';
import {
  bundledSunshineApp,
  describeSignatureArgv,
  dittoArgv,
  installedJsonText,
  macManagedConfig,
  parseCodesignDetails,
  parseInstalledJson,
  planSunshineInstall,
  sunshineAgentSpec,
  sunshinePaths,
  verifySignatureArgv,
  verifySunshineSignature,
} from '../../src/core/host/mac/sunshine-mac.js';
import { buildAgentPlist } from '../../src/core/host/mac/launchd.js';

const TEAM = 'F8XQ7XCN2R';
const SHARED = '/Users/me/Library/Application Support/LanPlay';
const LOGS = '/Users/me/Library/Logs/LanPlay';
const P = sunshinePaths(SHARED, LOGS);

// `codesign -dvv vendor/sunshine-macos-arm64/Sunshine.app` (stderr), recorded on 2026-11-16.
const CODESIGN_SUNSHINE = `Executable=/x/Sunshine.app/Contents/MacOS/Sunshine
Identifier=dev.lizardbyte.app.Sunshine
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=119399 flags=0x10000(runtime) hashes=3720+7 location=embedded
Signature size=9048
Authority=Developer ID Application: LizardByte LLC (F8XQ7XCN2R)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=15 Sep 2026 at 5:17:38 AM
Info.plist entries=15
TeamIdentifier=F8XQ7XCN2R
Runtime Version=15.2.0
Sealed Resources version=2 rules=13 files=121
Internal requirements count=1 size=188
`;
// `codesign -dvv /Applications/LanPlay.app`: ad-hoc, no team.
const CODESIGN_ADHOC = `Executable=/Applications/LanPlay.app/Contents/MacOS/LanPlay
Identifier=Electron
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none
`;

describe('paths', () => {
  it('keeps everything private to LanPlay, never ~/.config/sunshine', () => {
    expect(P).toEqual({
      dir: `${SHARED}/sunshine`,
      app: `${SHARED}/sunshine/Sunshine.app`,
      staging: `${SHARED}/sunshine/staging/Sunshine.app`,
      binary: `${SHARED}/sunshine/Sunshine.app/Contents/MacOS/Sunshine`,
      conf: `${SHARED}/sunshine/sunshine.conf`,
      state: `${SHARED}/sunshine/sunshine_state.json`,
      credentialsDir: `${SHARED}/sunshine/credentials`,
      pkey: `${SHARED}/sunshine/credentials/cakey.pem`,
      cert: `${SHARED}/sunshine/credentials/cacert.pem`,
      apps: `${SHARED}/sunshine/apps.json`,
      installedJson: `${SHARED}/sunshine/installed.json`,
      log: `${LOGS}/sunshine.log`,
      launchdLog: `${LOGS}/sunshine-launchd.log`,
      pinnedCert: `${SHARED}/sunshine-cert.pem`,
    });
  });

  it('locates the app bundled in the LanPlay resources folder', () => {
    expect(bundledSunshineApp('/Applications/LanPlay.app/Contents/Resources')).toBe('/Applications/LanPlay.app/Contents/Resources/vendor/Sunshine.app');
  });

  it('manages the Windows keys plus absolute private paths and a hidden tray icon', () => {
    expect(macManagedConfig(P)).toEqual({
      ...SUNSHINE_MANAGED_CONFIG,
      pkey: P.pkey,
      cert: P.cert,
      log_path: P.log,
      file_state: P.state,
      credentials_file: P.state,
      file_apps: P.apps,
      system_tray: 'disabled',
    });
  });

  it('runs the copy with the private config as argv[1] under KeepAlive', () => {
    const spec = sunshineAgentSpec(P);
    expect(spec).toEqual({
      label: SUNSHINE_MAC.launchdLabel,
      program: P.binary,
      args: [P.conf],
      keepAlive: true,
      stdoutPath: P.launchdLog,
      stderrPath: P.launchdLog,
    });
    expect(buildAgentPlist(spec)).toContain(`<string>${P.conf}</string>`);
  });
});

describe('signature argv and parsing', () => {
  it('verifies the whole bundle strictly and reads details with -dvv', () => {
    expect(verifySignatureArgv('/a b/Sunshine.app')).toEqual({ file: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', '/a b/Sunshine.app'] });
    expect(describeSignatureArgv('/a b/Sunshine.app')).toEqual({ file: '/usr/bin/codesign', args: ['-dvv', '/a b/Sunshine.app'] });
  });

  it('parses identifier, team and authority chain from codesign -dvv output', () => {
    expect(parseCodesignDetails(CODESIGN_SUNSHINE)).toEqual({
      identifier: SUNSHINE_MAC.bundleId,
      teamId: TEAM,
      authorities: ['Developer ID Application: LizardByte LLC (F8XQ7XCN2R)', 'Developer ID Certification Authority', 'Apple Root CA'],
    });
  });

  it('reports no team for an ad-hoc signature and for empty output', () => {
    expect(parseCodesignDetails(CODESIGN_ADHOC)).toEqual({ identifier: 'Electron', teamId: null, authorities: [] });
    expect(parseCodesignDetails('')).toEqual({ identifier: null, teamId: null, authorities: [] });
  });
});

function result(over: Partial<ExecResult>): ExecResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, ...over };
}

/** Answers codesign calls from a script and records every request. */
function fakeCodesign(opts: { verifyExit?: number; verifyStderr?: string; details?: string; spawnError?: string }): ProcessRunner & { calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  return {
    calls,
    async run(req) {
      calls.push(req);
      if (opts.spawnError) return result({ exitCode: null, spawnError: opts.spawnError });
      if (req.args.includes('--verify')) return result({ exitCode: opts.verifyExit ?? 0, stderr: opts.verifyStderr ?? '' });
      return result({ stderr: opts.details ?? CODESIGN_SUNSHINE });
    },
  };
}

describe('verifySunshineSignature', () => {
  it('accepts a valid bundle signed by the pinned team', async () => {
    const r = fakeCodesign({});
    expect(await verifySunshineSignature(r, '/x/Sunshine.app', TEAM)).toEqual({ ok: true, teamId: TEAM });
    expect(r.calls.map((c) => c.args[0])).toEqual(['--verify', '-dvv']);
    expect(r.calls.every((c) => c.file === '/usr/bin/codesign' && c.timeoutMs > 0)).toBe(true);
  });

  it('rejects a bundle whose seal is broken and skips the team lookup', async () => {
    const r = fakeCodesign({ verifyExit: 1, verifyStderr: 'a sealed resource is missing or invalid' });
    const v = await verifySunshineSignature(r, '/x/Sunshine.app', TEAM);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('a sealed resource is missing or invalid');
    expect(r.calls).toHaveLength(1);
  });

  it('rejects a valid signature from another team', async () => {
    const r = fakeCodesign({ details: CODESIGN_ADHOC });
    const v = await verifySunshineSignature(r, '/x/Sunshine.app', TEAM);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/team/i);
  });

  it('rejects another app from the same team (only Sunshine may be installed and run)', async () => {
    const v = await verifySunshineSignature(fakeCodesign({ details: CODESIGN_SUNSHINE.replace('Identifier=dev.lizardbyte.app.Sunshine', 'Identifier=dev.lizardbyte.app.Other') }), '/x/Sunshine.app', TEAM);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/dev\.lizardbyte\.app\.Other/);
  });

  it('rejects when codesign cannot be started', async () => {
    const v = await verifySunshineSignature(fakeCodesign({ spawnError: 'ENOENT' }), '/x/Sunshine.app', TEAM);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('ENOENT');
  });
});

describe('installed.json', () => {
  const info = { version: '2026.914.233613', dmgSha256: 'ab'.repeat(32), teamId: TEAM, copiedAt: '2026-11-16T10:00:00.000Z' };

  it('round-trips', () => {
    expect(parseInstalledJson(installedJsonText(info))).toEqual(info);
  });

  it.each(['', 'not json', '[]', '{}', JSON.stringify({ ...info, version: 5 }), JSON.stringify({ version: 'x' })])('treats %j as missing', (t) => {
    expect(parseInstalledJson(t)).toBeNull();
  });
});

describe('ditto', () => {
  it('copies with ditto so the signature and xattrs survive', () => {
    expect(dittoArgv('/a/Sunshine.app', '/b c/Sunshine.app')).toEqual({ file: '/usr/bin/ditto', args: ['/a/Sunshine.app', '/b c/Sunshine.app'] });
  });
});

describe('planSunshineInstall: needsCopy matrix', () => {
  const want = { version: '2026.914.233613', dmgSha256: 'ab'.repeat(32), teamId: TEAM };
  const installed = { ...want, copiedAt: '2026-11-16T10:00:00.000Z' };

  function fakeFs(files: Record<string, string>) {
    return {
      exists: (p: string) => p in files,
      readText: async (p: string) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p]!;
      },
    };
  }
  const withApp = (extra: Record<string, string> = {}) => ({ [P.app]: '', ...extra });

  it('copies when the app is absent, without running codesign', async () => {
    const r = fakeCodesign({});
    expect(await planSunshineInstall({ fs: fakeFs({}), runner: r }, P, want)).toEqual({ needsCopy: true, reason: 'absent' });
    expect(r.calls).toHaveLength(0);
  });

  it('copies when installed.json is missing or unreadable', async () => {
    expect(await planSunshineInstall({ fs: fakeFs(withApp()), runner: fakeCodesign({}) }, P, want)).toEqual({ needsCopy: true, reason: 'no-metadata' });
    expect(await planSunshineInstall({ fs: fakeFs(withApp({ [P.installedJson]: '{oops' })), runner: fakeCodesign({}) }, P, want)).toEqual({ needsCopy: true, reason: 'no-metadata' });
  });

  it('copies when the version differs', async () => {
    const fs = fakeFs(withApp({ [P.installedJson]: installedJsonText({ ...installed, version: '2026.801.1' }) }));
    expect(await planSunshineInstall({ fs, runner: fakeCodesign({}) }, P, want)).toEqual({ needsCopy: true, reason: 'version-changed' });
  });

  it('copies when the same version was repackaged (different dmg digest)', async () => {
    const fs = fakeFs(withApp({ [P.installedJson]: installedJsonText({ ...installed, dmgSha256: 'cd'.repeat(32) }) }));
    expect(await planSunshineInstall({ fs, runner: fakeCodesign({}) }, P, want)).toEqual({ needsCopy: true, reason: 'version-changed' });
  });

  it('copies when the copy on disk no longer verifies', async () => {
    const fs = fakeFs(withApp({ [P.installedJson]: installedJsonText(installed) }));
    const plan = await planSunshineInstall({ fs, runner: fakeCodesign({ verifyExit: 1, verifyStderr: 'invalid signature' }) }, P, want);
    expect(plan).toEqual({ needsCopy: true, reason: 'signature-invalid' });
  });

  it('keeps a current, valid copy untouched', async () => {
    const fs = fakeFs(withApp({ [P.installedJson]: installedJsonText(installed) }));
    const r = fakeCodesign({});
    expect(await planSunshineInstall({ fs, runner: r }, P, want)).toEqual({ needsCopy: false, reason: 'current' });
    expect(r.calls[0]!.args).toContain(P.app);
  });
});
