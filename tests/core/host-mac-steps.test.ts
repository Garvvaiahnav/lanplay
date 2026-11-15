import { afterEach, describe, expect, it } from 'vitest';
import { LANPLAY, MAC_HOST_STEP_ORDER, SUNSHINE_MAC } from '../../src/contracts.js';
import type { HostStepContext, StepRecord } from '../../src/contracts.js';
import { buildAgentPlist, lanplayAgentSpec } from '../../src/core/host/mac/launchd.js';
import { parseFirewallState, macosMajorFromDarwin, screenRecordingDenied, settingsUrl } from '../../src/core/host/mac/permissions-mac.js';
import { sunshineAgentSpec, sunshinePaths } from '../../src/core/host/mac/sunshine-mac.js';
import { createMacHostSteps, CREDENTIALS_STAMP_KEY, INPUT_CONFIRMED_KEY } from '../../src/core/host/mac/steps-mac.js';
import type { MacStepsEnv } from '../../src/core/host/mac/steps-mac.js';
import { STEP_TITLES } from '../../src/core/host/steps.js';
import { certFingerprint256, createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { SUNSHINE_MAC_VERSION } from '../../src/core/host/vendor.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { REDACTED } from '../../src/core/shared/redact.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { AGENT_PLIST, BUNDLED, DENIED_LOG, FakeMacHost, HOME, LOGS, PATHS, SELF_EXE, SHARED, SUNSHINE_APP, SUNSHINE_BIN, SUNSHINE_LOG, SUNSHINE_PLIST } from '../fixtures/fake-mac-host.js';
import { startMockSunshine, SUNSHINE_TEST_CERT, WRONG_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

const PW = 'Q2h4bGxvd2VkLXRlc3QtcGFzc3dvcmQtMTIzNDU2Nzg';
const P = sunshinePaths(SHARED, LOGS);

let mock: MockSunshine | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function setup(over: Partial<MacStepsEnv> = {}, opts: { restart?: boolean } = {}, m = new FakeMacHost()) {
  const log = new MemoryLogger();
  const settings = new MemoryStore();
  const env: MacStepsEnv = {
    ...m.fs(),
    home: HOME,
    uid: 501,
    selfExe: SELF_EXE,
    selfArgsPrefix: [],
    bundledApp: BUNDLED,
    macOS: m.macOS,
    settings,
    getPassword: async () => PW,
    createSunshineClient: (o) => createSunshineClient({ ...o, baseUrl: mock!.url }),
    tcpProbe: m.tcpProbe,
    tlsPinCheck: async (_h, _p, pem) => (pem === SUNSHINE_TEST_CERT ? { ok: true } : { ok: false, error: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    fingerprint: certFingerprint256,
    agentProbe: async () => ({ http: true, udp: true, detail: 'ok' }),
    now: Date.now,
    sleep: async () => undefined,
    timing: { launchWaitMs: 0, screenWaitMs: 0, webUiWaitMs: 0, pollMs: 0 },
    ...over,
  };
  const ctx: HostStepContext = {
    runner: m,
    log,
    paths: PATHS,
    bundledMsiPath: '',
    psDir: '',
    systemRoot: '',
    secrets: { get: async () => PW, set: async () => undefined, delete: async () => undefined, backend: () => 'keychain' },
    install: null,
    isAdmin: false,
  };
  return { m, log, env, ctx, settings, steps: createMacHostSteps(env, opts) };
}
type Setup = ReturnType<typeof setup>;

const byId = (s: Setup, id: string) => s.steps.find((x) => x.id === id)!;
const rec = (rs: StepRecord[]) => Object.fromEntries(rs.map((r) => [r.stepId, r])) as Record<string, StepRecord>;

async function applyAll(s: Setup): Promise<Record<string, StepRecord>> {
  const out: StepRecord[] = [];
  for (const id of MAC_HOST_STEP_ORDER) out.push(await byId(s, id).apply(s.ctx));
  return rec(out);
}
async function probeAll(s: Setup): Promise<Record<string, StepRecord>> {
  const out: StepRecord[] = [];
  for (const id of MAC_HOST_STEP_ORDER) out.push(await byId(s, id).probe(s.ctx));
  return rec(out);
}
const readyMachine = () => {
  const m = new FakeMacHost();
  m.screenPermission = true;
  return m;
};

describe('permissions-mac', () => {
  it('maps panes to fixed System Settings links and rejects anything else', () => {
    expect(settingsUrl('screen-recording')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    expect(settingsUrl('accessibility')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    expect(settingsUrl('login-items')).toBe('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
    expect(settingsUrl('firewall')).toBe('x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall');
    for (const bad of ['https://evil.example', 'screen-recording ', '', 'toString', '__proto__', 7, null, undefined]) expect(settingsUrl(bad)).toBeNull();
  });

  it('spots the missing Screen Recording grant in Sunshine\'s log', () => {
    expect(screenRecordingDenied(DENIED_LOG)).toBe(true);
    expect(screenRecordingDenied('[x]: Info: Configuration UI available at [https://localhost:47990]\n')).toBe(false);
    expect(screenRecordingDenied('')).toBe(false);
    expect(DENIED_LOG).toContain(SUNSHINE_MAC.noScreenPermissionLog);
  });

  it('reads socketfilterfw --getglobalstate', () => {
    expect(parseFirewallState('Firewall is disabled. (State = 0)\n')).toBe('off');
    expect(parseFirewallState('Firewall is enabled. (State = 1)\n')).toBe('on');
    expect(parseFirewallState('Firewall is blocking all non-essential incoming connections. (State = 2)\n')).toBe('block-all');
    expect(parseFirewallState('usage: socketfilterfw')).toBe('unknown');
  });

  it('turns a Darwin kernel release into the macOS major version', () => {
    expect(macosMajorFromDarwin('23.6.0')).toBe(14);
    expect(macosMajorFromDarwin('24.1.0')).toBe(15);
    expect(macosMajorFromDarwin('25.4.0')).toBe(26);
    expect(macosMajorFromDarwin('garbage')).toBeNull();
  });

  it('creates one step per id, in setup order', () => {
    expect(setup().steps.map((x) => x.id)).toEqual([...MAC_HOST_STEP_ORDER]);
  });

  it('every mac step id has a title', () => {
    for (const id of MAC_HOST_STEP_ORDER) expect(STEP_TITLES[id], id).toMatch(/\S/);
  });
});

describe('mac host steps: first setup on a clean Mac', () => {
  it('copies, configures, sets creds, starts the job and pins the cert; only mac-input needs the user', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    const r = await applyAll(s);
    for (const id of MAC_HOST_STEP_ORDER) expect(r[id]?.status, `${id}: ${r[id]?.message}`).toBe(id === 'mac-input' ? 'warn' : 'pass');
    expect(s.ctx.install).toMatchObject({ root: P.app, exe: P.binary, serviceExe: '', configFile: P.conf, certFile: P.cert, foundVia: 'lanplay-managed', version: SUNSHINE_MAC_VERSION });

    // private copy, signed and recorded
    expect(JSON.parse(s.m.files.get(P.installedJson)!)).toMatchObject({ version: SUNSHINE_MAC_VERSION, teamId: 'F8XQ7XCN2R' });
    expect(s.m.files.get(P.binary)).toBe('MACHO');
    // plists carry exactly the T3 specs
    expect(s.m.files.get(SUNSHINE_PLIST)).toBe(buildAgentPlist(sunshineAgentSpec(P)));
    expect(s.m.files.get(AGENT_PLIST)).toBe(buildAgentPlist(lanplayAgentSpec(SELF_EXE)));
    expect(s.m.files.get(P.conf)).toContain(`pkey = ${P.pkey}`);
    expect(s.m.files.get(P.conf)).toContain('system_tray = disabled');
    // cert pinned
    expect(s.m.files.get(P.pinnedCert)).toBe(SUNSHINE_TEST_CERT);

    // The launchd agent for the pair agent is only written: loading it now would start a second LanPlay.
    const bootstrapped = s.m.calls.filter((c) => c.args[0] === 'bootstrap').map((c) => c.args[2]);
    expect(bootstrapped).toEqual([SUNSHINE_PLIST]);

    // argv only: absolute files, no shell
    for (const c of s.m.calls) expect(c.file.startsWith('/'), c.file).toBe(true);
    expect(s.m.calls.every((c) => c.file !== '/bin/sh' && c.file !== '/bin/zsh' && c.file !== '/bin/bash')).toBe(true);
  });

  it('never lets the admin password reach a record, a step\'s data or the log', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    const r = await applyAll(s);
    const creds = s.m.calls.find((c) => c.file === SUNSHINE_BIN)!;
    expect(creds.args).toEqual([P.conf, '--creds', LANPLAY.sunshineAdminUser, PW]);
    expect(creds.secrets).toEqual([PW]);
    expect(r.credentials!.commands[0]!.argv).toEqual([P.conf, '--creds', LANPLAY.sunshineAdminUser, REDACTED]);
    expect(JSON.stringify(r)).not.toContain(PW);
    expect(JSON.stringify(s.log.entries)).not.toContain(PW);
    expect(JSON.stringify(s.settings.get(CREDENTIALS_STAMP_KEY, ''))).not.toContain(PW);
  });

  it('copies into a fresh staging folder (ditto onto an app merges), and swaps it in only after it verified', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = readyMachine();
    m.seedOldCopy('2025.1.1.1');
    m.loaded = true;
    m.pid = 99;
    m.dirs.add(P.staging); // left by an interrupted earlier copy
    m.files.set(`${P.staging}/Contents/leftover`, 'X');
    const s = setup({}, {}, m);
    const r = await byId(s, 'mac-install').apply(s.ctx);
    expect(r.status, r.message).toBe('pass');
    const t = m.timeline;
    const at = (re: RegExp) => t.findIndex((e) => re.test(e));
    const clean = t.indexOf(`remove ${SHARED}/sunshine/staging`);
    const ditto = at(/^run \/usr\/bin\/ditto /);
    const verify = t.findIndex((e, i) => i > ditto && e === `run /usr/bin/codesign --verify --deep --strict ${P.staging}`);
    const bootout = at(/^run \/bin\/launchctl bootout gui\/501\/dev\.lanplay\.sunshine/);
    const remove = t.indexOf(`remove ${SUNSHINE_APP}`);
    const swap = t.indexOf(`rename ${P.staging} -> ${SUNSHINE_APP}`);
    expect(t[ditto]).toBe(`run /usr/bin/ditto ${BUNDLED} ${P.staging}`);
    expect(clean).toBeGreaterThanOrEqual(0);
    expect([clean, ditto, verify, bootout, remove, swap]).toEqual([...[clean, ditto, verify, bootout, remove, swap]].sort((a, b) => a - b));
    expect(Math.min(clean, ditto, verify, bootout, remove, swap)).toBeGreaterThanOrEqual(0);
    expect(m.files.has(`${SUNSHINE_APP}/Contents/Frameworks/removed-in-new-version.dylib`)).toBe(false);
    expect(m.files.has(`${SUNSHINE_APP}/Contents/leftover`)).toBe(false);
    expect(m.files.get(SUNSHINE_BIN)).toBe('MACHO');
    expect(m.exists(P.staging)).toBe(false);
    expect(JSON.parse(m.files.get(P.installedJson)!).version).toBe(SUNSHINE_MAC_VERSION);
  });

  it('a failed copy leaves the old copy installed and running', async () => {
    const m = readyMachine();
    m.seedOldCopy('2025.1.1.1');
    m.loaded = true;
    m.pid = 99;
    m.dittoFails = true;
    const s = setup({}, {}, m);
    const r = await byId(s, 'mac-install').apply(s.ctx);
    expect(r.status).toBe('fail');
    expect(m.files.get(SUNSHINE_BIN)).toBe('OLD-MACHO');
    expect(m.pid).toBe(99);
    expect(m.verbs()).not.toContain('bootout');
    expect(m.exists(P.staging)).toBe(false);
  });

  it('keeps a working copy when the bundled Sunshine fails its checks', async () => {
    const m = readyMachine();
    m.seedOldCopy('2025.1.1.1');
    m.teams.set(BUNDLED, 'ATTACKER123');
    const s = setup({}, {}, m);
    expect((await byId(s, 'mac-bundle').apply(s.ctx)).message).toMatch(/team ATTACKER123, expected F8XQ7XCN2R/);
    const r = await byId(s, 'mac-install').apply(s.ctx);
    expect(r.status).toBe('fail');
    expect(m.timeline.some((e) => e.startsWith('remove') || e.includes('ditto'))).toBe(false);
    expect(m.files.get(SUNSHINE_BIN)).toBe('OLD-MACHO');
  });

  it('refuses a copy whose signature does not verify, keeping the old copy', async () => {
    const m = readyMachine();
    m.seedOldCopy('2025.1.1.1');
    const s = setup({}, {}, m);
    m.brokenSeal.add(P.staging);
    const r = await byId(s, 'mac-install').apply(s.ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/signature/i);
    expect(m.files.get(SUNSHINE_BIN)).toBe('OLD-MACHO');
    expect(m.exists(P.staging)).toBe(false);
  });

  it('mac-bundle fails on macOS older than 14, on Intel, on a missing app and on a different version', async () => {
    const old = setup({ macOS: { major: 13, arch: 'arm64' } }, {}, readyMachine());
    expect((await byId(old, 'mac-bundle').probe(old.ctx)).message).toMatch(/macOS 14/);
    const intel = setup({ macOS: { major: 26, arch: 'x64' } }, {}, readyMachine());
    expect((await byId(intel, 'mac-bundle').probe(intel.ctx)).message).toMatch(/Apple Silicon/);
    const gone = readyMachine();
    gone.files.delete(`${BUNDLED}/Contents/MacOS/Sunshine`);
    const g = setup({}, {}, gone);
    expect((await byId(g, 'mac-bundle').probe(g.ctx)).status).toBe('fail');
    const other = readyMachine();
    other.files.set(`${BUNDLED}/Contents/Info.plist`, other.files.get(`${BUNDLED}/Contents/Info.plist`)!.replace(SUNSHINE_MAC_VERSION, '2000.1.1'));
    const o = setup({}, {}, other);
    expect((await byId(o, 'mac-bundle').probe(o.ctx)).message).toMatch(/2000\.1\.1/);
  });
});

describe('mac host steps: probe never mutates, apply is idempotent', () => {
  it('probes on a clean Mac change nothing and report what is missing', async () => {
    const s = setup({}, {}, readyMachine());
    const r = await probeAll(s);
    expect(s.m.changes).toEqual([]);
    expect(s.m.calls.every((c) => c.file === '/usr/bin/codesign' || (c.file === '/bin/launchctl' && c.args[0] === 'print') || c.file.endsWith('socketfilterfw'))).toBe(true);
    expect(s.settings.get(CREDENTIALS_STAMP_KEY, 'unset')).toBe('unset');
    expect(r['mac-bundle']!.status).toBe('pass');
    for (const id of ['mac-install', 'config', 'mac-launch-agent', 'mac-screen-recording', 'web-ui', 'agent-autostart']) expect(r[id]!.status, id).toBe('fail');
  });

  it('a second apply writes nothing and only runs `launchctl print`', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    await applyAll(s);
    const mark = s.m.timeline.length;
    const callMark = s.m.calls.length;
    const again = await applyAll(s);
    for (const id of MAC_HOST_STEP_ORDER) expect(again[id]?.status, `${id}: ${again[id]?.message}`).toBe(id === 'mac-input' ? 'warn' : 'pass');
    expect(s.m.timeline.slice(mark).filter((e) => !/^run (\/bin\/launchctl print|\/usr\/bin\/codesign|.*socketfilterfw)/.test(e))).toEqual([]);
    const verbs = s.m.calls.slice(callMark).filter((c) => c.file === '/bin/launchctl').map((c) => c.args[0]);
    expect(new Set(verbs)).toEqual(new Set(['print']));
  });

  it('after an apply every probe agrees (and still changes nothing)', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    await applyAll(s);
    const mark = s.m.timeline.length;
    const r = await probeAll(s);
    for (const id of MAC_HOST_STEP_ORDER) expect(r[id]?.status, `${id}: ${r[id]?.message}`).toBe(id === 'mac-input' ? 'warn' : 'pass');
    expect(s.m.timeline.slice(mark).filter((e) => !/^run (\/bin\/launchctl print|\/usr\/bin\/codesign|.*socketfilterfw)/.test(e))).toEqual([]);
  });
});

describe('mac host steps: restarts only when something changed', () => {
  it('kickstarts -k after a config or credentials change, not otherwise', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    await applyAll(s);
    s.m.calls.length = 0;
    s.m.files.set(P.conf, 'upnp = enabled\n'); // somebody edited the config
    await byId(s, 'config').apply(s.ctx);
    await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(s.m.calls.filter((c) => c.args[0] === 'kickstart').map((c) => c.args)).toEqual([['kickstart', '-k', 'gui/501/dev.lanplay.sunshine']]);
  });

  it('a changed password re-runs --creds and restarts Sunshine so it reads them', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    await applyAll(s);
    const pw2 = PW + 'x';
    s.env.getPassword = async () => pw2;
    s.m.calls.length = 0;
    expect((await byId(s, 'credentials').apply(s.ctx)).status).toBe('pass');
    expect(s.m.credsSet).toBe(pw2);
    await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(s.m.verbs()).toEqual(['print', 'kickstart', 'print']);
  });

  it('"Restart Sunshine" restarts even though nothing changed', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = readyMachine();
    await applyAll(setup({}, {}, m));
    const s = setup({}, { restart: true }, m);
    s.m.calls.length = 0;
    const r = await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(r.status, r.message).toBe('pass');
    expect(s.m.calls.filter((c) => c.args[0] === 'kickstart').map((c) => c.args[1])).toEqual(['-k']);
  });

  it('a rewritten plist needs bootout + bootstrap: launchd keeps the definition it loaded', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    await applyAll(s);
    s.m.files.set(SUNSHINE_PLIST, '<plist>stale</plist>');
    s.m.calls.length = 0;
    await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(s.m.verbs()).toEqual(['print', 'bootout', 'bootstrap', 'print']);
    expect(s.m.loadedDefinition).toBe(buildAgentPlist(sunshineAgentSpec(P)));
  });

  it('starts a job that exited instead of waiting for launchd\'s throttle', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = readyMachine();
    const s = setup({}, {}, m);
    await applyAll(s);
    m.pid = null;
    m.lastExit = 1;
    m.calls.length = 0;
    await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(m.calls.filter((c) => c.args[0] === 'kickstart').map((c) => c.args)).toEqual([['kickstart', 'gui/501/dev.lanplay.sunshine']]);
  });
});

