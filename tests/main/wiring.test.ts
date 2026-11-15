import { describe, expect, it } from 'vitest';
import { SUNSHINE_MAC } from '../../src/contracts.js';
import type { ClientService, ExecRequest, ExecResult, HostSetupStatus, IpcEventChannel, SelfCheckReport, ServiceDeps } from '../../src/contracts.js';
import { createPadBackendFor, MAC_PADS_UNAVAILABLE } from '../../src/core/controller/backend.js';
import { plistPath } from '../../src/core/host/mac/launchd.js';
import { MacHostService } from '../../src/core/host/mac/service-mac.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { buildHandlers, buildServices, hostSupported, releaseMacHost, runSelfCheckCli } from '../../src/main/wiring.js';
import type { MacHostControls, Services, WiringEnv } from '../../src/main/wiring.js';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';

function env(over: Partial<WiringEnv> = {}): WiringEnv {
  const log = new MemoryLogger();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-wiring-'));
  const deps: ServiceDeps = {
    log,
    paths: { logDir: dir, userData: dir, sharedData: dir, resources: dir, vendorDir: dir, psDir: dir, diagnosticsOutDir: dir, logDirFellBack: false },
    secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined, backend: () => 'keychain' },
    settings: new MemoryStore(),
    runner: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false }) },
  };
  return { role: 'client', deps, appInfo: { name: 'LanPlay', version: '0.1.0', electron: '45', node: '26', chrome: '1' }, selfExe: '/x', selfArgsPrefix: [], isPackaged: false, appRoot: dir, loginItem: null, fileExists: () => false, ...over };
}

describe('buildHandlers', () => {
  it('only reveals zips created in this session; dedupes concurrent self-checks; pushes events', async () => {
    let checks = 0;
    const rep: SelfCheckReport = { role: 'client', startedAt: new Date().toISOString(), durationMs: 1, ok: true, steps: [] };
    const pushed: IpcEventChannel[] = [];
    const client = {
      systemInfo: async () => ({ chip: { model: 'Apple M4', generation: 4, av1HardwareDecode: true }, moonlightPath: null, moonlightVersion: null }),
      discovery: { start: (cb: (h: never[]) => void) => cb([]), stop: () => undefined, addManual: async () => { throw new Error('x'); }, list: () => [] },
      getSettings: () => ({}) as never,
      setSettings: (s: never) => s,
      pair: async () => ({ ok: true, hostId: 'h', alreadyPaired: true, durationMs: 1 }),
      startStream: async () => ({ hostId: 'h', state: 'running' }),
      stopStream: async () => undefined,
      selfCheck: async () => rep,
    } as unknown as ClientService;
    const s: Services = {
      client,
      host: null,
      controllers: null,
      macHost: null,
      diagnostics: { collect: async () => ({ zipPath: '/tmp/LanPlay-diagnostics-x.zip', bytes: 10 }) },
      selfCheck: async () => {
        checks++;
        await new Promise((r) => setTimeout(r, 20));
        return rep;
      },
      resolvedPaths: {},
    };
    const revealed: string[] = [];
    const h = buildHandlers(env(), s, (c) => void pushed.push(c), (p) => void revealed.push(p));
    await expect(h['diagnostics:reveal']!({ zipPath: '/etc/passwd' })).rejects.toThrow(/Only a diagnostics file/);
    const z = await h['diagnostics:collect']!();
    await h['diagnostics:reveal']!({ zipPath: z.zipPath });
    expect(revealed).toEqual([z.zipPath]);
    await Promise.all([h['selfcheck:run']!(), h['selfcheck:run']!()]);
    expect(checks).toBe(1);
    await h['client:discover-start']!();
    expect(pushed).toContain('client:hosts-updated');
    expect(h['host:setup-run']).toBeUndefined();
    const info = await h['app:info']!();
    expect(info).toMatchObject({ role: 'client', version: '0.1.0' });
    expect(Array.isArray(info.localAddresses)).toBe(true);
  });

  it('--self-check writes the report next to the logs and returns the exit code', async () => {
    const e = env();
    const out: string[] = [];
    const rep: SelfCheckReport = { role: 'client', startedAt: '2026-11-13T10:00:00.000Z', durationMs: 1, ok: false, steps: [{ stepId: 'x', title: 'X', status: 'fail', startedAt: '', durationMs: 0, message: 'm', commands: [] }] };
    const code = await runSelfCheckCli({ selfCheck: async () => rep } as unknown as Services, e.deps.paths.logDir, (t) => void out.push(t));
    expect(code).toBe(1);
    expect(readdirSync(e.deps.paths.logDir)).toContain('selfcheck-2026-11-13T10-00-00-000Z.json');
    expect(out.join('\n')).toMatch(/Self-check FAILED \(1 failed\)/);
  });
});

