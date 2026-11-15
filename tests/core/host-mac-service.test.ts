import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAC_HOST_STEP_ORDER, SUNSHINE_MAC } from '../../src/contracts.js';
import type { ExecRequest, ExecResult, ProcessRunner, SecretKey, SecretStore, ServiceDeps, StepRecord } from '../../src/contracts.js';
import { createMacHostService, locateBundledSunshine, MacHostService, readLogTail, teardownMacHost } from '../../src/core/host/mac/service-mac.js';
import type { MacHostServiceExtras } from '../../src/core/host/mac/service-mac.js';
import { CREDENTIALS_STAMP_KEY } from '../../src/core/host/mac/steps-mac.js';
import { sunshinePaths } from '../../src/core/host/mac/sunshine-mac.js';
import type { PlatformHostService } from '../../src/core/host/service.js';
import { certFingerprint256, createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { SUNSHINE_MAC_VERSION } from '../../src/core/host/vendor.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { BUNDLED, FakeMacHost, HOME, LOGS, PATHS, SELF_EXE, SHARED } from '../fixtures/fake-mac-host.js';
import { startMockSunshine, SUNSHINE_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

const P = sunshinePaths(SHARED, LOGS);

let mock: MockSunshine | undefined;
const services: MacHostService[] = [];
const tmp: string[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.agent.stop();
  await mock?.close();
  mock = undefined;
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

class MemorySecrets implements SecretStore {
  readonly m = new Map<string, string>();
  async get(k: SecretKey) {
    return this.m.get(k) ?? null;
  }
  async set(k: SecretKey, v: string) {
    this.m.set(k, v);
  }
  async delete(k: SecretKey) {
    this.m.delete(k);
  }
  backend(): 'file-0600' {
    return 'file-0600';
  }
}

function makeService(m: FakeMacHost, extra: Partial<MacHostServiceExtras> = {}) {
  const log = new MemoryLogger();
  const secrets = new MemorySecrets();
  const settings = new MemoryStore();
  const deps: ServiceDeps = { log, paths: PATHS, secrets, settings, runner: m };
  const svc = new MacHostService(deps, {
    selfExe: SELF_EXE,
    selfArgsPrefix: [],
    home: HOME,
    uid: 501,
    macOS: m.macOS,
    bundledApp: BUNDLED,
    agentPort: 0,
    agentExtra: { bindAddress: '127.0.0.1', udp: true, ledger: new MemoryStore() },
    localIdentity: () => ({ hostName: 'Mac-mini', addresses: ['127.0.0.1'] }),
    stepsEnv: {
      ...m.fs(),
      createSunshineClient: (o) => createSunshineClient({ ...o, baseUrl: mock!.url }),
      tcpProbe: m.tcpProbe,
      tlsPinCheck: async (_h, _p, pem) => ({ ok: pem === SUNSHINE_TEST_CERT }),
      fingerprint: certFingerprint256,
      sleep: async () => undefined,
      timing: { launchWaitMs: 0, screenWaitMs: 0, webUiWaitMs: 0, pollMs: 0 },
    },
    ...extra,
  });
  services.push(svc);
  return { svc, log, secrets, settings, m };
}

const ready = () => {
  const m = new FakeMacHost();
  m.screenPermission = true;
  return m;
};
const byId = (st: { steps: StepRecord[] }, id: string) => st.steps.find((s) => s.stepId === id)!;

describe('MacHostService: setup', () => {
  it('is a PlatformHostService', () => {
    const svc: PlatformHostService = createMacHostService({ log: new MemoryLogger(), paths: PATHS, secrets: new MemorySecrets(), settings: new MemoryStore(), runner: new FakeMacHost() }, { selfExe: SELF_EXE, selfArgsPrefix: [], home: HOME, uid: 501, macOS: { major: 26, arch: 'arm64' } });
    expect(svc.pendingSunshineUpdate).toBeTypeOf('function');
  });

  it('runs every step in order, ends ok with only mac-input left to the user, and never leaks the password', async () => {
    const m = ready();
    const s = makeService(m);
    mock = await startMockSunshine({ password: 'placeholder-replaced-below' });
    const progress: StepRecord[] = [];
    // The password is generated inside runSetup: point the mock at it as soon as the service stores it.
    const realSet = s.secrets.set.bind(s.secrets);
    s.secrets.set = async (k, v) => {
      await realSet(k, v);
      mock!.setPassword(v);
    };
    const st = await s.svc.runSetup((r) => progress.push(r));
    expect(st.steps.map((x) => x.stepId)).toEqual([...MAC_HOST_STEP_ORDER]);
    for (const r of st.steps) expect(r.status, `${r.stepId}: ${r.message}`).toBe(r.stepId === 'mac-input' ? 'warn' : 'pass');
    expect(st.ok).toBe(true);
    expect(st.isAdmin).toBe(false);
    expect(st.install).toMatchObject({ root: P.app, foundVia: 'lanplay-managed', serviceExe: '' });
    expect(progress.map((x) => x.stepId)).toEqual([...MAC_HOST_STEP_ORDER]);
    expect(byId(st, 'mac-input').data).toEqual({ settingsPane: 'accessibility', userAction: 'confirm-input' });

    const pw = (await s.secrets.get('sunshine-admin-password'))!;
    expect(pw.length).toBeGreaterThanOrEqual(32);
    expect(m.credsSet).toBe(pw);
    expect(JSON.stringify(st)).not.toContain(pw);
    expect(JSON.stringify(s.log.entries)).not.toContain(pw);
    expect(JSON.stringify(s.settings.get(CREDENTIALS_STAMP_KEY, ''))).not.toContain(pw);
    expect(s.svc.agent.getState().listening).toBe(true);

    // persisted, and nothing is pending
    expect((await s.svc.setupStatus()).lastRunAt).toBe(st.lastRunAt);
    expect(s.svc.agentAutoStart()).toEqual({ start: true });
    expect(s.svc.pendingSunshineUpdate()).toBeNull();
  });

  it('waits for the user at Screen Recording; Sunshine quit and started again by launchd turns the step green', async () => {
    const m = new FakeMacHost(); // no grant yet
    const s = makeService(m);
    mock = await startMockSunshine({ password: 'x' });
    const realSet = s.secrets.set.bind(s.secrets);
    s.secrets.set = async (k, v) => {
      await realSet(k, v);
      mock!.setPassword(v);
    };
    const st = await s.svc.runSetup(() => undefined);
    expect(st.ok).toBe(false);
    expect(byId(st, 'mac-launch-agent').status).toBe('pass');
    expect(byId(st, 'mac-screen-recording').data).toEqual({ settingsPane: 'screen-recording', userAction: 'restart-sunshine' });
    // Sunshine carries on without the grant, so its API (and pairing) already works
    expect(byId(st, 'web-ui').status).toBe('pass');
    expect(byId(st, 'api-auth').status).toBe('pass');

    // still waiting: the poll looks again but changes nothing on disk
    const before = m.changes.length;
    expect((await s.svc.setupStatus()).ok).toBe(false);
    expect(m.changes.length).toBe(before);

    m.grantScreenRecording(); // the user switched Sunshine on: nothing changes while the same Sunshine runs
    expect(byId(await s.svc.setupStatus(), 'mac-screen-recording').status).toBe('fail');
    m.quitAndReopen(); // "Quit & Reopen" in System Settings; launchd starts it again
    const after = await s.svc.setupStatus();
    for (const id of ['mac-launch-agent', 'mac-screen-recording', 'web-ui', 'api-auth']) expect(byId(after, id).status, id).toBe('pass');
    expect(after.ok).toBe(true);
    expect(after.steps.map((x) => x.stepId)).toEqual([...MAC_HOST_STEP_ORDER]);
    expect(m.files.get(P.pinnedCert)).toBe(SUNSHINE_TEST_CERT);
    // now saved: the next poll does not repeat the work
    const calls = m.calls.length;
    expect((await s.svc.setupStatus()).ok).toBe(true);
    expect(m.calls.length).toBe(calls);
  });

  it('does not touch the machine while a setup is running', async () => {
    const m = new FakeMacHost();
    const s = makeService(m);
    s.settings.set('host.lastSetup', { lastRunAt: 'x', ok: false, steps: [{ stepId: 'mac-screen-recording', title: 't', status: 'fail', startedAt: 'x', durationMs: 0, message: 'm', commands: [] }], install: null, isAdmin: false });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realRun = m.run.bind(m);
    m.run = async (req) => {
      await gate;
      return realRun(req);
    };
    const setup = s.svc.runSetup(() => undefined);
    await Promise.resolve();
    const calls = m.calls.length;
    const st = await s.svc.setupStatus();
    expect(st.steps).toHaveLength(1);
    expect(m.calls.length).toBe(calls);
    release();
    await setup;
  });

  it('runElevatedSetup is a no-op that reports "not used"', async () => {
    const s = makeService(ready());
    expect(await s.svc.runElevatedSetup()).toBe(2);
  });
});

describe('MacHostService: after setup', () => {
  async function setUp() {
    const m = ready();
    const s = makeService(m);
    mock = await startMockSunshine({ password: 'x' });
    const realSet = s.secrets.set.bind(s.secrets);
    s.secrets.set = async (k, v) => {
      await realSet(k, v);
      mock!.setPassword(v);
    };
    await s.svc.runSetup(() => undefined);
    return s;
  }

  it('"I did this" turns mac-input green and survives a restart of LanPlay', async () => {
    const s = await setUp();
    const st = await s.svc.confirmInput(true);
    expect(byId(st, 'mac-input').status).toBe('pass');
    expect(byId(st, 'mac-input').data).toBeUndefined();
    expect(st.steps.map((x) => x.stepId)).toEqual([...MAC_HOST_STEP_ORDER]);
    expect((await s.svc.setupStatus()).steps.find((x) => x.stepId === 'mac-input')!.status).toBe('pass');
    expect(byId(await s.svc.confirmInput(false), 'mac-input').status).toBe('warn');
  });

  it('confirming before any setup just remembers it', async () => {
    const s = makeService(ready());
    expect((await s.svc.confirmInput(true)).steps).toEqual([]);
    expect(s.settings.get('host.mac.inputConfirmed', false)).toBe(true);
  });

  it('selfCheck probes every step in order without changing anything', async () => {
    const s = await setUp();
    const mark = s.m.timeline.length;
    const rep = await s.svc.selfCheck();
    expect(rep.role).toBe('host');
    expect(rep.steps.map((x) => x.stepId)).toEqual([...MAC_HOST_STEP_ORDER]);
    expect(rep.ok).toBe(true);
    expect(rep.steps.find((x) => x.stepId === 'mac-input')!.status).toBe('warn');
    expect(s.m.timeline.slice(mark).filter((e) => !/^run (\/bin\/launchctl print|\/usr\/bin\/codesign|.*socketfilterfw)/.test(e))).toEqual([]);
    expect(s.log.entries.some((e) => JSON.stringify(e).includes('selfcheck:mac-bundle'))).toBe(true);
  });

  it('selfCheck fails when Sunshine is not set up', async () => {
    const s = makeService(ready());
    const rep = await s.svc.selfCheck();
    expect(rep.ok).toBe(false);
    expect(rep.steps.filter((x) => x.status === 'fail').map((x) => x.stepId)).toContain('mac-install');
  });

  it('reports a newer bundled Sunshine as pending, and "Restart Sunshine" installs it and restarts', async () => {
    const s = await setUp();
    expect(s.svc.pendingSunshineUpdate()).toBeNull();
    s.m.files.set(P.installedJson, JSON.stringify({ version: '2025.1.1.1', dmgSha256: 'old', teamId: 'F8XQ7XCN2R', copiedAt: 'x' }));
    expect(s.svc.pendingSunshineUpdate()).toEqual({ installed: '2025.1.1.1', bundled: SUNSHINE_MAC_VERSION });
    s.m.calls.length = 0;
    const st = await s.svc.restartSunshine();
    expect(s.svc.pendingSunshineUpdate()).toBeNull();
    expect(s.m.verbs()).toContain('bootout');
    expect(s.m.verbs()).toContain('bootstrap');
    expect(st.ok).toBe(true);
    expect(st.steps.map((x) => x.stepId)).toEqual([...MAC_HOST_STEP_ORDER]);
    expect(byId(st, 'mac-install').status).toBe('pass');
  });

  it('"Restart Sunshine" with nothing to update still restarts the running job', async () => {
    const s = await setUp();
    s.m.calls.length = 0;
    await s.svc.restartSunshine();
    expect(s.m.calls.filter((c) => c.args[0] === 'kickstart').map((c) => c.args[1])).toEqual(['-k']);
  });

  it('agentAutoStart waits for the first setup', () => {
    const s = makeService(ready());
    const a = s.svc.agentAutoStart();
    expect(a.start).toBe(false);
    expect(a.reason).toMatch(/Set up this Mac/);
  });
});

describe('teardownMacHost', () => {
  it('boots out both launch agents and removes their plists, keeping the Sunshine copy', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'lanplay-mac-home '));
    tmp.push(home);
    const agents = path.join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    const copy = path.join(home, 'Library', 'Application Support', 'LanPlay', 'sunshine', 'Sunshine.app');
    mkdirSync(copy, { recursive: true });
    for (const label of [SUNSHINE_MAC.launchdLabel, SUNSHINE_MAC.agentLaunchdLabel]) writeFileSync(path.join(agents, `${label}.plist`), '<plist/>');
    const loaded = new Set<string>([SUNSHINE_MAC.launchdLabel]); // the pair agent was not loaded in this login session
    const calls: ExecRequest[] = [];
    const runner: ProcessRunner = {
      async run(req: ExecRequest): Promise<ExecResult> {
        calls.push(req);
        const label = req.args[1]!.split('/')[2]!;
        const res = (stdout: string, exitCode = 0): ExecResult => ({ exitCode, signal: null, stdout, stderr: '', durationMs: 1, timedOut: false });
        if (req.args[0] === 'print') return loaded.has(label) ? res(`gui/501/${label} = {\n\tstate = running\n\tpid = 7\n}\n`) : res('', 113);
        loaded.delete(label);
        return res('');
      },
    };
    await teardownMacHost({ runner, log: new MemoryLogger(), home, uid: 501 });
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'print gui/501/dev.lanplay.sunshine',
      'bootout gui/501/dev.lanplay.sunshine',
      'print gui/501/dev.lanplay.agent',
    ]);
    expect(existsSync(path.join(agents, 'dev.lanplay.sunshine.plist'))).toBe(false);
    expect(existsSync(path.join(agents, 'dev.lanplay.agent.plist'))).toBe(false);
    expect(existsSync(copy)).toBe(true);
    // nothing to do on a Mac that never hosted
    await teardownMacHost({ runner, log: new MemoryLogger(), home, uid: 501 });
  });

  it('deletes a plist before booting its job out: in `LanPlay --agent` the bootout ends the calling process', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'lanplay-mac-home '));
    tmp.push(home);
    const agents = path.join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    for (const label of [SUNSHINE_MAC.launchdLabel, SUNSHINE_MAC.agentLaunchdLabel]) writeFileSync(path.join(agents, `${label}.plist`), '<plist/>');
    const plistAtBootout: boolean[] = [];
    const runner: ProcessRunner = {
      async run(req: ExecRequest): Promise<ExecResult> {
        const label = req.args[1]!.split('/')[2]!;
        if (req.args[0] === 'bootout') plistAtBootout.push(existsSync(path.join(agents, `${label}.plist`)));
        const stdout = req.args[0] === 'print' ? `gui/501/${label} = {\n\tstate = running\n\tpid = 7\n}\n` : '';
        return { exitCode: 0, signal: null, stdout, stderr: '', durationMs: 1, timedOut: false };
      },
    };
    await teardownMacHost({ runner, log: new MemoryLogger(), home, uid: 501 });
    expect(plistAtBootout).toEqual([false, false]);
  });
});

describe('helpers', () => {
  it('finds the bundled Sunshine in a packaged app, and in a development checkout', () => {
    const packaged = new Set(['/Applications/LanPlay.app/Contents/Resources/vendor/Sunshine.app']);
    expect(locateBundledSunshine('/Applications/LanPlay.app/Contents/Resources', (p) => packaged.has(p))).toBe('/Applications/LanPlay.app/Contents/Resources/vendor/Sunshine.app');
    const dev = new Set(['/repo/vendor/sunshine-macos-arm64/Sunshine.app']);
    expect(locateBundledSunshine('/repo', (p) => dev.has(p))).toBe('/repo/vendor/sunshine-macos-arm64/Sunshine.app');
    expect(locateBundledSunshine('/nowhere', () => false)).toBe('/nowhere/vendor/Sunshine.app');
  });

  it('reads the tail of a log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-log '));
    tmp.push(dir);
    const f = path.join(dir, 'sunshine.log');
    expect(readLogTail(f)).toBeNull();
    writeFileSync(f, 'old line\nnew line\n');
    expect(readLogTail(f)).toBe('old line\nnew line\n');
    expect(readLogTail(f, 9)).toBe('new line\n');
  });
});
