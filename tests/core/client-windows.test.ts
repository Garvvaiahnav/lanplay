// Windows client role: role resolution, Moonlight.exe discovery, taskkill on stop, wiring. Pure (runs on any OS).
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOONLIGHT, SCM } from '../../src/contracts.js';
import type { ServiceDeps } from '../../src/contracts.js';
import { createMoonlightRunnerWith, moonlightCandidates, spawnHandle, taskkillArgs, taskkillPath } from '../../src/core/client/moonlight.js';
import { isBundledWindowsMoonlight, moonlightLogDir, platformLabel, readWindowsMoonlightVersion } from '../../src/core/client/platform.js';
import { defaultRole, readStoredRole, resolveRole, ROLE_SETTING_KEY, writeStoredRole } from '../../src/core/client/role.js';
import { MacClientService } from '../../src/core/client/service.js';
import { detectAppleChip, resolveCodec } from '../../src/core/client/settings.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { buildHandlers, buildServices, findMoonlight } from '../../src/main/wiring.js';
import type { WiringEnv } from '../../src/main/wiring.js';

describe('role resolution', () => {
  it('flag > stored > platform default; Windows can choose, macOS cannot', () => {
    expect(defaultRole('darwin')).toBe('client');
    expect(defaultRole('win32')).toBe('host');
    expect(resolveRole({ flag: null, stored: null, platform: 'win32' })).toEqual({ role: 'host', source: 'default', canChoose: true, needsChoice: true });
    expect(resolveRole({ flag: null, stored: 'client', platform: 'win32' })).toEqual({ role: 'client', source: 'stored', canChoose: true, needsChoice: false });
    expect(resolveRole({ flag: 'host', stored: 'client', platform: 'win32' })).toMatchObject({ role: 'host', source: 'flag', canChoose: true, needsChoice: false });
    expect(resolveRole({ flag: null, stored: 'garbage', platform: 'win32' })).toMatchObject({ role: 'host', source: 'default', needsChoice: true });
    expect(resolveRole({ flag: null, stored: null, platform: 'darwin' })).toEqual({ role: 'client', source: 'default', canChoose: false, needsChoice: false });
  });
  it('stores only valid roles', () => {
    const s = new MemoryStore();
    expect(readStoredRole(s)).toBeNull();
    expect(writeStoredRole(s, 'client')).toBe('client');
    expect(s.get(ROLE_SETTING_KEY, null)).toBe('client');
    expect(() => writeStoredRole(s, 'admin')).toThrow();
    expect(readStoredRole(s)).toBe('client');
  });
});