describe('mac host steps: launch agent', () => {
  it('refuses to start next to a Sunshine it did not start, and touches nothing', async () => {
    const m = readyMachine();
    m.foreignListener = true;
    const s = setup({}, {}, m);
    await byId(s, 'mac-install').apply(s.ctx);
    const before = m.timeline.length;
    const r = await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toBe('Another Sunshine is running on this Mac. Quit it, then press Set up again.');
    expect(m.timeline.slice(before).filter((e) => !e.startsWith('run /bin/launchctl print'))).toEqual([]);
    expect(m.verbs()).not.toContain('bootstrap');
    expect((await byId(s, 'mac-launch-agent').probe(s.ctx)).message).toMatch(/Another Sunshine/);
  });

  it('does not call its own running Sunshine foreign', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = readyMachine();
    const s = setup({}, {}, m);
    await applyAll(s);
    m.foreignListener = true; // the port is open, but launchd's job owns a pid
    expect((await byId(s, 'mac-launch-agent').apply(s.ctx)).status).toBe('pass');
  });

  it('blocks when Sunshine is not installed yet', async () => {
    const s = setup({}, {}, readyMachine());
    const r = await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/Blocked/);
    expect(s.m.changes).toEqual([]);
  });

  it('points at Login Items when launchctl bootstrap fails', async () => {
    const m = readyMachine();
    const s = setup({}, {}, m);
    await byId(s, 'mac-install').apply(s.ctx);
    const realRun = m.run.bind(m);
    m.run = async (req) => (req.args[0] === 'bootstrap' ? { exitCode: 5, signal: null, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error', durationMs: 1, timedOut: false } : realRun(req));
    const r = await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/Input\/output error/);
    expect(r.data).toMatchObject({ settingsPane: 'login-items' });
  });

  it('counts a Sunshine without the Screen Recording grant as running (it carries on), leaving the diagnosis to the next step', async () => {
    const s = setup({}, {}, new FakeMacHost());
    await byId(s, 'mac-install').apply(s.ctx);
    const r = await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(r.status, r.message).toBe('pass');
    expect(r.message).toMatch(/running/);
  });

  it('fails with the launchd state when Sunshine neither runs nor says why', async () => {
    const m = readyMachine();
    const s = setup({}, {}, m);
    await byId(s, 'mac-install').apply(s.ctx);
    const realRun = m.run.bind(m);
    m.run = async (req) => {
      const r = await realRun(req);
      if (req.args[0] === 'bootstrap' || req.args[0] === 'kickstart') {
        m.pid = null;
        m.lastExit = 78;
        m.files.set(SUNSHINE_LOG, 'garbage\n');
      }
      return r;
    };
    const r = await byId(s, 'mac-launch-agent').apply(s.ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/last exit code: 78/);
  });
});

