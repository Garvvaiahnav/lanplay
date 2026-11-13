import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_STEP_ORDER, LANPLAY } from '../../src/contracts.js';
import type { AppPaths, ServiceDeps, StepRecord } from '../../src/contracts.js';
import { collectSunshineInstallerLogs, generateAdminPassword, validateHandoff, WindowsHostService } from '../../src/core/host/service.js';
import type { HostServiceExtras } from '../../src/core/host/service.js';
import { certFingerprint256, createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { SUNSHINE_MSI_SHA256 } from '../../src/core/host/vendor.js';
import { parseWindowsCommandLine } from '../../src/core/host/winargs.js';
import { createJsonlLogger } from '../../src/core/shared/logger.js';
import { FileSecretStore, MemoryStore } from '../../src/core/shared/stores.js';
import { FakeWindowsRunner, freshMachine } from '../fixtures/fake-windows.js';
import type { FakeMachineState } from '../fixtures/fake-windows.js';
import { startMockSunshine, SUNSHINE_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

let mock: MockSunshine | undefined;
const services: WindowsHostService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.agent.stop();
  await mock?.close();
  mock = undefined;
});

function makePaths(root: string): AppPaths {
  const p: AppPaths = {
    logDir: path.join(root, 'ProgramData', 'LanPlay', 'logs'),
    userData: path.join(root, 'Users', 'Jörg Müller', 'AppData', 'Roaming', 'LanPlay'),
    sharedData: path.join(root, 'ProgramData', 'LanPlay'),
    resources: path.join(root, 'app', 'resources'),
    vendorDir: path.join(root, 'app', 'resources', 'vendor'),
    psDir: path.join(root, 'app', 'resources', 'ps'),
    diagnosticsOutDir: path.join(root, 'Desktop'),
    logDirFellBack: false,
  };
  mkdirSync(p.logDir, { recursive: true });
  mkdirSync(p.userData, { recursive: true });
  return p;
}

function makeService(m: FakeMachineState, paths: AppPaths, elevated: boolean, extra: Partial<HostServiceExtras> = {}, logPattern: string = LANPLAY.logFilePattern) {
  const runner = new FakeWindowsRunner(m, SUNSHINE_TEST_CERT);
  runner.adminOverride = elevated;
  const log = createJsonlLogger({ dir: paths.logDir, filePattern: logPattern });
  const deps: ServiceDeps = { log, paths, secrets: new FileSecretStore(path.join(paths.userData, 'secrets.json')), settings: new MemoryStore(), runner };
  let login = false;
  const svc = new WindowsHostService(deps, {
    selfExe: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay\\LanPlay.exe',
    selfArgsPrefix: [],
    loginItem: { get: () => login, set: (v) => void (login = v) },
    systemRoot: 'C:\\Windows',
    agentPort: 0,
    agentExtra: { bindAddress: '127.0.0.1', udp: true },
    localIdentity: () => ({ hostName: 'Gaming-PC', addresses: ['127.0.0.1'] }),
    stepsEnv: {
      fileExists: (p) => m.files.has(p) || p.endsWith('Sunshine-Windows-AMD64-installer.msi'),
      readText: (p) => m.files.get(p) ?? null,
      writeText: (p, t) => void m.files.set(p, t),
      copyFile: (a, b) => {
        m.files.set(b, m.files.get(a)!);
        mkdirSync(path.dirname(b), { recursive: true });
        writeFileSync(b, m.files.get(a)!);
      },
      sha256File: async () => SUNSHINE_MSI_SHA256,
      createSunshineClient: (o) => createSunshineClient({ ...o, baseUrl: mock!.url }),
      tcpProbe: async () => m.service?.state === 'Running',
      tlsPinCheck: async (_h, _p, pem) => ({ ok: pem === SUNSHINE_TEST_CERT }),
      fingerprint: certFingerprint256,
      sleep: async () => undefined,
      timing: { serviceWaitMs: 0, webUiWaitMs: 0, pollMs: 0 },
    },
    ...extra,
  });
  services.push(svc);
  return { svc, runner, deps };
}

