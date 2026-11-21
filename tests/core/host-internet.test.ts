// 0.5 W2: code pairing on the host agent, the internet switch (D07), its firewall rule and the sunshine.conf values (D08/D09).
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_STEP_ORDER, LANPLAY, SUNSHINE, sunshineManagedConfig } from '../../src/contracts.js';
import type { AppPaths, HostSetupHandoff, HostStepContext, ServiceDeps, StepRecord, SunshineClient } from '../../src/contracts.js';
import { INTERNET_KEY, LanPairAgent, LEDGER_KEY } from '../../src/core/host/agent.js';
import { internetAddresses, validateHandoff, WindowsHostService } from '../../src/core/host/service.js';
import type { HostServiceExtras } from '../../src/core/host/service.js';
import { parseSunshineConf } from '../../src/core/host/sunshine-conf.js';
import { createHostSteps, ELEVATED_STEP_IDS, evaluateInternetFirewall, portListCovers, STEP_TITLES } from '../../src/core/host/steps.js';
import type { FirewallRuleFact, HostStepsEnv } from '../../src/core/host/steps.js';
import { certFingerprint256, createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { SUNSHINE_MSI_SHA256 } from '../../src/core/host/vendor.js';
import { MemoryLogger, createJsonlLogger } from '../../src/core/shared/logger.js';
import { FileSecretStore, MemoryStore } from '../../src/core/shared/stores.js';
import { FakeWindowsRunner, freshMachine } from '../fixtures/fake-windows.js';
import type { FakeMachineState } from '../fixtures/fake-windows.js';
import { startMockSunshine, SUNSHINE_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

const PW = 'Q2h4bGxvd2VkLXRlc3QtcGFzc3dvcmQtMTIzNDU2Nzg';
const CONF = 'C:\\Program Files\\Sunshine\\config\\sunshine.conf';

let mock: MockSunshine | undefined;
const agents: LanPairAgent[] = [];
const services: WindowsHostService[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop();
  for (const s of services.splice(0)) await s.agent.stop();
  await mock?.close();
  mock = undefined;
});

/* ------------------------------------------------------------------ code pairing */

async function agentSetup(over: { sunshine?: SunshineClient; settings?: MemoryStore } = {}) {
  mock = await startMockSunshine({ password: PW });
  const settings = over.settings ?? new MemoryStore();
  const log = new MemoryLogger();
  const sunshine = over.sunshine ?? createSunshineClient({ baseUrl: mock.url, username: 'lanplay', getPassword: async () => PW, pinnedCertPem: SUNSHINE_TEST_CERT, timeoutMs: 5000 });
  const agent = new LanPairAgent(
    { port: 0, sunshine, log, settings, localIdentity: () => ({ hostName: 'Gaming-PC', addresses: ['127.0.0.1', '192.168.1.10'] }) },
    { bindAddress: '127.0.0.1', udp: false, pendingPollMs: 20, pendingWaitMs: 200 },
  );
  await agent.start();
  agents.push(agent);
  return { agent, mock, settings, log };
}

describe('code pairing (pairWithCode / listPending / rejectPending)', () => {
  it('lists every pending pairing and flags the ones from a public address', async () => {
    const { agent, mock } = await agentSetup();
    mock.addPending({ name: 'Anna phone', address: '203.0.113.7', expectedPin: '4821' });
    mock.addPending({ name: 'TV', address: '192.168.1.40', expectedPin: '1111' });
    const list = await agent.listPending();
    expect(list.map((p) => ({ name: p.name, address: p.address, remote: p.remote }))).toEqual([
      { name: 'Anna phone', address: '203.0.113.7', remote: true },
      { name: 'TV', address: '192.168.1.40', remote: false },
    ]);
    expect(list.every((p) => /^[0-9a-f]{32}$/.test(p.id))).toBe(true);
  });

  it('pairs through Sunshine with the right code and writes the ledger with pairedVia "code"', async () => {
    const { agent, mock, settings, log } = await agentSetup();
    const p = mock.addPending({ name: 'Anna phone', address: '203.0.113.7', expectedPin: '4821' });
    const r = await agent.pairWithCode(p.id, '4821', 'Anna phone');
    expect(r.ok).toBe(true);
    expect(r.message).toBeUndefined();
    expect(r.pending).toEqual([]);
    expect(mock.clients).toHaveLength(1);
    expect(mock.clients[0]).toMatchObject({ name: 'Anna phone' });
    const ledger = settings.get<Array<Record<string, unknown>>>(LEDGER_KEY, []);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ uuid: mock.clients[0]!.uuid, name: 'Anna phone', pairedVia: 'code', lastAddress: '203.0.113.7' });
    expect(typeof ledger[0]!.pairedAt).toBe('string');
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({ name: 'Anna phone', lastAddress: '203.0.113.7' });
    expect((r.devices[0] as { pairedVia?: string }).pairedVia).toBe('code');
    // the code never reaches a log
    expect(JSON.stringify(log.entries)).not.toContain('4821');
    // revoke removes it from the ledger again
    await agent.revoke(mock.clients[0]!.uuid);
    expect(settings.get<unknown[]>(LEDGER_KEY, [])).toHaveLength(0);
  });

  it('a wrong code fails with a sentence and leaves no ledger entry and no device', async () => {
    const { agent, mock, settings } = await agentSetup();
    const p = mock.addPending({ name: 'Anna phone', address: '203.0.113.7', expectedPin: '4821' });
    const r = await agent.pairWithCode(p.id, '0000', 'Anna phone');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did not accept that code/);
    expect(settings.get<unknown[]>(LEDGER_KEY, [])).toHaveLength(0);
    expect(mock.clients).toHaveLength(0);
    expect(r.devices).toEqual([]);
  });

  it('refuses a malformed code or id without calling Sunshine', async () => {
    const { agent, mock, settings } = await agentSetup();
    const p = mock.addPending({ name: 'Anna phone', address: '203.0.113.7', expectedPin: '4821' });
    mock.requests.length = 0;
    expect((await agent.pairWithCode(p.id, '12a4', 'x')).ok).toBe(false);
    expect((await agent.pairWithCode(p.id, '123', 'x')).ok).toBe(false);
    expect((await agent.pairWithCode('not-an-id', '1234', 'x')).ok).toBe(false);
    expect(mock.requests.filter((q) => q.url.startsWith('/api/pin') && q.method === 'POST')).toHaveLength(0);
    expect(settings.get<unknown[]>(LEDGER_KEY, [])).toHaveLength(0);
  });

  it('says so when the pairing request is gone, and when Sunshine is not answering', async () => {
    const { agent, mock } = await agentSetup();
    const gone = await agent.pairWithCode('a'.repeat(32), '4821', 'Anna phone');
    expect(gone.ok).toBe(false);
    expect(gone.message).toMatch(/gone/);
    mock.setPassword('someone-changed-it');
    const down = await agent.pairWithCode('a'.repeat(32), '4821', 'Anna phone');
    expect(down.ok).toBe(false);
    expect(down.message).toMatch(/password|login|rejected/i);
    expect(down.pending).toEqual([]);
  });

  it('keeps a device name that Sunshine accepts even when LanPlay\'s own name rules would not', async () => {
    const { agent, mock } = await agentSetup();
    const p = mock.addPending({ name: "Anna's <phone>", address: '203.0.113.7', expectedPin: '4821' });
    expect((await agent.listPending())[0]!.name).toBe('Annas phone');
    const r = await agent.pairWithCode(p.id, '4821', "Anna's <phone>");
    expect(r.ok).toBe(true);
    expect(mock.clients[0]!.name).toBe('Annas phone');
  });

  it('rejectPending cancels the pairing in Sunshine and returns the rest', async () => {
    const { agent, mock } = await agentSetup();
    const a = mock.addPending({ name: 'A', address: '203.0.113.7', expectedPin: '1111' });
    mock.addPending({ name: 'B', address: '192.168.1.40', expectedPin: '2222' });
    const left = await agent.rejectPending(a.id);
    expect(left.map((p) => p.name)).toEqual(['B']);
    expect(mock.pending.map((p) => p.name)).toEqual(['B']);
    expect((await agent.rejectPending('nope')).map((p) => p.name)).toEqual(['B']);
  });

  it('pairing by code does not need, and never changes, the agent HTTP guards: a public source still gets 403 with the internet switch on', async () => {
    const settings = new MemoryStore();
    settings.set(INTERNET_KEY, true);
    const { agent, mock } = await agentSetup({ settings });
    const port = agent.getState().port;
    mock.addPending({ name: 'Anna phone', address: '203.0.113.7', expectedPin: '4821' });
    mock.requests.length = 0;
    const handle = (agent as unknown as { handle(req: unknown, res: unknown): Promise<void> }).handle.bind(agent);
    for (const source of ['203.0.113.7', '::ffff:203.0.113.7', '2001:db8::1']) {
      for (const [method, url] of [['GET', '/v1/info'], ['POST', '/v1/pair'], ['GET', '/v1/pair/abc']] as const) {
        const out = { status: 0, body: '' };
        const req = { socket: { remoteAddress: source }, method, url, headers: { host: `192.168.1.10:${port}`, 'content-type': 'application/json' }, resume() {} };
        const res = {
          headersSent: false,
          writeHead(s: number) {
            out.status = s;
          },
          end(b: string) {
            out.body = b;
          },
        };
        await handle(req, res);
        expect(out.status, `${source} ${method} ${url}`).toBe(403);
        expect(JSON.parse(out.body)).toEqual({ error: 'forbidden-source' });
      }
    }
    expect(mock.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ firewall rule evaluation */

describe('internet firewall rule', () => {
  const rule = (over: Partial<FirewallRuleFact>): FirewallRuleFact => ({ id: 'x', name: LANPLAY.internetFirewallRuleName, enabled: true, direction: 'Inbound', action: 'Allow', profile: 'Any', protocol: 'TCP', localPort: '47984,47989,48010', remoteAddress: 'Any', program: 'Any', matchedBy: 'name', ...over });
  const good = [rule({}), rule({ id: 'y', protocol: 'UDP', localPort: '47998-48000' })];

  it('reads Windows port lists', () => {
    expect(portListCovers('47984,47989,48010', [47984, 47989, 48010])).toBe(true);
    expect(portListCovers('47998-48000', [47998, 47999, 48000])).toBe(true);
    expect(portListCovers('47998-47999', [47998, 47999, 48000])).toBe(false);
    expect(portListCovers('47984,47989', [47984, 47989, 48010])).toBe(false);
    expect(portListCovers('', [47984])).toBe(false);
    expect(portListCovers('Any', [47984])).toBe(false);
  });

  it('on: needs TCP 47984/47989/48010 and UDP 47998-48000, inbound allow, RemoteAddress Any', () => {
    expect(SUNSHINE.udpPorts).toEqual([47998, 47999, 48000]);
    expect(evaluateInternetFirewall(good, true)).toEqual({ ok: true, problems: [] });
    expect(evaluateInternetFirewall([], true).problems).toEqual(['TCP rule missing', 'UDP rule missing']);
    expect(evaluateInternetFirewall([good[0]!, rule({ id: 'y', protocol: 'UDP', localPort: '47998' })], true).problems.join()).toMatch(/UDP rule ports are 47998/);
    expect(evaluateInternetFirewall([rule({ remoteAddress: 'LocalSubnet' }), good[1]!], true).problems.join()).toMatch(/remote address is "LocalSubnet"/);
    expect(evaluateInternetFirewall([rule({ enabled: false }), good[1]!], true).problems.join()).toMatch(/not an enabled inbound Allow/);
    // a program-matched copy or a differently named rule is not ours
    expect(evaluateInternetFirewall([rule({ matchedBy: 'program' }), rule({ name: 'Other' })], true).ok).toBe(false);
  });

  it('off: any rule with our name is a problem, no rule is fine', () => {
    expect(evaluateInternetFirewall([], false)).toEqual({ ok: true, problems: [] });
    expect(evaluateInternetFirewall(good, false).ok).toBe(false);
  });

  it('has a title in the step table and is an elevated Windows step ahead of the user steps', () => {
    expect(STEP_TITLES['firewall-internet']).toContain(LANPLAY.internetFirewallRuleName);
    expect(ELEVATED_STEP_IDS).toContain('firewall-internet');
    expect(HOST_STEP_ORDER.indexOf('firewall-internet')).toBe(HOST_STEP_ORDER.indexOf('firewall-agent') + 1);
  });
});

/* ------------------------------------------------------------------ Windows steps */

const w = path.win32;
const PATHS: AppPaths = {
  logDir: 'C:\\ProgramData\\LanPlay\\logs',
  userData: 'C:\\Users\\Jörg Müller\\AppData\\Roaming\\LanPlay',
  sharedData: 'C:\\ProgramData\\LanPlay',
  resources: 'C:\\app\\resources',
  vendorDir: 'C:\\app\\resources\\vendor',
  psDir: 'C:\\app\\resources\\ps',
  diagnosticsOutDir: 'C:\\Users\\Jörg Müller\\Desktop',
  logDirFellBack: false,
};
const MSI = w.join(PATHS.vendorDir, 'Sunshine-Windows-AMD64-installer.msi');

function stepsSetup(m: FakeMachineState, internet: boolean | undefined) {
  const runner = new FakeWindowsRunner(m, SUNSHINE_TEST_CERT);
  m.files.set(MSI, 'msi-bytes');
  const mkEnv = (on: boolean | undefined): HostStepsEnv => ({
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
    selfExe: 'C:\\app\\LanPlay.exe',
    loginItem: null,
    agentProbe: null,
    now: Date.now,
    sleep: async () => undefined,
    timing: { serviceWaitMs: 0, webUiWaitMs: 0, pollMs: 0 },
    ...(on === undefined ? {} : { internet: on }),
  });
  const ctx: HostStepContext = {
    runner,
    log: new MemoryLogger(),
    paths: PATHS,
    bundledMsiPath: MSI,
    psDir: PATHS.psDir,
    systemRoot: 'C:\\Windows',
    secrets: { get: async () => PW, set: async () => undefined, delete: async () => undefined, backend: () => 'dpapi' },
    install: null,
    isAdmin: false,
  };
  return { runner, ctx, steps: (on: boolean | undefined) => createHostSteps(mkEnv(on)) };
}

async function applyAll(steps: ReturnType<typeof createHostSteps>, ctx: HostStepContext) {
  const out: StepRecord[] = [];
  for (const step of steps.filter((x) => ELEVATED_STEP_IDS.includes(x.id))) out.push(await step.apply(ctx));
  return Object.fromEntries(out.map((r) => [r.stepId, r])) as Record<string, StepRecord>;
}

const internetRules = (m: FakeMachineState) => m.firewall.filter((r) => r.name === LANPLAY.internetFirewallRuleName);
const conf = (m: FakeMachineState) => parseSunshineConf(m.files.get(CONF) ?? '');

describe('Windows steps with the internet switch', () => {
  it('on: writes the D08/D09 conf values and creates the TCP and UDP rule; the agent rule stays LocalSubnet; every probe passes', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = freshMachine();
    const s = stepsSetup(m, true);
    const r = await applyAll(s.steps(true), s.ctx);
    for (const id of ELEVATED_STEP_IDS) expect(r[id]?.status, `${id}: ${r[id]?.message}`).toBe('pass');

    expect(conf(m)).toEqual({ ...sunshineManagedConfig(true) });
    expect(conf(m)).toMatchObject({ origin_web_ui_allowed: 'pc', upnp: 'enabled', address_family: 'both' });

    const rules = internetRules(m);
    expect(rules.map((x) => ({ protocol: x.protocol, localPort: x.localPort, remoteAddress: x.remoteAddress, direction: x.direction, action: x.action }))).toEqual([
      { protocol: 'TCP', localPort: '47984,47989,48010', remoteAddress: 'Any', direction: 'Inbound', action: 'Allow' },
      { protocol: 'UDP', localPort: '47998-48000', remoteAddress: 'Any', direction: 'Inbound', action: 'Allow' },
    ]);
    const call = s.runner.calls.find((c) => c.args.some((a) => a.endsWith('set-internet-firewall-rule.ps1')))!;
    expect(call.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call.args.slice(7)).toEqual(['-Enable', '1', '-Name', 'LanPlay Internet Play', '-TcpPorts', '47984,47989,48010', '-UdpPorts', '47998-48000']);
    expect(m.firewall.filter((x) => x.name === LANPLAY.agentFirewallRuleName).every((x) => x.remoteAddress === 'LocalSubnet')).toBe(true);
    expect(m.firewall.filter((x) => x.name === 'Sunshine')).toHaveLength(2);

    for (const step of s.steps(true).filter((x) => ELEVATED_STEP_IDS.includes(x.id))) {
      const p = await step.probe(s.ctx);
      expect(p.status, `${step.id}: ${p.message}`).toBe('pass');
    }
    // a second run changes nothing
    const before = s.runner.calls.length;
    const again = await applyAll(s.steps(true), s.ctx);
    expect(again.config!.message).toMatch(/already correct/);
    expect(s.runner.calls.slice(before).some((c) => c.args.some((a) => a.endsWith('set-internet-firewall-rule.ps1')))).toBe(false);
  });

  it('off after on: conf goes back to disabled/ipv4, the rule is removed, the probe passes', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = freshMachine();
    const s = stepsSetup(m, true);
    await applyAll(s.steps(true), s.ctx);
    expect(internetRules(m)).toHaveLength(2);

    // while the switch is off but the rule exists, the probe says so
    const stale = s.steps(false).find((x) => x.id === 'firewall-internet')!;
    expect((await stale.probe(s.ctx)).status).toBe('fail');
    const staleConf = s.steps(false).find((x) => x.id === 'config')!;
    expect((await staleConf.probe(s.ctx)).status).toBe('fail');

    const r = await applyAll(s.steps(false), s.ctx);
    for (const id of ELEVATED_STEP_IDS) expect(r[id]?.status, `${id}: ${r[id]?.message}`).toBe(id === 'install-sunshine' ? 'skip' : 'pass');
    expect(conf(m)).toEqual({ ...sunshineManagedConfig(false) });
    expect(conf(m)).toMatchObject({ origin_web_ui_allowed: 'pc', upnp: 'disabled', address_family: 'ipv4' });
    expect(internetRules(m)).toEqual([]);
    expect(m.firewall.filter((x) => x.name === LANPLAY.agentFirewallRuleName)).toHaveLength(2);
    const off = s.runner.calls.filter((c) => c.args.some((a) => a.endsWith('set-internet-firewall-rule.ps1'))).at(-1)!;
    expect(off.args.slice(7)).toEqual(['-Enable', '0', '-Name', 'LanPlay Internet Play']);
    for (const step of s.steps(false).filter((x) => ELEVATED_STEP_IDS.includes(x.id))) {
      const p = await step.probe(s.ctx);
      expect(p.status, `${step.id}: ${p.message}`).toBe('pass');
    }
  });

  it('off on a PC that never had it (and with no setting given at all): no PowerShell call, step passes', async () => {
    mock = await startMockSunshine({ password: PW });
    for (const setting of [false, undefined] as const) {
      const m = freshMachine();
      const s = stepsSetup(m, setting);
      const r = await applyAll(s.steps(setting), s.ctx);
      expect(r['firewall-internet']).toMatchObject({ status: 'pass' });
      expect(r['firewall-internet']!.message).toMatch(/off/);
      expect(s.runner.calls.some((c) => c.args.some((a) => a.endsWith('set-internet-firewall-rule.ps1')))).toBe(false);
      expect(conf(m)).toMatchObject({ upnp: 'disabled', address_family: 'ipv4' });
    }
  });

  it('on without admin rights fails with the admin message and creates nothing', async () => {
    mock = await startMockSunshine({ password: PW });
    const m = freshMachine();
    const s = stepsSetup(m, true);
    const r = await applyAll(s.steps(true), s.ctx);
    expect(r['firewall-internet']!.status).toBe('pass');
    m.firewall = m.firewall.filter((x) => x.name !== LANPLAY.internetFirewallRuleName);
    s.ctx.isAdmin = false;
    const again = await s.steps(true).find((x) => x.id === 'firewall-internet')!.apply(s.ctx);
    expect(again.status).toBe('fail');
    expect(again.message).toMatch(/administrator/);
    expect(internetRules(m)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ Windows service */

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
  const settings = new MemoryStore();
  const deps: ServiceDeps = { log, paths, secrets: new FileSecretStore(path.join(paths.userData, 'secrets.json')), settings, runner };
  const svc = new WindowsHostService(deps, {
    selfExe: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay\\LanPlay.exe',
    selfArgsPrefix: [],
    loginItem: { get: () => true, set: () => undefined },
    systemRoot: 'C:\\Windows',
    agentPort: 0,
    agentExtra: { bindAddress: '127.0.0.1', udp: false },
    localIdentity: () => ({ hostName: 'Gaming-PC', addresses: ['127.0.0.1'] }),
    stepsEnv: {
      fileExists: (p) => m.files.has(p) || p.endsWith('Sunshine-Windows-AMD64-installer.msi'),
      readText: (p) => m.files.get(p) ?? null,
      writeText: (p, t) => void m.files.set(p, t),
      copyFile: (a, b) => void m.files.set(b, m.files.get(a)!),
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
  return { svc, runner, deps, settings };
}

const IFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
  'Wi-Fi': [
    { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '192.168.1.20/24' },
    { address: '169.254.3.4', netmask: '255.255.0.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '169.254.3.4/16' },
    { address: '2001:db8:1::20', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '2001:db8:1::20/64', scopeid: 0 },
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: 'fe80::1/64', scopeid: 5 },
    { address: 'fd12:3456::7', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: 'fd12:3456::7/64', scopeid: 0 },
  ],
  Ethernet: [{ address: '10.0.0.5', netmask: '255.0.0.0', family: 'IPv4', mac: '11:22:33:44:55:66', internal: false, cidr: '10.0.0.5/8' }],
};

describe('internetAddresses', () => {
  it('lists private IPv4 and global IPv6 only', () => {
    expect(internetAddresses(IFACES)).toEqual({ lanAddresses: ['192.168.1.20', '10.0.0.5'], globalIpv6: ['2001:db8:1::20'] });
    expect(internetAddresses({})).toEqual({ lanAddresses: [], globalIpv6: [] });
  });
});

describe('WindowsHostService: internet switch', () => {
  it('validates the handoff field', () => {
    const base: HostSetupHandoff = { version: 1, createdAt: new Date().toISOString(), sunshineAdminUser: 'lanplay', sunshineAdminPassword: PW, logDir: 'x', sharedData: 'y' };
    expect(validateHandoff(base).internet).toBeUndefined();
    expect(validateHandoff({ ...base, internet: true }).internet).toBe(true);
    expect(() => validateHandoff({ ...base, internet: 'yes' })).toThrow(/internet/);
  });

  it('getInternet is off by default and shows the PC addresses', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-inet-'));
    const { svc } = makeService(freshMachine(), makePaths(root), true, { networkInterfaces: () => IFACES });
    expect(await svc.getInternet()).toEqual({ enabled: false, lanAddresses: ['192.168.1.20', '10.0.0.5'], globalIpv6: ['2001:db8:1::20'] });
  });

  it('setInternet(true) then (false), already elevated: saves the setting, writes conf, adds and removes the rule', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-inet-'));
    const paths = makePaths(root);
    const m = freshMachine();
    const { svc, deps, settings } = makeService(m, paths, true, { networkInterfaces: () => IFACES });
    await deps.secrets.set('sunshine-admin-password', PW);
    mock = await startMockSunshine({ password: PW });

    const progress: string[] = [];
    const on = await svc.setInternet(true, (s) => progress.push(s.stepId));
    expect(on).toMatchObject({ enabled: true, lanAddresses: ['192.168.1.20', '10.0.0.5'] });
    expect(on.lastError).toBeUndefined();
    expect(settings.get<boolean>(INTERNET_KEY, false)).toBe(true);
    expect(progress).toContain('firewall-internet');
    expect(conf(m)).toMatchObject({ upnp: 'enabled', address_family: 'both', origin_web_ui_allowed: 'pc' });
    expect(internetRules(m)).toHaveLength(2);
    expect(m.service?.state).toBe('Running');
    // the saved setup status lists the new step in order
    const st = await svc.setupStatus();
    expect(st.steps.map((x) => x.stepId)).toEqual([...HOST_STEP_ORDER]);
    expect(st.steps.find((x) => x.stepId === 'firewall-internet')!.status).toBe('pass');
    // self-check probes the rule too
    const rep = await svc.selfCheck();
    expect(rep.steps.find((x) => x.stepId === 'firewall-internet')!.status).toBe('pass');

    const off = await svc.setInternet(false, () => undefined);
    expect(off.enabled).toBe(false);
    expect(settings.get<boolean>(INTERNET_KEY, true)).toBe(false);
    expect(conf(m)).toMatchObject({ upnp: 'disabled', address_family: 'ipv4' });
    expect(internetRules(m)).toEqual([]);
  });

  it('through UAC the handoff carries the switch and the elevated child applies it from the handoff alone', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-inet-'));
    const paths = makePaths(root);
    const temp = path.join(root, 'tmp');
    mkdirSync(temp, { recursive: true });
    const m = freshMachine();
    const parent = makeService(m, paths, false, { tempDir: temp, networkInterfaces: () => IFACES });
    const child = makeService(m, paths, true, {}, LANPLAY.elevatedLogFilePattern);
    expect(child.settings.get<boolean>(INTERNET_KEY, false)).toBe(false); // the child's own settings say off
    let seen: HostSetupHandoff | null = null;
    parent.runner.onInvokeElevated = async (_file, b64) => {
      const argv = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as string[];
      const handoffFile = argv[argv.indexOf('--handoff') + 1]!.replace(/^"|"$/g, '');
      const resultFile = argv[argv.indexOf('--result') + 1]!.replace(/^"|"$/g, '');
      seen = JSON.parse(readFileSync(handoffFile, 'utf8')) as HostSetupHandoff;
      const code = await child.svc.runElevatedSetup(handoffFile, resultFile);
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ exitCode: code, cancelled: false }), stderr: '', durationMs: 1, timedOut: false };
    };
    const pw = 'a-long-random-admin-password-0123456789';
    await parent.deps.secrets.set('sunshine-admin-password', pw);
    mock = await startMockSunshine({ password: pw });
    const on = await parent.svc.setInternet(true, () => undefined);
    expect(seen).toMatchObject({ internet: true });
    expect(on.enabled).toBe(true);
    expect(conf(m)).toMatchObject({ upnp: 'enabled', address_family: 'both' });
    expect(internetRules(m)).toHaveLength(2);
  });

  it('a cancelled UAC prompt puts the switch back and says why', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-inet-'));
    const m = freshMachine();
    const parent = makeService(m, makePaths(root), false, { tempDir: root, networkInterfaces: () => IFACES });
    parent.runner.onInvokeElevated = async () => ({ exitCode: 1, signal: null, stdout: JSON.stringify({ error: 'The operation was canceled by the user.', exitCode: null, cancelled: true }), stderr: '', durationMs: 1, timedOut: false });
    const st = await parent.svc.setInternet(true, () => undefined);
    expect(st.enabled).toBe(false);
    expect(st.lastError).toMatch(/admin prompt was cancelled/);
    expect(parent.settings.get<boolean>(INTERNET_KEY, true)).toBe(false);
    expect(internetRules(m)).toEqual([]);
  });

  it('a failing firewall step puts the switch back to where it was', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-inet-'));
    const m = freshMachine();
    const { svc, deps, settings, runner } = makeService(m, makePaths(root), true, { networkInterfaces: () => IFACES });
    await deps.secrets.set('sunshine-admin-password', PW);
    mock = await startMockSunshine({ password: PW });
    const realRun = runner.run.bind(runner);
    runner.run = async (req) => (req.args.some((a) => a.endsWith('set-internet-firewall-rule.ps1')) ? { exitCode: 1, signal: null, stdout: '{"error":"Access is denied."}', stderr: '', durationMs: 1, timedOut: false } : realRun(req));
    const st = await svc.setInternet(true, () => undefined);
    expect(st.enabled).toBe(false);
    expect(st.lastError).toMatch(/Access is denied/);
    expect(settings.get<boolean>(INTERNET_KEY, true)).toBe(false);
    // the failed enable had already written UPnP and IPv6: the steps ran again with the switch off, so the PC says off too
    expect(conf(m)).toMatchObject({ upnp: 'disabled', address_family: 'ipv4' });
    expect(internetRules(m)).toEqual([]);
    expect((await svc.setupStatus()).steps.find((x) => x.stepId === 'config')!.status).toBe('pass');
    // the next try clears the old error
    runner.run = realRun;
    const again = await svc.setInternet(true, () => undefined);
    expect(again.enabled).toBe(true);
    expect(again.lastError).toBeUndefined();
    expect(conf(m)).toMatchObject({ upnp: 'enabled', address_family: 'both' });
  });

  it('a failed enable runs the steps a second time with the switch off, and says so when that fails too', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-inet-'));
    const m = freshMachine();
    const { svc, deps, settings, runner } = makeService(m, makePaths(root), true, { networkInterfaces: () => IFACES });
    await deps.secrets.set('sunshine-admin-password', PW);
    mock = await startMockSunshine({ password: PW });
    let ruleCalls = 0;
    const realRun = runner.run.bind(runner);
    // every call of the rule script fails, including the removal in the second run
    runner.run = async (req) => {
      if (!req.args.some((a) => a.endsWith('set-internet-firewall-rule.ps1'))) return realRun(req);
      ruleCalls++;
      return { exitCode: 1, signal: null, stdout: '{"error":"Access is denied."}', stderr: '', durationMs: 1, timedOut: false };
    };
    const progress: string[] = [];
    const st = await svc.setInternet(true, (r) => progress.push(r.stepId));
    expect(st.enabled).toBe(false);
    expect(settings.get<boolean>(INTERNET_KEY, true)).toBe(false);
    expect(st.lastError).toMatch(/^.*Access is denied/);
    expect(progress.filter((id) => id === 'config')).toHaveLength(1); // only the first run reports progress
    expect(conf(m)).toMatchObject({ upnp: 'disabled', address_family: 'ipv4' });
    expect(ruleCalls).toBe(1); // off with no rule on the PC needs no PowerShell call
    expect(st.lastError).not.toMatch(/also failed/);
  });
});