describe('mac host steps: Screen Recording', () => {
  const DENIED_DATA = { settingsPane: 'screen-recording', userAction: 'restart-sunshine' };

  async function upToScreen(m: FakeMacHost, opts: { restart?: boolean } = {}) {
    const s = setup({}, opts, m);
    for (const id of ['mac-install', 'config', 'credentials', 'mac-launch-agent']) await byId(s, id).apply(s.ctx);
    return s;
  }

  it('fails with the settings pane and a restart action although the web UI answers (Sunshine carries on without the grant)', async () => {
    const m = new FakeMacHost();
    const s = await upToScreen(m);
    expect(m.listening).toBe(true);
    const denied = await byId(s, 'mac-screen-recording').apply(s.ctx);
    expect(denied.status).toBe('fail');
    expect(denied.data).toEqual(DENIED_DATA);
    expect(denied.message).toMatch(/Restart Sunshine/);
    expect((await byId(s, 'mac-screen-recording').probe(s.ctx)).data).toEqual(DENIED_DATA);
  });

  it('a grant alone changes nothing until Sunshine starts again', async () => {
    const m = new FakeMacHost();
    const s = await upToScreen(m);
    m.grantScreenRecording();
    expect((await byId(s, 'mac-screen-recording').probe(s.ctx)).status).toBe('fail');
    m.quitAndReopen(); // System Settings' "Quit & Reopen"; launchd starts it again
    expect((await byId(s, 'mac-screen-recording').probe(s.ctx)).status).toBe('pass');
  });

  it('"Restart Sunshine" after the grant passes', async () => {
    const m = new FakeMacHost();
    await upToScreen(m);
    m.grantScreenRecording();
    const s = await upToScreen(m, { restart: true });
    expect(m.verbs()).toContain('kickstart');
    expect((await byId(s, 'mac-screen-recording').apply(s.ctx)).status).toBe('pass');
  });

  it('a denial from an earlier start does not count once Sunshine started again', async () => {
    const m = readyMachine();
    m.writeLog(DENIED_LOG);
    m.born.set(SUNSHINE_LOG, 0); // written long before this run
    const s = await upToScreen(m, { restart: true });
    expect((await byId(s, 'mac-screen-recording').apply(s.ctx)).status).toBe('pass');
  });

  it('right after a restart, ignores the previous start\'s log until Sunshine opens its new one', async () => {
    const m = new FakeMacHost();
    m.screenPermission = true;
    const s = setup({}, {}, m);
    for (const id of ['mac-install', 'config', 'credentials']) await byId(s, id).apply(s.ctx);
    const realRun = m.run.bind(m);
    m.run = async (req) => {
      const r = await realRun(req);
      if (req.args[0] === 'bootstrap') {
        // still starting: no web UI yet, and the file on disk is the previous start's (created before this run)
        m.pid = null;
        m.writeLog(DENIED_LOG);
        m.born.set(SUNSHINE_LOG, 0);
      }
      return r;
    };
    await byId(s, 'mac-launch-agent').apply(s.ctx);
    const r = await byId(s, 'mac-screen-recording').apply(s.ctx);
    expect(r.data?.settingsPane).toBeUndefined();
    expect(r.message).toMatch(/not answering/i);
  });
});