describe('Moonlight on Windows', () => {
  it('candidates: bundled, Program Files, dev vendor', () => {
    expect(moonlightCandidates('C:\\LanPlay\\resources\\vendor', null, 'win32')).toEqual([
      'C:\\LanPlay\\resources\\vendor\\moonlight-windows\\Moonlight.exe',
      'C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe',
    ]);
    const l = moonlightCandidates('C:\\r\\vendor', 'C:\\repo\\vendor', 'win32', { ProgramW6432: 'D:\\Programs' });
    expect(l).toEqual([
      'C:\\r\\vendor\\moonlight-windows\\Moonlight.exe',
      'C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe',
      'D:\\Programs\\Moonlight Game Streaming\\Moonlight.exe',
      'C:\\repo\\vendor\\moonlight-windows\\Moonlight.exe',
    ]);
  });
  it('version: pinned for the bundled exe, unknown for a Program Files install', () => {
    expect(isBundledWindowsMoonlight('C:\\x\\vendor\\Moonlight-Windows\\moonlight.exe')).toBe(true);
    expect(readWindowsMoonlightVersion('C:\\x\\vendor\\moonlight-windows\\Moonlight.exe', () => { throw new Error('no manifest'); })).toBe(MOONLIGHT.version);
    expect(readWindowsMoonlightVersion('C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe')).toBeNull();
  });
  it('log dir is %TEMP%; labels', () => {
    expect(moonlightLogDir('win32', { TEMP: 'C:\\Users\\a\\AppData\\Local\\Temp' })).toBe('C:\\Users\\a\\AppData\\Local\\Temp');
    expect(moonlightLogDir('darwin', {})).toBe('/tmp');
    expect(platformLabel('win32')).toBe('Windows PC');
  });
  it('codec Auto on a non-Apple CPU: HEVC when offered, else H.264, never AV1', () => {
    const chip = detectAppleChip('AMD Ryzen 7 5800X 8-Core Processor');
    expect(chip.av1HardwareDecode).toBe(false);
    expect(resolveCodec('auto', chip, SCM.MASK_HEVC | SCM.MASK_AV1)).toBe('hevc');
    expect(resolveCodec('auto', chip, SCM.MASK_H264)).toBe('h264');
  });
  it('taskkill argv', () => {
    expect(taskkillArgs(1234)).toEqual(['/PID', '1234', '/T', '/F']);
    expect(() => taskkillArgs(0)).toThrow();
    expect(taskkillPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  function fakeChild(opts: { exitsOnSigterm: boolean }) {
    const kills: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(sig: string) {
        kills.push(sig);
        if (opts.exitsOnSigterm || sig === 'SIGKILL') setTimeout(() => child.emit('close', 1, null), 5);
        return true;
      },
    });
    return { child, kills };
  }
  const runnerOpts = () => ({ binary: 'C:\\x\\Moonlight.exe', prefixArgs: [], runner: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false }) }, log: new MemoryLogger() });

  it('terminate on win32: SIGTERM, then taskkill /PID <pid> /T /F after the grace period', async () => {
    const { child, kills } = fakeChild({ exitsOnSigterm: false });
    const tk: Array<{ file: string; args: string[] }> = [];
    const h = spawnHandle(runnerOpts(), ['stream', '10.0.0.2', 'Desktop'], {
      platform: 'win32',
      spawnFn: (() => child) as never,
      env: { SystemRoot: 'C:\\Windows' },
      killWaitMs: 50,
      taskkill: async (file, args) => {
        tk.push({ file, args });
        child.emit('close', 1, null);
      },
    });
    await h.terminate(30);
    expect(kills).toEqual(['SIGTERM']);
    expect(tk).toEqual([{ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '4242', '/T', '/F'] }]);
    expect((await h.exited).exitCode).toBe(1);
  });
  it('terminate on win32: no taskkill when Moonlight exits within the grace period; never hangs', async () => {
    const { child } = fakeChild({ exitsOnSigterm: true });
    const tk: string[][] = [];
    const h = spawnHandle(runnerOpts(), ['stream', '10.0.0.2', 'Desktop'], { platform: 'win32', spawnFn: (() => child) as never, taskkill: async (_f, a) => void tk.push(a) });
    await h.terminate(200);
    expect(tk).toEqual([]);
    const stuck = fakeChild({ exitsOnSigterm: false });
    const h2 = spawnHandle(runnerOpts(), ['list', '10.0.0.2'], { platform: 'win32', spawnFn: (() => stuck.child) as never, killWaitMs: 20, taskkill: async () => undefined });
    const t0 = Date.now();
    await h2.terminate(20);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('runner passes the platform through to stream handles', async () => {
    const { child } = fakeChild({ exitsOnSigterm: false });
    const tk: string[][] = [];
    const r = createMoonlightRunnerWith(runnerOpts(), { platform: 'win32', spawnFn: (() => child) as never, taskkill: async (_f, a) => { tk.push(a); child.emit('close', 0, null); } });
    const h = r.startStream({ host: '10.0.0.2', settings: (await import('../../src/contracts.js')).DEFAULT_STREAM_SETTINGS, resolvedCodec: 'hevc' });
    await h.terminate(10);
    expect(tk).toEqual([['/PID', '4242', '/T', '/F']]);
  });
});