describe('WindowsHostService: UAC round trip (parent -> invoke-elevated -> --host-setup child)', () => {
  it('passes the handoff through quoted argv with spaces and non-ASCII, deletes it, and reports every step', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay host Jörg 山田 '));
    const paths = makePaths(root);
    const temp = path.join(root, 'Users', 'Jörg Müller', 'AppData', 'Local', 'Temp');
    mkdirSync(temp, { recursive: true });
    const m = freshMachine();
    const parent = makeService(m, paths, false, { tempDir: temp });
    const child = makeService(m, paths, true, {}, LANPLAY.elevatedLogFilePattern);
    let seenArgv: string[] = [];
    parent.runner.onInvokeElevated = async (file, b64) => {
      expect(file).toBe('C:\\Users\\Jörg Müller\\Downloads\\LanPlay\\LanPlay.exe');
      // What Start-Process would hand to CreateProcess: the pre-quoted elements joined with spaces.
      const quoted = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as string[];
      seenArgv = parseWindowsCommandLine(quoted.join(' '));
      const h = seenArgv[seenArgv.indexOf('--handoff') + 1]!;
      const r = seenArgv[seenArgv.indexOf('--result') + 1]!;
      expect(existsSync(h)).toBe(true);
      const code = await child.svc.runElevatedSetup(h, r);
      expect(existsSync(h)).toBe(false); // child deleted the password file right away
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ exitCode: code, cancelled: false }), stderr: '', durationMs: 1, timedOut: false };
    };
    const pw = generateAdminPassword();
    await parent.deps.secrets.set('sunshine-admin-password', pw);
    mock = await startMockSunshine({ password: pw });

    const progress: StepRecord[] = [];
    const st = await parent.svc.runSetup((s) => progress.push(s));
    expect(seenArgv.slice(0, 2)).toEqual(['--host-setup', '--handoff']);
    expect(st.steps.map((s) => s.stepId)).toEqual([...HOST_STEP_ORDER]);
    for (const s of st.steps) expect(s.status, `${s.stepId}: ${s.message}`).toMatch(/pass|warn/);
    expect(st.ok).toBe(true);
    expect(st.install?.root).toBe('C:\\Program Files\\Sunshine');
    expect(m.credsSet).toBe(pw);
    expect(readdirSync(temp)).toEqual([]); // handoff + result cleaned up
    expect(progress.map((p) => p.stepId)).toContain('agent-listening');
    expect(parent.svc.agent.getState().listening).toBe(true);
    // status is persisted
    const again = await parent.svc.setupStatus();
    expect(again.lastRunAt).not.toBeNull();
    expect(again.ok).toBe(true);
    // the password never reached a log file
    const logs = readdirSync(paths.logDir).map((f) => readFileSync(path.join(paths.logDir, f), 'utf8')).join('\n');
    expect(logs).not.toContain(pw);
    expect(logs).toContain('"stepId":"credentials"');
  });

  it('reports a cancelled UAC prompt clearly', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-host-'));
    const paths = makePaths(root);
    const m = freshMachine();
    const parent = makeService(m, paths, false, { tempDir: root });
    parent.runner.onInvokeElevated = async () => ({ exitCode: 1, signal: null, stdout: JSON.stringify({ error: 'The operation was canceled by the user.', exitCode: null, cancelled: true }), stderr: '', durationMs: 1, timedOut: false });
    const st = await parent.svc.runSetup(() => undefined);
    expect(st.ok).toBe(false);
    expect(st.steps[0]).toMatchObject({ stepId: 'admin', status: 'fail' });
    expect(st.steps[0]!.message).toMatch(/cancelled/);
    expect(readdirSync(root).filter((f) => f.startsWith('lanplay-handoff'))).toEqual([]);
  });

  it('elevated child rejects a bad handoff and still writes a result', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-host-'));
    const paths = makePaths(root);
    const child = makeService(freshMachine(), paths, true);
    const h = path.join(root, 'h.json');
    const r = path.join(root, 'r.json');
    writeFileSync(h, '{"version":2}');
    expect(await child.svc.runElevatedSetup(h, r)).toBe(2);
    expect(existsSync(h)).toBe(false);
    expect(JSON.parse(readFileSync(r, 'utf8')).steps[0].message).toMatch(/handoff/);
  });

  it('validates handoff fields', () => {
    const good = { version: 1, createdAt: new Date().toISOString(), sunshineAdminUser: 'lanplay', sunshineAdminPassword: generateAdminPassword(), logDir: 'C:\\x', sharedData: 'C:\\y' };
    expect(validateHandoff(good)).toEqual(good);
    expect(() => validateHandoff({ ...good, sunshineAdminPassword: 'a b' })).toThrow();
    expect(() => validateHandoff({ ...good, sunshineAdminUser: 'x"y' })).toThrow();
    expect(generateAdminPassword()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('the pair agent does not listen at launch until setup ran for this exact LanPlay.exe (no Windows firewall prompt to dismiss)', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-host-'));
    const paths = makePaths(root);
    const m = freshMachine();
    const a = makeService(m, paths, true);
    // fresh PC: not yet
    const first = a.svc.agentAutoStart();
    expect(first.start).toBe(false);
    expect(first.reason).toMatch(/after setup/);
    a.svc.agentIdle(first.reason);
    expect(a.svc.agent.getState()).toMatchObject({ listening: false, lastError: first.reason });
    // after setup (already elevated: in-process): yes, and setup itself started it
    const pw = generateAdminPassword();
    await a.deps.secrets.set('sunshine-admin-password', pw);
    mock = await startMockSunshine({ password: pw });
    const st = await a.svc.runSetup(() => undefined);
    expect(st.ok, st.steps.filter((x) => x.status === 'fail').map((x) => `${x.stepId}: ${x.message}`).join('; ')).toBe(true);
    expect(a.svc.agent.getState().listening).toBe(true);
    expect(a.svc.agent.getState().lastError ?? '').not.toMatch(/after setup/);
    expect(a.svc.agentAutoStart()).toEqual({ start: true });
    // same settings, but LanPlay now runs from another folder: the program-bound firewall rule no longer matches
    const moved = new WindowsHostService(a.deps, { selfExe: 'D:\\Games\\LanPlay\\LanPlay.exe', selfArgsPrefix: [], loginItem: null, systemRoot: 'C:\\Windows', agentPort: 0, agentExtra: { bindAddress: '127.0.0.1', udp: false } });
    services.push(moved);
    const again = moved.agentAutoStart();
    expect(again.start).toBe(false);
    expect(again.reason).toMatch(/moved.*Set up \/ Repair/);
    // case differences in the path are not a move
    const sameCase = new WindowsHostService(a.deps, { selfExe: 'c:\\users\\JÖRG MÜLLER\\downloads\\lanplay\\LANPLAY.EXE'.replace('JÖRG MÜLLER', 'Jörg Müller'), selfArgsPrefix: [], loginItem: null, systemRoot: 'C:\\Windows', agentPort: 0, agentExtra: { bindAddress: '127.0.0.1', udp: false } });
    services.push(sameCase);
    expect(sameCase.agentAutoStart()).toEqual({ start: true });
  });

  it('copies upstream installer logs out of SYSTEM temp folders (newest first, bounded)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-inst-'));
    const sysRoot = path.join(root, 'Windows');
    const sysTemp = path.join(sysRoot, 'SystemTemp', 'Sunshine', 'logs', 'install');
    const oldTemp = path.join(sysRoot, 'Temp', 'Sunshine', 'logs', 'install');
    mkdirSync(sysTemp, { recursive: true });
    mkdirSync(oldTemp, { recursive: true });
    writeFileSync(path.join(sysTemp, '20261113_101500.log'), 'new install log');
    writeFileSync(path.join(oldTemp, '20250101_000000.log'), 'old install log');
    const dest = path.join(root, 'ProgramData', 'LanPlay', 'logs');
    const copied = collectSunshineInstallerLogs(sysRoot, path.join(root, 'no-such-user-temp'), dest);
    expect(copied.map((p) => path.basename(p)).sort()).toEqual(['sunshine-install-20250101_000000.log', 'sunshine-install-20261113_101500.log']);
    expect(readFileSync(path.join(dest, 'sunshine-install-20261113_101500.log'), 'utf8')).toBe('new install log');
    // nothing to copy is not an error
    expect(collectSunshineInstallerLogs(path.join(root, 'nope'), undefined, dest)).toEqual([]);
  });

  it('generated admin passwords never look like a command-line option', () => {
    for (let i = 0; i < 300; i++) expect(generateAdminPassword()).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{42}$/);
  });

  it('self-check runs every probe independently', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-host-'));
    const { svc } = makeService(freshMachine(), makePaths(root), false);
    const rep = await svc.selfCheck();
    expect(rep.role).toBe('host');
    expect(rep.steps.map((s) => s.stepId)).toEqual([...HOST_STEP_ORDER]);
    expect(rep.ok).toBe(false);
  });
});