describe('mac host steps: web UI and API', () => {
  it('web-ui fails with a re-pin hint when the served certificate changed', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = readyMachine();
    const s = setup({}, {}, m);
    await applyAll(s);
    m.files.set(P.pinnedCert, WRONG_TEST_CERT);
    const r = await byId(s, 'web-ui').probe(s.ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/does not match/);
    m.files.set(P.pinnedCert, 'not a certificate');
    expect((await byId(s, 'web-ui').probe(s.ctx)).message).toMatch(/unreadable/);
    expect((await byId(s, 'web-ui').apply(s.ctx)).status).toBe('pass');
    expect(m.files.get(P.pinnedCert)).toBe(SUNSHINE_TEST_CERT);
  });

  it('api-auth tells the user when Sunshine rejects LanPlay\'s password, and forgets that it set it', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    await applyAll(s);
    mock.setPassword('somebody-changed-it-in-the-web-ui');
    const r = await byId(s, 'api-auth').apply(s.ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/rejected/);
    // the next setup must write the credentials again
    expect(s.settings.get(CREDENTIALS_STAMP_KEY, 'x')).toBe('');
    s.m.calls.length = 0;
    await byId(s, 'credentials').apply(s.ctx);
    expect(s.m.calls.some((c) => c.file === SUNSHINE_BIN)).toBe(true);
  });

  it('api-auth probe leaves that record alone', async () => {
    mock = await startMockSunshine({ password: PW });
    const s = setup({}, {}, readyMachine());
    await applyAll(s);
    const stamp = s.settings.get(CREDENTIALS_STAMP_KEY, '');
    expect(stamp).not.toBe('');
    mock.setPassword('other');
    expect((await byId(s, 'api-auth').probe(s.ctx)).status).toBe('fail');
    expect(s.settings.get(CREDENTIALS_STAMP_KEY, '')).toBe(stamp);
  });
});