describe('macOS host wiring', () => {
  const status: HostSetupStatus = { lastRunAt: null, ok: false, steps: [], install: null, isAdmin: false };
  const update = { installed: '1', bundled: '2' };
  const services = (macHost: MacHostControls | null): Services => ({
    client: null,
    host: { setupStatus: async () => status, runSetup: async () => status, pendingSunshineUpdate: () => update } as never,
    controllers: null,
    macHost,
    diagnostics: { collect: async () => ({ zipPath: '', bytes: 0 }) },
    selfCheck: async () => ({}) as SelfCheckReport,
    resolvedPaths: {},
  });
  const mac = { confirmInput: async () => status, restartSunshine: async () => status };
  const none = () => undefined;

  it('builds a Mac host service on darwin and the Windows one elsewhere', () => {
    const s = buildServices(env({ role: 'host', platform: 'darwin' }));
    expect(s.host).toBeInstanceOf(MacHostService);
    expect(s.macHost).toBe(s.host);
    expect(s.resolvedPaths).toMatchObject({ role: 'host', systemRoot: null });
    const w = buildServices(env({ role: 'host', platform: 'win32' }));
    expect(w.host).not.toBeInstanceOf(MacHostService);
    expect(w.macHost).toBeNull();
  });

  it('opens only known System Settings panes, through the injected opener', async () => {
    const opened: string[] = [];
    const h = buildHandlers(env({ role: 'host', platform: 'darwin', openExternal: async (u) => void opened.push(u) }), services(mac), none, none);
    await h['host:open-settings']!({ pane: 'screen-recording' });
    expect(opened).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
    await expect(h['host:open-settings']!({ pane: 'toString' as never })).rejects.toThrow(/Unknown settings pane/);
    expect(opened).toHaveLength(1);
  });

  it('answers confirm-input, restart and the status calls with the pending Sunshine update', async () => {
    const calls: string[] = [];
    const h = buildHandlers(
      env({ role: 'host', platform: 'darwin' }),
      services({ confirmInput: async (ok) => (calls.push(`confirm ${ok}`), status), restartSunshine: async () => (calls.push('restart'), status) }),
      none,
      none,
    );
    expect(await h['host:confirm-input']!({ ok: true })).toEqual({ ...status, sunshineUpdate: update });
    expect(await h['host:sunshine-restart']!()).toEqual({ ...status, sunshineUpdate: update });
    expect(await h['host:setup-status']!()).toMatchObject({ sunshineUpdate: update });
    expect(await h['host:setup-run']!()).toMatchObject({ sunshineUpdate: update });
    expect(calls).toEqual(['confirm true', 'restart']);
  });

  it('offers no Mac-only handlers without a Mac host', () => {
    const h = buildHandlers(env({ role: 'host', platform: 'win32' }), services(null), none, none);
    expect(h['host:open-settings']).toBeUndefined();
    expect(h['host:confirm-input']).toBeUndefined();
    expect(h['host:sunshine-restart']).toBeUndefined();
  });

  it('reports whether this computer can host', async () => {
    expect(hostSupported('darwin', 'arm64', '25.1.0')).toBe(true);
    expect(hostSupported('darwin', 'arm64', '23.6.0')).toBe(true); // macOS 14
    expect(hostSupported('darwin', 'arm64', '22.6.0')).toBe(false); // macOS 13
    expect(hostSupported('darwin', 'x64', '25.1.0')).toBe(false);
    expect(hostSupported('win32', 'x64', '10.0.26100')).toBe(true);
    expect(hostSupported('linux', 'x64', '6.8.0')).toBe(false);
    const h = buildHandlers(env({ role: 'host', platform: 'darwin', roleChoice: { canChoose: true, stored: false } }), services(mac), none, none);
    expect(await h['app:info']!()).toMatchObject({ canChooseRole: true, roleStored: false, hostSupported: hostSupported(process.platform, process.arch, os.release()) });
  });

  it('switching to Client boots out both LaunchAgents on a Mac and does nothing otherwise', async () => {
    const calls: string[] = [];
    const runner = {
      run: async (r: ExecRequest): Promise<ExecResult> => (calls.push(`${r.file} ${r.args.join(' ')}`), { exitCode: 113, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false }),
    };
    const home = mkdtempSync(path.join(os.tmpdir(), 'lanplay-home-'));
    const plist = plistPath(home, SUNSHINE_MAC.launchdLabel);
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, '<plist/>');
    const base = env({ role: 'client', platform: 'darwin', home, uid: 501 });
    await releaseMacHost({ ...base, deps: { ...base.deps, runner } });
    expect(calls).toHaveLength(2);
    expect(calls.join('\n')).toContain('gui/501/dev.lanplay.sunshine');
    expect(calls.join('\n')).toContain('gui/501/dev.lanplay.agent');
    expect(existsSync(plist)).toBe(false);
    writeFileSync(plist, '<plist/>');
    calls.length = 0;
    await releaseMacHost({ ...base, role: 'host', deps: { ...base.deps, runner } });
    await releaseMacHost({ ...base, platform: 'win32', deps: { ...base.deps, runner } });
    expect(calls).toEqual([]);
    expect(existsSync(plist)).toBe(true);
  });
});

describe('createPadBackendFor', () => {
  it('a Mac host says plainly that its gamepad driver does not exist yet', () => {
    const b = createPadBackendFor('darwin', { vigemDllPath: '/x/ViGEmClient.dll' });
    expect(b.status()).toEqual({ ok: false, reason: 'driver-missing', message: MAC_PADS_UNAVAILABLE });
    expect(() => b.createPad(0)).toThrow(MAC_PADS_UNAVAILABLE);
  });
  it('Windows keeps the ViGEm backend and other systems have none', () => {
    expect(createPadBackendFor('win32', { vigemDllPath: '/nowhere/ViGEmClient.dll' }).status()).toMatchObject({ ok: false, reason: 'dll-missing' });
    expect(createPadBackendFor('linux', { vigemDllPath: '/x' }).status()).toMatchObject({ ok: false, reason: 'error' });
  });
});
