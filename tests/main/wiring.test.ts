import { describe, expect, it, vi } from 'vitest';
import { SUNSHINE_MAC } from '../../src/contracts.js';
import type { ClientService, ExecRequest, ExecResult, HostSetupStatus, InternetHostState, IpcEventChannel, IpcEventMap, SelfCheckReport, ServiceDeps, StepRecord } from '../../src/contracts.js';
import { createPadBackendFor, MAC_PADS_UNAVAILABLE } from '../../src/core/controller/backend.js';
import { plistPath } from '../../src/core/host/mac/launchd.js';
import { MacHostService } from '../../src/core/host/mac/service-mac.js';
import { MemoryLogger, resolveLogLevel } from '../../src/core/shared/logger.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { buildHandlers, buildServices, createPollWhileActive, hostSupported, releaseMacHost, runSelfCheckCli } from '../../src/main/wiring.js';
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

  it('update:check runs the injected check, and fails clearly where nothing can update', async () => {
    const s: Services = { client: null, host: null, controllers: null, macHost: null, diagnostics: { collect: async () => ({ zipPath: '', bytes: 0 }) }, selfCheck: async () => ({}) as SelfCheckReport, resolvedPaths: {} };
    const status = { state: 'up-to-date', current: '0.1.0', message: 'You have the latest version.' } as const;
    const calls: number[] = [];
    const wired = env();
    const h = buildHandlers(wired, s, () => undefined, () => undefined);
    await expect(h['update:check']!()).rejects.toThrow(/not available/);
    wired.checkForUpdates = async () => {
      calls.push(1);
      return status;
    };
    expect(await h['update:check']!()).toEqual(status);
    expect(calls).toHaveLength(1);
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

describe('internet and code-pairing channels', () => {
  const none = () => undefined;
  const HOST_ONLY = ['host:internet-get', 'host:internet-set', 'host:pending-list', 'host:pending-pair', 'host:pending-reject'] as const;
  const online: InternetHostState = { enabled: true, lanAddresses: ['192.168.1.5'], globalIpv6: [], };
  const pendingOne = [{ id: 'a'.repeat(32), name: 'Phone', address: '203.0.113.7', remote: true }];
  const hostServices = (calls: string[]): Services => ({
    client: null,
    host: {
      setupStatus: async () => ({ lastRunAt: null, ok: false, steps: [], install: null, isAdmin: false }),
      getInternet: async () => (calls.push('get'), online),
      setInternet: async (on: boolean, onProgress: (s: StepRecord) => void) => {
        calls.push(`set ${on}`);
        onProgress({ stepId: 'firewall-internet' } as StepRecord);
        await new Promise((r) => setTimeout(r, 10));
        return { ...online, enabled: on };
      },
      agent: {
        listPending: async () => (calls.push('list'), pendingOne),
        pairWithCode: async (id: string, pin: string, name: string) => (calls.push(`pair ${id.slice(0, 2)} ${pin} ${name}`), { ok: true, pending: [], devices: [] }),
        rejectPending: async (id: string) => (calls.push(`reject ${id.slice(0, 2)}`), []),
      },
    } as never,
    controllers: null,
    macHost: null,
    diagnostics: { collect: async () => ({ zipPath: '', bytes: 0 }) },
    selfCheck: async () => ({}) as SelfCheckReport,
    resolvedPaths: {},
  });
  const clientServices = (): Services => ({
    client: { recentRemote: () => ['203.0.113.7', '198.51.100.2:47989'], discovery: { start: none, stop: none, list: () => [], addManual: async () => ({}) }, getSettings: () => ({}) } as unknown as ClientService,
    host: null,
    controllers: null,
    macHost: null,
    diagnostics: { collect: async () => ({ zipPath: '', bytes: 0 }) },
    selfCheck: async () => ({}) as SelfCheckReport,
    resolvedPaths: {},
  });

  it('the host role answers the five host channels and has no client:recent-remote', async () => {
    const calls: string[] = [];
    const pushed: Array<[string, unknown]> = [];
    const h = buildHandlers(env({ role: 'host' }), hostServices(calls), ((c: IpcEventChannel, p: IpcEventMap[IpcEventChannel]) => void pushed.push([c, p])) as never, none);
    for (const c of HOST_ONLY) expect(h[c], c).toBeTypeOf('function');
    expect(h['client:recent-remote']).toBeUndefined();
    expect(await h['host:internet-get']!()).toEqual(online);
    expect(await h['host:pending-list']!()).toEqual(pendingOne);
    expect(await h['host:pending-pair']!({ id: 'b'.repeat(32), pin: '0427', name: 'Phone' })).toMatchObject({ ok: true });
    expect(await h['host:pending-reject']!({ id: 'c'.repeat(32) })).toEqual([]);
    expect(calls).toEqual(['get', 'list', 'pair bb 0427 Phone', 'reject cc']);
    expect(pushed).toEqual([]);
  });

  it('internet-set runs once at a time, streams the step records and announces the new state', async () => {
    const calls: string[] = [];
    const pushed: Array<[string, unknown]> = [];
    const h = buildHandlers(env({ role: 'host' }), hostServices(calls), ((c: IpcEventChannel, p: IpcEventMap[IpcEventChannel]) => void pushed.push([c, p])) as never, none);
    const [a, b] = await Promise.all([h['host:internet-set']!({ on: false }), h['host:internet-set']!({ on: false })]);
    expect(a).toEqual({ ...online, enabled: false });
    expect(b).toEqual(a);
    expect(calls).toEqual(['set false']);
    expect(pushed.map(([c]) => c)).toEqual(['host:setup-progress', 'host:internet-changed']);
    expect(pushed[1]![1]).toEqual({ ...online, enabled: false });
  });

  it('Set up / Repair and the internet switch never run at the same time, in either order', async () => {
    const calls: string[] = [];
    let finishSetup: () => void = () => undefined;
    const base = hostServices(calls);
    const host = {
      ...(base.host as object),
      runSetup: async () => {
        calls.push('setup start');
        await new Promise<void>((r) => (finishSetup = r));
        calls.push('setup end');
        return { lastRunAt: null, ok: true, steps: [], install: null, isAdmin: true };
      },
    };
    const h = buildHandlers(env({ role: 'host' }), { ...base, host: host as never }, none, none);

    // setup first: the switch is refused with a sentence, nothing reaches the host service
    const setup = h['host:setup-run']!();
    await expect(h['host:internet-set']!({ on: true })).rejects.toThrow(/Set up \/ Repair is still running/);
    expect(calls).toEqual(['setup start']);
    // the same action twice still shares the running promise
    expect(h['host:setup-run']!()).toBe(setup);
    finishSetup();
    await setup;
    expect(calls).toEqual(['setup start', 'setup end']);

    // internet first: Set up / Repair is refused
    const inet = h['host:internet-set']!({ on: true });
    await expect(h['host:setup-run']!()).rejects.toThrow(/The internet switch is still running/);
    expect(await inet).toMatchObject({ enabled: true });
    expect(calls).toEqual(['setup start', 'setup end', 'set true']);

    // the guard is released afterwards
    const later = h['host:setup-run']!();
    finishSetup();
    await later;
    expect(calls.at(-1)).toBe('setup end');
  });

  it('the client role answers client:recent-remote and none of the host channels', async () => {
    const h = buildHandlers(env({ role: 'client' }), clientServices(), none, none);
    expect(await h['client:recent-remote']!()).toEqual(['203.0.113.7', '198.51.100.2:47989']);
    for (const c of [...HOST_ONLY, 'host:agent-state', 'host:setup-run'] as const) expect(h[c], c).toBeUndefined();
  });
});

describe('idle timers', () => {
  it('owns no timer until a stream is active, ticks no faster than the poll, and drops the timer when it ends', () => {
    vi.useFakeTimers();
    try {
      let active = false;
      let ticks = 0;
      const poll = createPollWhileActive({ tick: () => void ticks++, pollMs: 60, isActive: () => active });
      poll.sync();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(ticks).toBe(0);
      expect(poll.running).toBe(false);

      active = true;
      poll.sync();
      poll.sync();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(600);
      expect(ticks).toBe(10);

      active = false;
      poll.sync();
      expect(vi.getTimerCount()).toBe(0);
      expect(poll.running).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(ticks).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('building the services of either role leaves no repeating timer running', () => {
    vi.useFakeTimers();
    try {
      for (const role of ['client', 'host'] as const) buildServices(env({ role, platform: 'darwin' }));
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveLogLevel', () => {
  it('logs info when packaged and debug in development; LANPLAY_LOG_LEVEL overrides both', () => {
    expect(resolveLogLevel(true, {})).toBe('info');
    expect(resolveLogLevel(false, {})).toBe('debug');
    expect(resolveLogLevel(true, { LANPLAY_LOG_LEVEL: 'debug' })).toBe('debug');
    expect(resolveLogLevel(false, { LANPLAY_LOG_LEVEL: 'WARN' })).toBe('warn');
    expect(resolveLogLevel(true, { LANPLAY_LOG_LEVEL: 'toString' })).toBe('info');
    expect(resolveLogLevel(true, { LANPLAY_LOG_LEVEL: 'loud' })).toBe('info');
  });
});