describe('mac host steps: things only the user can do', () => {
  it('mac-input warns with the Accessibility pane and an "I did this" action until confirmed', async () => {
    const s = setup({}, {}, readyMachine());
    const r = await byId(s, 'mac-input').probe(s.ctx);
    expect(r.status).toBe('warn');
    expect(r.data).toEqual({ settingsPane: 'accessibility', userAction: 'confirm-input' });
    expect(r.message).toContain(P.app);
    expect(s.m.changes).toEqual([]);
    s.settings.set(INPUT_CONFIRMED_KEY, true);
    const done = await byId(s, 'mac-input').apply(s.ctx);
    expect(done.status).toBe('pass');
    expect(done.data).toBeUndefined();
  });

  it('mac-audio is information, with no button (a button would keep the screen polling)', async () => {
    const s = setup({}, {}, readyMachine());
    const r = await byId(s, 'mac-audio').apply(s.ctx);
    expect(r.status).toBe('pass');
    expect(r.data).toBeUndefined();
    expect(r.message).toMatch(/audio/i);
  });

  it.each([
    ['off', 'pass', undefined],
    ['on', 'warn', { settingsPane: 'firewall' }],
    ['block-all', 'warn', { settingsPane: 'firewall' }],
  ] as const)('mac-network with the firewall %s', async (state, status, data) => {
    const m = readyMachine();
    m.firewall = state;
    const s = setup({}, {}, m);
    const r = await byId(s, 'mac-network').probe(s.ctx);
    expect(r.status).toBe(status);
    expect(r.data).toEqual(data);
    expect(m.calls.map((c) => [c.file, c.args])).toEqual([['/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']]]);
  });

  it('mac-network skips when the firewall tool cannot be read', async () => {
    const m = readyMachine();
    m.run = async () => ({ exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, spawnError: 'ENOENT' });
    const s = setup({}, {}, m);
    expect((await byId(s, 'mac-network').probe(s.ctx)).status).toBe('skip');
  });
});