function wiringEnv(role: 'client' | 'host', platform: NodeJS.Platform, exists: (p: string) => boolean = () => false): WiringEnv {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-win-'));
  const deps: ServiceDeps = {
    log: new MemoryLogger(),
    paths: { logDir: dir, userData: dir, sharedData: dir, resources: dir, vendorDir: 'C:\\LanPlay\\resources\\vendor', psDir: dir, diagnosticsOutDir: dir, logDirFellBack: false },
    secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined, backend: () => 'dpapi' as never },
    settings: new MemoryStore(),
    runner: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false }) },
  };
  return { role, deps, appInfo: { name: 'LanPlay', version: '0.1.0', electron: '45', node: '24', chrome: '1' }, selfExe: 'C:\\LanPlay\\LanPlay.exe', selfArgsPrefix: [], isPackaged: true, appRoot: dir, loginItem: null, fileExists: exists, platform };
}

describe('wiring: Windows PC as a client', () => {
  it('finds the bundled Moonlight.exe and builds a client service', async () => {
    const bundled = 'C:\\LanPlay\\resources\\vendor\\moonlight-windows\\Moonlight.exe';
    const env = wiringEnv('client', 'win32', (p) => p === bundled);
    expect(findMoonlight(env)).toBe(bundled);
    const s = buildServices(env);
    expect(s.client).toBeTruthy();
    expect(s.host).toBeNull();
    expect(s.resolvedPaths.moonlight).toBe(bundled);
    // Windows default display mode is borderless (other windows can appear above the stream).
    expect(s.client!.getSettings().displayMode).toBe('borderless');
  });
  it('macOS keeps fullscreen as the default display mode', () => {
    const s = buildServices(wiringEnv('client', 'darwin'));
    expect(s.client!.getSettings().displayMode).toBe('fullscreen');
  });
  it('app:info reports canChooseRole / roleStored; app:role-set stores and relaunches only when the role changes', async () => {
    const env = wiringEnv('host', 'win32');
    env.roleChoice = { canChoose: true, stored: false };
    const relaunched: string[] = [];
    env.relaunch = (r) => void relaunched.push(r);
    const s = { client: null, host: {} as never, controllers: null, diagnostics: { collect: async () => ({ zipPath: 'x', bytes: 0 }) }, selfCheck: async () => ({}) as never, resolvedPaths: {} };
    const h = buildHandlers(env, s, () => undefined, () => undefined);
    expect(await h['app:info']!()).toMatchObject({ role: 'host', canChooseRole: true, roleStored: false });
    expect(await h['app:role-set']!({ role: 'host' })).toEqual({ relaunching: false });
    expect(readStoredRole(env.deps.settings)).toBe('host');
    expect(await h['app:info']!()).toMatchObject({ roleStored: true });
    expect(await h['app:role-set']!({ role: 'client' })).toEqual({ relaunching: true });
    expect(readStoredRole(env.deps.settings)).toBe('client');
    await new Promise((r) => setTimeout(r, 400));
    expect(relaunched).toEqual(['client']);
  });
  it('app:role-set is refused when the role is fixed (macOS)', async () => {
    const env = wiringEnv('client', 'darwin');
    const s = { client: buildServices(env).client, host: null, controllers: null, diagnostics: { collect: async () => ({ zipPath: 'x', bytes: 0 }) }, selfCheck: async () => ({}) as never, resolvedPaths: {} };
    const h = buildHandlers(env, s, () => undefined, () => undefined);
    await expect(h['app:role-set']!({ role: 'host' })).rejects.toThrow(/cannot be changed/);
    expect(await h['app:info']!()).toMatchObject({ canChooseRole: false });
  });
  it('Windows client: CPU model as chip label, unknown host rejected', async () => {
    const env = wiringEnv('client', 'win32');
    const svc = new MacClientService(env.deps, { moonlightBinary: null, platform: 'win32', cpuModel: 'Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz', });
    const info = await svc.systemInfo();
    expect(info.chip.model).toMatch(/Intel/);
    const pr = await svc.pair('nope', () => undefined).catch((e: Error) => e);
    expect(pr).toBeInstanceOf(Error);
  });
});
