// Client flows end to end on one machine: fake moonlight CLI (real spawn) -> LanPlay pair agent (real HTTP/UDP on
// 127.0.0.1) -> mock Sunshine (real HTTPS, pinned cert). Only the Moonlight binary and Sunshine are fakes.
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STREAM_SETTINGS, SCM } from '../../src/contracts.js';
import type { AppPaths, HostInfo, PairProgress, ServiceDeps, StreamState } from '../../src/contracts.js';
import { LanDiscovery } from '../../src/core/client/discovery.js';
import type { DiscoveryDeps } from '../../src/core/client/discovery.js';
import { createMoonlightRunner } from '../../src/core/client/moonlight.js';
import { ClientPairingService } from '../../src/core/client/pairing.js';
import { fetchServerInfo } from '../../src/core/client/serverinfo.js';
import { MacClientService } from '../../src/core/client/service.js';
import { AUTO_APPROVE_KEY, LanPairAgent } from '../../src/core/host/agent.js';
import { createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { NodeProcessRunner } from '../../src/core/shared/exec.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { tcpProbe } from '../../src/core/shared/netprobe.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { startMockSunshine, SUNSHINE_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

const FAKE_ML = path.resolve(__dirname, '..', 'fixtures', 'fake-moonlight.mjs');
const SERVERINFO = (scms: number) =>
  `<?xml version="1.0" encoding="utf-8"?><root status_code="200"><hostname>Gaming-PC</hostname><uniqueid>0123456789ABCDEF</uniqueid><HttpsPort>47984</HttpsPort><ServerCodecModeSupport>${scms}</ServerCodecModeSupport></root>`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function world(opts: { autoApprove?: boolean; mode?: string; scms?: number } = {}) {
  const mock: MockSunshine = await startMockSunshine();
  cleanups.push(() => mock.close());
  const log = new MemoryLogger();
  const hostSettings = new MemoryStore();
  if (opts.autoApprove === false) hostSettings.set(AUTO_APPROVE_KEY, false);
  const agent = new LanPairAgent(
    {
      port: 0,
      sunshine: createSunshineClient({ baseUrl: mock.url, username: 'lanplay', getPassword: async () => 'test-password-0123456789', pinnedCertPem: SUNSHINE_TEST_CERT, timeoutMs: 5000 }),
      log: log.child('agent'),
      settings: hostSettings,
      localIdentity: () => ({ hostName: 'Gaming-PC', addresses: ['127.0.0.1'] }),
    },
    { bindAddress: '127.0.0.1', pendingPollMs: 25, pendingWaitMs: 1500, approvalTimeoutMs: 3000 },
  );
  await agent.start();
  cleanups.push(() => agent.stop());
  const serverinfo = http.createServer((req, res) => {
    if (req.url === '/serverinfo') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(SERVERINFO(opts.scms ?? SCM.H264 | SCM.HEVC | SCM.AV1_MAIN8));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => serverinfo.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => serverinfo.close(() => r())));
  const sunshinePort = (serverinfo.address() as AddressInfo).port;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-client-'));
  const stateFile = path.join(dir, 'moonlight-state.json');
  const env: Record<string, string> = { FAKE_ML_STATE: stateFile, FAKE_ML_HOOK: mock.hookUrl, FAKE_ML_MODE: opts.mode ?? 'normal' };
  const agentPort = agent.getState().port;
  const discoveryDeps: Partial<DiscoveryDeps> = {
    fetchServerInfo: (h, p) => fetchServerInfo(h, p),
    mdns: null,
    udpTargets: () => ['127.0.0.1'],
    agentPort,
    probeHosts: () => ['127.0.0.1'],
    tcpProbe,
    sunshinePort,
    probeDelayMs: 200,
    udpRepeatMs: 60_000,
  };
  return { mock, log, agent, agentPort, sunshinePort, stateFile, env, discoveryDeps, dir };
}

const state = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { paired: Record<string, boolean>; calls: string[][]; streams: string[][] };

function hostInfo(sunshinePort: number): HostInfo {
  return { id: '0123456789ABCDEF', name: 'Gaming-PC', addresses: ['127.0.0.1'], preferredAddress: '127.0.0.1', sources: ['manual'], httpPort: sunshinePort, lastSeen: new Date().toISOString(), serverCodecModeSupport: SCM.HEVC | SCM.AV1_MAIN8 };
}

function pairing(w: Awaited<ReturnType<typeof world>>) {
  const moonlight = createMoonlightRunner({ binary: process.execPath, prefixArgs: [FAKE_ML], runner: new NodeProcessRunner(), log: w.log, env: w.env });
  return new ClientPairingService({
    moonlight,
    log: w.log.child('pair'),
    clientName: () => 'Mac mini',
    clientId: () => '6f1c2b8e-1d2a-4c55-9b7e-0a1b2c3d4e5f',
    agentPort: w.agentPort,
    pin: () => '4821',
    timing: { postSuccessFlushMs: 150, terminateGraceMs: 500, overallTimeoutMs: 15_000, approvalPollMs: 50 },
  });
}

describe('pairing end to end (fake Moonlight + real agent + mock Sunshine)', () => {
  it('pairs without typing a PIN and verifies with `list`', async () => {
    const w = await world();
    const phases: PairProgress['phase'][] = [];
    const r = await pairing(w).pair(hostInfo(w.sunshinePort), (p) => phases.push(p.phase));
    expect(r).toMatchObject({ ok: true, alreadyPaired: false });
    expect(phases).toEqual(['checking', 'starting-moonlight', 'contacting-agent', 'confirming', 'verifying', 'done']);
    const st = state(w.stateFile);
    expect(st.paired['127.0.0.1']).toBe(true);
    expect(st.calls.map((c) => c[0])).toEqual(['list', 'pair', 'list']);
    expect(st.calls[1]).toEqual(['pair', '127.0.0.1', '--pin', '4821']);
    expect(w.mock.clients.map((c) => c.name)).toEqual(['Mac mini']);
    expect(JSON.stringify(w.log.entries)).not.toContain('4821');
    // the Sunshine POST carried the pairing_id it got from GET /api/pin
    const post = w.mock.requests.find((q) => q.method === 'POST' && q.url === '/api/pin')!;
    expect(JSON.parse(post.body)).toMatchObject({ pin: '4821', name: 'Mac mini' });
    // second time: already paired, no Moonlight pair window
    const again = await pairing(w).pair(hostInfo(w.sunshinePort), () => undefined);
    expect(again).toMatchObject({ ok: true, alreadyPaired: true });
  });

  it('reports Moonlight crashing', async () => {
    const w = await world({ mode: 'crash' });
    const r = await pairing(w).pair(hostInfo(w.sunshinePort), () => undefined);
    expect(r).toMatchObject({ ok: false, code: 'moonlight-failed' });
    if (!r.ok) expect(r.message).toMatch(/Failed to connect/);
  });

  it('reports no-pending-pairing when Sunshine never saw Moonlight', async () => {
    const w = await world({ mode: 'no-register' });
    const r = await pairing(w).pair(hostInfo(w.sunshinePort), () => undefined);
    expect(r).toMatchObject({ ok: false, code: 'no-pending-pairing', retryable: true });
  });

  it('reports agent-unreachable', async () => {
    const w = await world();
    await w.agent.stop();
    const r = await pairing(w).pair(hostInfo(w.sunshinePort), () => undefined);
    expect(r).toMatchObject({ ok: false, code: 'agent-unreachable' });
    if (!r.ok) expect(r.message).toMatch(/Cannot reach LanPlay on the PC/);
  });

  it('waits for manual approval on the PC', async () => {
    const w = await world({ autoApprove: false });
    const off = w.agent.onChange((s) => {
      const p = s.pending[0];
      if (p) {
        off();
        void w.agent.decide(p.requestId, true);
      }
    });
    const phases: string[] = [];
    const r = await pairing(w).pair(hostInfo(w.sunshinePort), (p) => phases.push(p.phase));
    expect(r.ok).toBe(true);
    expect(phases).toContain('waiting-approval');
  });

  it('reports a denial', async () => {
    const w = await world({ autoApprove: false });
    const off = w.agent.onChange((s) => {
      const p = s.pending[0];
      if (p) {
        off();
        void w.agent.decide(p.requestId, false);
      }
    });
    const r = await pairing(w).pair(hostInfo(w.sunshinePort), () => undefined);
    expect(r).toMatchObject({ ok: false, code: 'approval-denied', retryable: false });
  });
});

describe('discovery', () => {
  it('finds the PC via the agent UDP probe and confirms via /serverinfo', async () => {
    const w = await world();
    const log = new MemoryLogger();
    const d = new LanDiscovery({ ...(await import('../../src/core/client/discovery.js')).defaultDiscoveryDeps(log), ...w.discoveryDeps, probeDelayMs: 60_000 });
    const found = await new Promise<HostInfo[]>((resolve) => d.start((h) => h.length && resolve(h)));
    d.stop();
    expect(found[0]).toMatchObject({ id: '0123456789ABCDEF', name: 'Gaming-PC', preferredAddress: '127.0.0.1', agentReachable: true });
    expect(found[0]!.sources).toContain('agent-udp');
  });

  it('falls back to the port probe, and supports manual entry + mDNS', async () => {
    const w = await world();
    const log = new MemoryLogger();
    const base = (await import('../../src/core/client/discovery.js')).defaultDiscoveryDeps(log);
    const d = new LanDiscovery({ ...base, ...w.discoveryDeps, udpTargets: () => [], agentPort: 1 });
    const found = await new Promise<HostInfo[]>((resolve) => d.start((h) => h.length && resolve(h)));
    d.stop();
    expect(found[0]!.sources).toEqual(['port-probe']);
    expect(found[0]!.agentReachable).toBe(false);

    const m = new LanDiscovery({
      ...base,
      ...w.discoveryDeps,
      udpTargets: () => [],
      probeDelayMs: 60_000,
      mdns: { start: (cb) => setTimeout(() => cb({ name: 'Sunshine', addresses: ['127.0.0.1', '::1'], port: 47989 }), 10), stop: () => undefined },
    });
    const viaMdns = await new Promise<HostInfo[]>((resolve) => m.start((h) => h.length && resolve(h)));
    expect(viaMdns[0]!.sources).toContain('mdns');
    const manual = await m.addManual(' 127.0.0.1 ');
    m.stop();
    expect(manual.sources).toEqual(expect.arrayContaining(['mdns', 'manual']));
    await expect(m.addManual('bad host/name')).rejects.toThrow(/IP address/);
    await expect(m.addManual('10.255.255.1')).rejects.toThrow(/No Sunshine host/);
  }, 20_000);
});

describe('MacClientService', () => {
  function service(w: Awaited<ReturnType<typeof world>>, cpuModel = 'Apple M4') {
    const paths: AppPaths = { logDir: w.dir, userData: w.dir, sharedData: w.dir, resources: w.dir, vendorDir: w.dir, psDir: w.dir, diagnosticsOutDir: w.dir, logDirFellBack: false };
    const deps: ServiceDeps = { log: w.log, paths, secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined, backend: () => 'keychain' }, settings: new MemoryStore(), runner: new NodeProcessRunner() };
    return new MacClientService(deps, {
      moonlightBinary: process.execPath,
      prefixArgs: [FAKE_ML],
      moonlightEnv: w.env,
      cpuModel,
      discovery: { ...w.discoveryDeps, probeDelayMs: 60_000 },
      pairing: { agentPort: w.agentPort, timing: { postSuccessFlushMs: 100, terminateGraceMs: 500, overallTimeoutMs: 15_000 } },
      streamStartupMs: 300,
      selfCheckDiscoveryMs: 800,
    });
  }

  it('pairs, then streams with the resolved codec (AV1 on M4 when the host offers it)', async () => {
    const w = await world();
    const svc = service(w);
    const h = await svc.discovery.addManual('127.0.0.1');
    const pr = await svc.pair(h.id, () => undefined);
    expect(pr.ok).toBe(true);
    expect(svc.discovery.get(h.id)?.paired).toBe(true);
    const states: StreamState[] = [];
    const st = await svc.startStream(h.id, { ...DEFAULT_STREAM_SETTINGS, presetId: 'custom', bitrateMbps: 9999 }, (s) => states.push(s));
    expect(['ended', 'running']).toContain(st.state);
    const argv = state(w.stateFile).streams[0]!;
    expect(argv.slice(0, 3)).toEqual(['stream', '127.0.0.1', 'Desktop']);
    expect(argv[argv.indexOf('--video-codec') + 1]).toBe('AV1');
    expect(argv[argv.indexOf('--bitrate') + 1]).toBe('150000'); // clamped
    expect(svc.getSettings().bitrateMbps).toBe(150);
    const info = await svc.systemInfo();
    expect(info.chip.generation).toBe(4);
    expect(info.moonlightPath).toBe(process.execPath);
  });

  it('uses HEVC on an M1 and reports an instant Moonlight failure', async () => {
    const w = await world();
    const svc = service(w, 'Apple M1');
    const h = await svc.discovery.addManual('127.0.0.1');
    await svc.startStream(h.id, DEFAULT_STREAM_SETTINGS, () => undefined);
    const argv = state(w.stateFile).streams[0]!;
    expect(argv[argv.indexOf('--video-codec') + 1]).toBe('HEVC');
    const broken = new MacClientService(
      { log: w.log, paths: { logDir: w.dir, userData: w.dir, sharedData: w.dir, resources: w.dir, vendorDir: w.dir, psDir: w.dir, diagnosticsOutDir: w.dir, logDirFellBack: false }, secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined, backend: () => 'keychain' }, settings: new MemoryStore(), runner: new NodeProcessRunner() },
      { moonlightBinary: '/nonexistent/Moonlight', discovery: { ...w.discoveryDeps, probeDelayMs: 60_000 }, streamStartupMs: 300 },
    );
    const h2 = await broken.discovery.addManual('127.0.0.1');
    const st = await broken.startStream(h2.id, DEFAULT_STREAM_SETTINGS, () => undefined);
    expect(st.state).toBe('failed');
    expect(st.message).toMatch(/could not start/);
  });

  it('self-check reports each step', async () => {
    const w = await world();
    const svc = service(w);
    const rep = await svc.selfCheck();
    expect(rep.role).toBe('client');
    const ids = rep.steps.map((s) => s.stepId);
    expect(ids.slice(0, 5)).toEqual(['chip', 'moonlight', 'network', 'log-dir', 'discovery']);
    expect(rep.steps.find((s) => s.stepId === 'discovery')!.status).toBe('pass');
  });
});