describe('mac host steps: pair agent', () => {
  it('writes the login launch agent without loading it, and notices when LanPlay moved', async () => {
    const m = readyMachine();
    const s = setup({}, {}, m);
    expect((await byId(s, 'agent-autostart').probe(s.ctx)).status).toBe('fail');
    const r = await byId(s, 'agent-autostart').apply(s.ctx);
    expect(r.status, r.message).toBe('pass');
    expect(m.files.get(AGENT_PLIST)).toBe(buildAgentPlist(lanplayAgentSpec(SELF_EXE)));
    expect(m.calls).toEqual([]);
    expect((await byId(s, 'agent-autostart').probe(s.ctx)).status).toBe('pass');

    const moved = setup({ selfExe: '/Users/me/Downloads/LanPlay.app/Contents/MacOS/LanPlay' }, {}, m);
    const p = await byId(moved, 'agent-autostart').probe(moved.ctx);
    expect(p.status).toBe('fail');
    expect(p.message).toMatch(/moved/);
  });

  it('in a development run the launch agent starts electron with the app path', async () => {
    const m = readyMachine();
    const s = setup({ selfExe: '/repo/node_modules/electron/dist/Electron', selfArgsPrefix: ['/repo'] }, {}, m);
    await byId(s, 'agent-autostart').apply(s.ctx);
    expect(m.files.get(AGENT_PLIST)).toBe(buildAgentPlist({ ...lanplayAgentSpec('/repo/node_modules/electron/dist/Electron'), args: ['/repo', '--agent'] }));
  });

  it('agent-listening reports the agent probe', async () => {
    const probe = (http: boolean, udp: boolean) => async () => ({ http, udp, detail: 'd' });
    for (const [http, udp, status] of [[true, true, 'pass'], [true, false, 'warn'], [false, false, 'fail']] as const) {
      const s = setup({ agentProbe: probe(http, udp) }, {}, readyMachine());
      expect((await byId(s, 'agent-listening').probe(s.ctx)).status).toBe(status);
    }
    const none = setup({ agentProbe: null }, {}, readyMachine());
    expect((await byId(none, 'agent-listening').probe(none.ctx)).status).toBe('skip');
  });
});
