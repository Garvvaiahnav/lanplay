import dgram from 'node:dgram';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LANPLAY } from '../../src/contracts.js';
import type { AgentDiscoveryReply, SunshineClient } from '../../src/contracts.js';
import { AUTO_APPROVE_KEY, isAllowedHost, LanPairAgent, LEDGER_KEY, parsePairRequest, RateLimiter, sanitizeClientName } from '../../src/core/host/agent.js';
import { createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { startMockSunshine, SUNSHINE_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

const identity = () => ({ hostName: 'Gaming-PC', addresses: ['127.0.0.1', '192.168.1.10', '::1'] });

interface Ctx {
  agent: LanPairAgent;
  mock: MockSunshine;
  settings: MemoryStore;
  log: MemoryLogger;
  port: number;
}
let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.agent.stop();
  await ctx?.mock.close();
  ctx = undefined;
});

async function setup(opts: { autoApprove?: boolean; sunshine?: SunshineClient; approvalTimeoutMs?: number; udp?: boolean } = {}): Promise<Ctx> {
  const mock = await startMockSunshine();
  const settings = new MemoryStore();
  if (opts.autoApprove === false) settings.set(AUTO_APPROVE_KEY, false);
  const log = new MemoryLogger();
  const sunshine = opts.sunshine ?? createSunshineClient({ baseUrl: mock.url, username: 'lanplay', getPassword: async () => 'test-password-0123456789', pinnedCertPem: SUNSHINE_TEST_CERT, timeoutMs: 5000 });
  const agent = new LanPairAgent(
    { port: 0, sunshine, log, settings, localIdentity: identity },
    { bindAddress: '127.0.0.1', pendingPollMs: 20, pendingWaitMs: 400, udp: opts.udp ?? false, ...(opts.approvalTimeoutMs ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}) },
  );
  await agent.start();
  ctx = { agent, mock, settings, log, port: agent.getState().port };
  return ctx;
}

