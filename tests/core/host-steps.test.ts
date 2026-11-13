import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_STEP_ORDER, LANPLAY, SUNSHINE_MANAGED_CONFIG } from '../../src/contracts.js';
import type { AppPaths, HostStepContext, StepRecord } from '../../src/contracts.js';
import { compareVersions, createHostSteps, ELEVATED_STEP_IDS, evaluateAgentFirewall } from '../../src/core/host/steps.js';
import type { HostStepsEnv } from '../../src/core/host/steps.js';
import { certFingerprint256, createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { SUNSHINE_MSI_SHA256 } from '../../src/core/host/vendor.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { REDACTED } from '../../src/core/shared/redact.js';
import { FakeWindowsRunner, freshMachine, installSunshineFiles } from '../fixtures/fake-windows.js';
import type { FakeMachineState } from '../fixtures/fake-windows.js';
import { startMockSunshine, SUNSHINE_TEST_CERT, WRONG_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

const w = path.win32;
const PW = 'Q2h4bGxvd2VkLXRlc3QtcGFzc3dvcmQtMTIzNDU2Nzg';
const PATHS: AppPaths = {
  logDir: 'C:\\ProgramData\\LanPlay\\logs',
  userData: 'C:\\Users\\Jörg Müller\\AppData\\Roaming\\LanPlay',
  sharedData: 'C:\\ProgramData\\LanPlay',
  resources: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay-win32-x64\\resources',
  vendorDir: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay-win32-x64\\resources\\vendor',
  psDir: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay-win32-x64\\resources\\ps',
  diagnosticsOutDir: 'C:\\Users\\Jörg Müller\\Desktop',
  logDirFellBack: false,
};
const MSI = w.join(PATHS.vendorDir, 'Sunshine-Windows-AMD64-installer.msi');

let mock: MockSunshine | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function setup(m: FakeMachineState, over: Partial<HostStepsEnv> = {}) {
  const runner = new FakeWindowsRunner(m, SUNSHINE_TEST_CERT);
  const log = new MemoryLogger();
  m.files.set(MSI, 'msi-bytes');
  const env: HostStepsEnv = {
    fileExists: (p) => m.files.has(p),
    readText: (p) => m.files.get(p) ?? null,
    writeText: (p, t) => void m.files.set(p, t),
    copyFile: (a, b) => void m.files.set(b, m.files.get(a)!),
    sha256File: async () => SUNSHINE_MSI_SHA256,
    getPassword: async () => PW,
    createSunshineClient: (o) => createSunshineClient({ ...o, baseUrl: mock!.url }),
    tcpProbe: async () => m.service?.state === 'Running',
    tlsPinCheck: async (_h, _p, pem) => (pem === SUNSHINE_TEST_CERT ? { ok: true } : { ok: false, error: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    fingerprint: certFingerprint256,
    pinnedCertPath: 'C:\\ProgramData\\LanPlay\\sunshine-cert.pem',
    selfExe: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay-win32-x64\\LanPlay.exe',
    loginItem: null,
    agentProbe: null,
    now: Date.now,
    sleep: async () => undefined,
    timing: { serviceWaitMs: 0, webUiWaitMs: 0, pollMs: 0 },
    ...over,
  };
  const ctx: HostStepContext = {
    runner,
    log,
    paths: PATHS,
    bundledMsiPath: MSI,
    psDir: PATHS.psDir,
    systemRoot: 'C:\\Windows',
    secrets: { get: async () => PW, set: async () => undefined, delete: async () => undefined, backend: () => 'dpapi' },
    install: null,
    isAdmin: false,
  };
  return { runner, log, env, ctx, steps: createHostSteps(env) };
}

async function applyAll(s: ReturnType<typeof setup>, ids: readonly string[] = ELEVATED_STEP_IDS) {
  const out: StepRecord[] = [];
  for (const step of s.steps.filter((x) => ids.includes(x.id))) out.push(await step.apply(s.ctx));
  return Object.fromEntries(out.map((r) => [r.stepId, r])) as Record<string, StepRecord>;
}

describe('host steps: full setup on a clean PC', () => {
  it('installs, configures, sets creds, restarts, pins the cert, logs in, opens the firewall', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = freshMachine();
    const s = setup(m);
    const r = await applyAll(s);
    for (const id of ELEVATED_STEP_IDS) expect(r[id]?.status, `${id}: ${r[id]?.message}`).toBe('pass');

    // every command is an absolute path + argv array
    const files = s.runner.calls.map((c) => c.file);
    expect(files.every((f) => w.isAbsolute(f))).toBe(true);
    const msi = s.runner.calls.find((c) => c.file === 'C:\\Windows\\System32\\msiexec.exe')!;
    expect(msi.args.slice(0, 5)).toEqual(['/i', MSI, '/qn', '/norestart', '/l*v']);
    expect(msi.args[5]).toMatch(/^C:\\ProgramData\\LanPlay\\logs\\msiexec-.*\.log$/);
    expect(s.runner.calls.find((c) => c.file.endsWith('sc.exe') && c.args[0] === 'config')!.args).toEqual(['config', 'SunshineService', 'start=', 'auto']);
    const creds = s.runner.calls.find((c) => c.file === 'C:\\Program Files\\Sunshine\\sunshine.exe')!;
    expect(creds.args).toEqual(['--creds', 'lanplay', PW]);
    expect(creds.secrets).toEqual([PW]);
    expect(m.credsSet).toBe(PW);
    // config merged
    expect(m.files.get('C:\\Program Files\\Sunshine\\config\\sunshine.conf')).toBe(Object.entries(SUNSHINE_MANAGED_CONFIG).map(([k, v]) => `${k} = ${v}`).join('\n') + '\n');
    // cert pinned + copied
    expect(m.files.get('C:\\ProgramData\\LanPlay\\sunshine-cert.pem')).toBe(SUNSHINE_TEST_CERT);
    // the password never appears in any step record
    expect(JSON.stringify(r)).not.toContain(PW);
    expect(r.credentials!.commands[0]!.argv).toEqual(['--creds', 'lanplay', REDACTED]);
    expect(JSON.stringify(s.log.entries)).not.toContain(PW);
    // firewall
    expect(m.firewall.filter((x) => x.name === 'Sunshine')).toHaveLength(2);
    expect(m.firewall.filter((x) => x.name === LANPLAY.agentFirewallRuleName)).toHaveLength(2);
    // PS wrappers got non-ASCII paths verbatim
    const ps = s.runner.calls.find((c) => c.file.endsWith('powershell.exe'))!;
    expect(ps.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(ps.args[6]).toBe('C:\\Users\\Jörg Müller\\Downloads\\LanPlay-win32-x64\\resources\\ps\\test-admin.ps1');

    // second run is idempotent: nothing reinstalled or rewritten
    const before = s.runner.calls.length;
    const again = await applyAll(s);
    expect(again['install-sunshine']!.status).toBe('skip');
    expect(again.config!.message).toMatch(/already correct/);
    const newCalls = s.runner.calls.slice(before);
    expect(newCalls.some((c) => c.file.endsWith('msiexec.exe'))).toBe(false);
    expect(newCalls.some((c) => c.args.includes('add-firewall-rule.bat') || c.args.some((a) => a.endsWith('add-firewall-rule.bat')))).toBe(false);

    // every probe passes afterwards
    for (const step of s.steps.filter((x) => ELEVATED_STEP_IDS.includes(x.id))) {
      const p = await step.probe(s.ctx);
      expect(p.status, `${step.id}: ${p.message}`).toBe('pass');
    }
  });

  it('repairs what the silent MSI custom action may have skipped (Return="ignore")', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = freshMachine({ msiCreatesService: false });
    const s = setup(m);
    const r = await applyAll(s);
    expect(r.service!.status).toBe('pass');
    const bats = s.runner.calls.filter((c) => c.file === 'C:\\Windows\\System32\\cmd.exe');
    expect(bats.map((c) => c.args)).toEqual([
      ['/d', '/c', 'install-service.bat'],
      ['/d', '/c', 'autostart-service.bat'],
      ['/d', '/c', 'add-firewall-rule.bat'],
    ]);
    expect(bats.every((c) => c.cwd === 'C:\\Program Files\\Sunshine\\scripts')).toBe(true);
  });
});

describe('host steps: failure paths give an actionable message', () => {
  it('not elevated: admin fails and admin-only steps say why', async () => {
    const m = freshMachine({ isAdmin: false });
    const s = setup(m);
    const r = await applyAll(s);
    expect(r.admin!.status).toBe('fail');
    expect(r['install-sunshine']!.message).toMatch(/administrator/);
    expect(s.runner.calls.some((c) => c.file.endsWith('msiexec.exe'))).toBe(false);
  });

  it('old NSIS install: tells the user to uninstall it first', async () => {
    const m = freshMachine();
    installSunshineFiles(m, 'C:\\Program Files\\Sunshine', SUNSHINE_TEST_CERT);
    m.uninstallEntries = [{ displayName: 'Sunshine', uninstallString: '"C:\\Program Files\\Sunshine\\uninstall.exe"' }];
    const s = setup(m);
    const r = await applyAll(s, ['admin', 'locate-sunshine', 'install-sunshine']);
    expect(r['locate-sunshine']!.status).toBe('fail');
    expect(r['locate-sunshine']!.message).toMatch(/uninstall it first/);
  });

  it('MSI hash mismatch: refuses to install', async () => {
    const s = setup(freshMachine(), { sha256File: async () => createHash('sha256').update('evil').digest('hex') });
    const r = await applyAll(s, ['admin', 'locate-sunshine', 'install-sunshine']);
    expect(r['install-sunshine']!.status).toBe('fail');
    expect(r['install-sunshine']!.message).toMatch(/pinned SHA256/);
    expect(s.runner.calls.some((c) => c.file.endsWith('msiexec.exe'))).toBe(false);
  });

  it.each([
    [1603, /exit code 1603.*installer log is C:\\ProgramData\\LanPlay\\logs\\msiexec-/],
    [1618, /Another installation is running/],
  ])('msiexec %i', async (code, re) => {
    const s = setup(freshMachine({ msiExit: code }));
    const r = await applyAll(s, ['admin', 'locate-sunshine', 'install-sunshine']);
    expect(r['install-sunshine']!.status).toBe('fail');
    expect(r['install-sunshine']!.message).toMatch(re);
  });

  it('service that will not start', async () => {
    const m = freshMachine({ scStartFails: true });
    const s = setup(m);
    const r = await applyAll(s, ['admin', 'locate-sunshine', 'install-sunshine', 'service']);
    expect(r.service!.status).toBe('fail');
    expect(r.service!.message).toMatch(/sc.exe start failed \(exit 1053\)/);
  });

  it('cert mismatch on the web API is reported, not ignored', async () => {
    const m = freshMachine();
    const s = setup(m, { tlsPinCheck: async () => ({ ok: false, error: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
    const r = await applyAll(s, ['admin', 'locate-sunshine', 'install-sunshine', 'service', 'web-ui']);
    expect(r['web-ui']!.status).toBe('fail');
    expect(r['web-ui']!.message).toMatch(/different certificate/);
    expect(m.files.has('C:\\ProgramData\\LanPlay\\sunshine-cert.pem')).toBe(false);
  });

  it('api-auth explains a password mismatch and a missing admin user', async () => {
    mock = await startMockSunshine({ password: 'something-else' });
    const m = freshMachine();
    installSunshineFiles(m, 'D:\\Spiele\\Sunshine', SUNSHINE_TEST_CERT);
    m.files.set('C:\\ProgramData\\LanPlay\\sunshine-cert.pem', SUNSHINE_TEST_CERT);
    const s = setup(m);
    await s.steps.find((x) => x.id === 'locate-sunshine')!.probe(s.ctx);
    expect(s.ctx.install?.root).toBe('D:\\Spiele\\Sunshine');
    const auth = s.steps.find((x) => x.id === 'api-auth')!;
    expect((await auth.probe(s.ctx)).message).toMatch(/rejected LanPlay's admin password/);
    mock.setNoUser(true);
    expect((await auth.probe(s.ctx)).message).toMatch(/no admin user yet/);
    m.files.set('C:\\ProgramData\\LanPlay\\sunshine-cert.pem', WRONG_TEST_CERT);
    mock.setNoUser(false);
    expect((await auth.probe(s.ctx)).message).toMatch(/certificate is not the one LanPlay pinned/);
  });

  const blockRule = (program: string) => ({ id: 'x', name: 'lanplay.exe', enabled: true, direction: 'Inbound', action: 'Block', profile: 'Public', protocol: 'TCP', localPort: 'Any', remoteAddress: 'Any', program });

  it('firewall: setup removes Block rules bound to LanPlay.exe (dismissed Windows prompt), even when the Allow rules are already fine', async () => {
    const m = freshMachine();
    const s = setup(m);
    s.ctx.isAdmin = true;
    const step = s.steps.find((x) => x.id === 'firewall-agent')!;
    expect((await step.apply(s.ctx)).status).toBe('pass'); // allow rules now exist
    m.firewall.push(blockRule(s.env.selfExe));
    // self-check (read-only) reports it and says how to fix it
    const probe = await step.probe(s.ctx);
    expect(probe.status).toBe('warn');
    expect(probe.message).toMatch(/Block rule.*press "Set up \/ Repair"/);
    expect(m.firewall.some((r) => r.action === 'Block')).toBe(true);
    // setup removes it
    const r = await step.apply(s.ctx);
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/Removed 1 Block rule/);
    expect(m.firewall.some((r) => r.action === 'Block')).toBe(false);
    const fw = s.runner.calls.find((c) => c.args[6]?.endsWith('get-firewall-rules.ps1'))!;
    expect(fw.args).toContain('-Program');
  });

  it('firewall: if Windows refuses to remove the Block rule, the step says exactly which rule to delete by hand', async () => {
    const m = freshMachine({ blockRulesStick: true });
    const s = setup(m);
    s.ctx.isAdmin = true;
    m.firewall.push(blockRule(s.env.selfExe));
    const r = await s.steps.find((x) => x.id === 'firewall-agent')!.apply(s.ctx);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/could not be removed \(Access is denied\.\).*delete the Block rules named "lanplay\.exe"/);
  });

  it('api-auth during setup retries while Sunshine is still coming up, self-check does not', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = freshMachine();
    installSunshineFiles(m, 'C:\\Program Files\\Sunshine', SUNSHINE_TEST_CERT);
    m.files.set('C:\\ProgramData\\LanPlay\\sunshine-cert.pem', SUNSHINE_TEST_CERT);
    let calls = 0;
    const s = setup(m, {
      createSunshineClient: (o) => {
        // first two attempts hit a closed port, then the real mock
        const real = createSunshineClient({ ...o, baseUrl: mock!.url });
        const dead = createSunshineClient({ ...o, baseUrl: 'https://127.0.0.1:1' });
        return new Proxy(real, { get: (t, k) => (k === 'listClients' ? () => (++calls <= 2 ? dead.listClients() : t.listClients()) : Reflect.get(t, k)) });
      },
    });
    await s.steps.find((x) => x.id === 'locate-sunshine')!.probe(s.ctx);
    const auth = s.steps.find((x) => x.id === 'api-auth')!;
    const applied = await auth.apply(s.ctx);
    expect(applied.status).toBe('pass');
    expect(applied.data?.retries).toBe(2);
    calls = 0;
    const probed = await auth.probe(s.ctx);
    expect(probed.status).toBe('fail');
    expect(probed.message).toMatch(/Cannot reach Sunshine/);
  });

  it('api-auth warns in plain words when Sunshine logged that it has no working encoder', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = freshMachine();
    installSunshineFiles(m, 'C:\\Program Files\\Sunshine', SUNSHINE_TEST_CERT);
    m.files.set('C:\\ProgramData\\LanPlay\\sunshine-cert.pem', SUNSHINE_TEST_CERT);
    const s = setup(m);
    await s.steps.find((x) => x.id === 'locate-sunshine')!.probe(s.ctx);
    const auth = s.steps.find((x) => x.id === 'api-auth')!;
    // normal probing noise must NOT trigger the warning
    mock.logText = '[2026-11-13 10:00:00]: Info: // Testing for available encoders, this may generate errors. You can safely ignore those errors. //\n[2026-11-13 10:00:01]: Info: Encoder [nvenc] failed\n[2026-11-13 10:00:02]: Info: Found H.264 encoder: h264_qsv [quicksync]\n';
    expect((await auth.probe(s.ctx)).status).toBe('pass');
    mock.logText += '[2026-11-13 10:00:03]: Fatal: Unable to find display or encoder during startup.\n[2026-11-13 10:00:03]: Fatal: Please check that a display is connected and powered on.\n';
    const r = await auth.probe(s.ctx);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/no working video encoder or display.*graphics driver/);
    expect(String(r.data?.encoderProblem)).toMatch(/Unable to find display or encoder/);
  });

  it('an older Sunshine that is already installed is kept, with a warning that says what to do if pairing fails', async () => {
    const m = freshMachine();
    installSunshineFiles(m, 'C:\\Program Files\\Sunshine', SUNSHINE_TEST_CERT);
    m.uninstallEntries = [{ displayName: 'Sunshine', displayVersion: '2026.301.12345', installLocation: 'C:\\Program Files\\Sunshine\\' }];
    const s = setup(m);
    const r = await applyAll(s, ['admin', 'locate-sunshine', 'install-sunshine']);
    expect(r['locate-sunshine']!.status).toBe('warn');
    expect(r['locate-sunshine']!.message).toMatch(/older than the 2026\.914\.233613.*Uninstall, then run setup again/);
    expect(r['install-sunshine']!.status).toBe('skip');
    expect(compareVersions('2026.914.233613', '2026.914.233613')).toBe(0);
    expect(compareVersions('v2027.1.1', '2026.914.233613')).toBe(1);
    expect(compareVersions(undefined, '2026.914.233613')).toBeNull();
  });

  it('install step copies upstream installer logs next to LanPlay logs (also when msiexec fails)', async () => {
    let n = 0;
    const s = setup(freshMachine({ msiExit: 1603 }), { collectInstallerLogs: () => (n++, ['C:\\ProgramData\\LanPlay\\logs\\sunshine-install-20261113_101500.log']) });
    const r = await applyAll(s, ['admin', 'locate-sunshine', 'install-sunshine']);
    expect(n).toBe(1);
    expect(r['install-sunshine']!.data?.installerLogs).toEqual(['C:\\ProgramData\\LanPlay\\logs\\sunshine-install-20261113_101500.log']);
  });

  it('evaluateAgentFirewall reports wrong port and scope', () => {
    const ev = evaluateAgentFirewall(
      [
        { id: 'a', name: LANPLAY.agentFirewallRuleName, enabled: true, direction: 'Inbound', action: 'Allow', protocol: 'TCP', localPort: '1234', remoteAddress: 'Any', program: 'Any', matchedBy: 'name' },
      ],
      47920,
    );
    expect(ev.ok).toBe(false);
    expect(ev.problems.join(';')).toMatch(/port is 1234.*LocalSubnet.*UDP rule missing|UDP rule missing/);
  });
});

describe('host steps: probes are read-only', () => {
  it('self-check probes never call msiexec, sc.exe, cmd.exe, sunshine.exe or set-agent-firewall-rule', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = freshMachine();
    const s = setup(m, {
      loginItem: { get: () => false, set: () => undefined },
      agentProbe: async () => ({ http: false, udp: false, detail: 'ECONNREFUSED' }),
    });
    const recs: StepRecord[] = [];
    for (const step of s.steps) recs.push(await step.probe(s.ctx));
    expect(recs.map((r) => r.stepId)).toEqual([...HOST_STEP_ORDER]);
    for (const c of s.runner.calls) {
      expect(w.basename(c.file)).toBe('powershell.exe');
      expect(c.args[6]).not.toMatch(/set-agent-firewall-rule|invoke-elevated/);
    }
    expect(m.files.size).toBe(1); // only the MSI placed by setup()
    expect(recs.find((r) => r.stepId === 'agent-listening')!.message).toMatch(/ECONNREFUSED/);
    expect(recs.find((r) => r.stepId === 'agent-autostart')!.status).toBe('fail');
  });
});