function call(port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const pairBody = (pin = '4821', clientName = 'Mac mini') => JSON.stringify({ pin, clientName, clientId: '6f1c2b8e-1d2a-4c55-9b7e-0a1b2c3d4e5f' });
const JSON_CT = { 'Content-Type': 'application/json' };

describe('agent pure guards', () => {
  it('validates pair requests', () => {
    expect(parsePairRequest({ pin: '0042', clientName: ' Mac  mini ', clientId: '6f1c2b8e-1d2a' })).toEqual({ pin: '0042', clientName: 'Mac mini', clientId: '6f1c2b8e-1d2a' });
    expect(parsePairRequest({ pin: '42', clientName: 'x', clientId: '6f1c2b8e-1d2a' })).toHaveProperty('error');
    expect(parsePairRequest({ pin: '0042', clientName: '<script>', clientId: '6f1c2b8e-1d2a' })).toHaveProperty('error');
    expect(parsePairRequest({ pin: '0042', clientName: 'x', clientId: 'a' })).toHaveProperty('error');
    expect(parsePairRequest([])).toHaveProperty('error');
    expect(sanitizeClientName('Jörg’s Mac')).toBeNull();
    expect(sanitizeClientName('Jörg Mac 山田')).toBe('Jörg Mac 山田');
    expect(sanitizeClientName('x'.repeat(65))).toBeNull();
  });

  it('checks Host headers against local identity', () => {
    const id = identity();
    expect(isAllowedHost('192.168.1.10:47920', 47920, id)).toBe(true);
    expect(isAllowedHost('gaming-pc.local:47920', 47920, id)).toBe(true);
    expect(isAllowedHost('GAMING-PC:47920', 47920, id)).toBe(true);
    expect(isAllowedHost('[::1]:47920', 47920, id)).toBe(true);
    expect(isAllowedHost('192.168.1.10', 47920, id)).toBe(false);
    expect(isAllowedHost('evil.example:47920', 47920, id)).toBe(false);
    expect(isAllowedHost('192.168.1.10:80', 47920, id)).toBe(false);
  });

  it('rate limiter refills over time', () => {
    let t = 0;
    const rl = new RateLimiter(2, 100, () => t);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(true);
    const r = rl.take('a');
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect(rl.take('b').ok).toBe(true);
    t += 30_000;
    expect(rl.take('a').ok).toBe(true);
  });
});

describe('agent HTTP guards', () => {
  it('serves /v1/info', async () => {
    const { port } = await setup();
    const r = await call(port, 'GET', '/v1/info');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ hostName: 'Gaming-PC', sunshineVersion: '2026.914.233613', autoApprove: true, ready: true });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects bad Host (DNS rebinding)', async () => {
    const { port } = await setup();
    expect((await call(port, 'GET', '/v1/info', undefined, { Host: `attacker.example:${port}` })).status).toBe(421);
    expect((await call(port, 'GET', '/v1/info', undefined, { Host: `127.0.0.1:1` })).json).toEqual({ error: 'bad-host' });
  });

  it('rejects any Origin or Referer (CSRF), including "null"', async () => {
    const { port } = await setup();
    for (const h of [{ Origin: 'http://evil.example' }, { Origin: 'null' }, { Referer: 'http://192.168.1.10/' }]) {
      const r = await call(port, 'POST', '/v1/pair', pairBody(), { ...JSON_CT, ...h });
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: 'browser-origin' });
    }
  });

  it('rejects OPTIONS, non-JSON content types, big bodies, bad JSON and bad fields', async () => {
    const { port } = await setup();
    expect((await call(port, 'OPTIONS', '/v1/pair')).status).toBe(405);
    expect((await call(port, 'POST', '/v1/pair', pairBody(), { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await call(port, 'POST', '/v1/pair', pairBody(), { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await call(port, 'POST', '/v1/pair', 'x'.repeat(5000), JSON_CT)).status).toBe(413);
    expect((await call(port, 'POST', '/v1/pair', '{nope', JSON_CT)).status).toBe(400);
    expect((await call(port, 'POST', '/v1/pair', pairBody('12a4'), JSON_CT)).json.error).toBe('bad-request');
    expect((await call(port, 'GET', '/v1/nothing')).status).toBe(404);
    expect((await call(port, 'GET', '/v1/pair')).status).toBe(405);
  });

  it('rate limits POSTs per IP with Retry-After', async () => {
    const { port } = await setup();
    const statuses: number[] = [];
    let retry: string | undefined;
    for (let i = 0; i < LANPLAY.agentRateLimit.perIpPerMinute + 1; i++) {
      const r = await call(port, 'POST', '/v1/pair', '{bad', JSON_CT);
      statuses.push(r.status);
      if (r.status === 429) retry = r.headers['retry-after'] as string;
    }
    expect(statuses.slice(0, LANPLAY.agentRateLimit.perIpPerMinute).every((s) => s === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });
});

describe('agent pairing flow', () => {
  it('auto-approve: finds the pending pairing by address and submits the PIN', async () => {
    const { port, mock, settings, agent, log } = await setup();
    mock.addPending({ name: 'Moonlight', address: '10.9.9.9', expectedPin: '0000' }); // someone else
    setTimeout(() => mock.addPending({ name: 'Moonlight', address: '127.0.0.1', expectedPin: '4821' }), 60);
    const r = await call(port, 'POST', '/v1/pair', pairBody('4821'), JSON_CT);
    expect(r.json).toEqual({ status: 'paired', sunshineClientName: 'Mac mini' });
    const devices = await agent.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ name: 'Mac mini', pairedVia: 'lanplay', lastAddress: '127.0.0.1' });
    expect(settings.get<unknown[]>(LEDGER_KEY, [])).toHaveLength(1);
    // the other device's pending pairing was not touched
    expect(mock.pending.map((p) => p.address)).toEqual(['10.9.9.9']);
    // logs never contain the PIN
    expect(JSON.stringify(log.entries)).not.toContain('4821');
    await agent.revoke(devices[0]!.uuid);
    expect(await agent.listDevices()).toHaveLength(0);
    expect(settings.get<unknown[]>(LEDGER_KEY, [])).toHaveLength(0);
  });

  it('refuses when no pending pairing comes from the requester address', async () => {
    const { port, mock } = await setup();
    mock.addPending({ name: 'Moonlight', address: '192.168.1.99', expectedPin: '4821' });
    const r = await call(port, 'POST', '/v1/pair', pairBody('4821'), JSON_CT);
    expect(r.json.status).toBe('failed');
    expect(r.json.code).toBe('no-pending-pairing');
    expect(r.json.message).toContain('192.168.1.99');
    expect(mock.clients).toHaveLength(0);
  });

  it('matches an IPv4-mapped pending address', async () => {
    const { port, mock } = await setup();
    mock.addPending({ name: 'Moonlight', address: '::ffff:127.0.0.1', expectedPin: '1111' });
    expect((await call(port, 'POST', '/v1/pair', pairBody('1111'), JSON_CT)).json.status).toBe('paired');
  });

  it('reports wrong PIN', async () => {
    const { port, mock } = await setup();
    mock.addPending({ name: 'Moonlight', address: '127.0.0.1', expectedPin: '1111' });
    const r = await call(port, 'POST', '/v1/pair', pairBody('2222'), JSON_CT);
    expect(r.json).toMatchObject({ status: 'failed', code: 'wrong-pin' });
  });

  it('reports sunshine-not-ready on auth failure', async () => {
    const mock0 = await startMockSunshine();
    const bad = createSunshineClient({ baseUrl: mock0.url, username: 'lanplay', getPassword: async () => 'nope', pinnedCertPem: SUNSHINE_TEST_CERT, timeoutMs: 2000 });
    const { port } = await setup({ sunshine: bad });
    const r = await call(port, 'POST', '/v1/pair', pairBody(), JSON_CT);
    expect(r.json).toMatchObject({ status: 'failed', code: 'sunshine-not-ready' });
    const info = await call(port, 'GET', '/v1/info');
    expect(info.json.ready).toBe(false);
    await mock0.close();
  });

  it('manual approval: pending -> approve -> paired; deny; timeout', async () => {
    const { port, mock, agent } = await setup({ autoApprove: false, approvalTimeoutMs: 300 });
    const states: number[] = [];
    agent.onChange((s) => states.push(s.pending.length));
    mock.addPending({ name: 'Moonlight', address: '127.0.0.1', expectedPin: '4821' });
    const r = await call(port, 'POST', '/v1/pair', pairBody('4821'), JSON_CT);
    expect(r.status).toBe(202);
    expect(r.json.status).toBe('pending-approval');
    expect(agent.getState().pending).toHaveLength(1);
    expect(agent.getState().pending[0]).toMatchObject({ clientName: 'Mac mini', remoteAddress: '127.0.0.1' });
    expect((await call(port, 'GET', `/v1/pair/${r.json.requestId}`)).status).toBe(202);
    await agent.decide(r.json.requestId, true);
    let st;
    for (let i = 0; i < 50; i++) {
      st = await call(port, 'GET', `/v1/pair/${r.json.requestId}`);
      if (st.status === 200) break;
      await new Promise((x) => setTimeout(x, 20));
    }
    expect(st!.json).toEqual({ status: 'paired', sunshineClientName: 'Mac mini' });
    expect(states.length).toBeGreaterThan(0);

    const r2 = await call(port, 'POST', '/v1/pair', pairBody('1234', 'Other Mac'), JSON_CT);
    await agent.decide(r2.json.requestId, false);
    expect((await call(port, 'GET', `/v1/pair/${r2.json.requestId}`)).json).toEqual({ status: 'denied' });
    await expect(agent.decide(r2.json.requestId, true)).rejects.toThrow();

    const r3 = await call(port, 'POST', '/v1/pair', pairBody('1234', 'Slow Mac'), JSON_CT);
    await new Promise((x) => setTimeout(x, 400));
    expect((await call(port, 'GET', `/v1/pair/${r3.json.requestId}`)).json).toMatchObject({ status: 'failed', code: 'approval-timeout' });
    expect((await call(port, 'GET', `/v1/pair/unknown-id`)).status).toBe(404);
  });

  it('persists the auto-approve switch (default ON)', async () => {
    const { agent, settings } = await setup();
    expect(agent.getState().autoApprove).toBe(true);
    await agent.setAutoApprove(false);
    expect(settings.get(AUTO_APPROVE_KEY, true)).toBe(false);
    expect(agent.getState().autoApprove).toBe(false);
  });
});

describe('agent UDP discovery', () => {
  it('answers the magic probe with AgentDiscoveryReply', async () => {
    const { port } = await setup({ udp: true });
    const sock = dgram.createSocket('udp4');
    const reply = await new Promise<AgentDiscoveryReply>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no reply')), 2000);
      sock.on('message', (m) => {
        clearTimeout(t);
        resolve(JSON.parse(m.toString()) as AgentDiscoveryReply);
      });
      sock.send(Buffer.from('nope'), port, '127.0.0.1');
      sock.send(Buffer.from(LANPLAY.agentDiscoveryMagic), port, '127.0.0.1');
    });
    sock.close();
    expect(reply).toMatchObject({ magic: LANPLAY.agentDiscoveryMagic, hostName: 'Gaming-PC', agentPort: port, sunshineHttpPort: 47989, addresses: ['192.168.1.10'] });
  });

  it('reports EADDRINUSE as lastError', async () => {
    const { port, log } = await setup();
    const second = new LanPairAgent({ port, sunshine: {} as SunshineClient, log, settings: new MemoryStore(), localIdentity: identity }, { bindAddress: '127.0.0.1', udp: false });
    await expect(second.start()).rejects.toThrow();
    expect(second.getState().lastError).toMatch(/Cannot listen/);
  });
});
