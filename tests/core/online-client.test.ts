// Internet play, client side (release plan 0.5, section 2): typed public addresses, code pairing, error texts, Internet preset.
// D11 (checked by hand against the bundled Moonlight 6.2.0 and a local fake Sunshine on a non-default port): `list`, `pair` and
// `stream` accept `ip:port` and `[v6]:port`, so a port is passed through to Moonlight.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STREAM_SETTINGS, PRESETS } from '../../src/contracts.js';
import type { HostInfo, PairProgress, ServiceDeps } from '../../src/contracts.js';
import { defaultDiscoveryDeps, LanDiscovery } from '../../src/core/client/discovery.js';
import type { DiscoveryDeps } from '../../src/core/client/discovery.js';
import { assertHostArg, buildListArgs, buildPairArgs, buildStreamArgs, createMoonlightRunner, moonlightTarget } from '../../src/core/client/moonlight.js';
import { ClientPairingService } from '../../src/core/client/pairing.js';
import { describeInternetProbeError, fetchServerInfo } from '../../src/core/client/serverinfo.js';
import type { ServerInfo } from '../../src/core/client/serverinfo.js';
import { MacClientService, RECENT_REMOTE_KEY, UDP_HINT } from '../../src/core/client/service.js';
import { applyPreset, clampBitrate, matchingPreset, normalizeStreamSettings } from '../../src/core/client/settings.js';
import { NodeProcessRunner } from '../../src/core/shared/exec.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { httpGet } from '../../src/core/shared/netprobe.js';
import { MemoryStore } from '../../src/core/shared/stores.js';

const FAKE_ML = path.resolve(__dirname, '..', 'fixtures', 'fake-moonlight.mjs');
const info = (uniqueId = 'UNIQ-REMOTE', hostname = 'Friend-PC'): ServerInfo => ({ hostname, uniqueId, httpsPort: 47984, serverCodecModeSupport: 259, appVersion: '7.1', state: 'SUNSHINE_SERVER_FREE' });
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

afterEach(() => {
  vi.restoreAllMocks();
});

function discovery(over: Partial<DiscoveryDeps> = {}) {
  const log = new MemoryLogger();
  const calls: Array<{ host: string; port: number; timeoutMs: number | undefined }> = [];
  const agentAsked: string[] = [];
  const deps: DiscoveryDeps = {
    ...defaultDiscoveryDeps(log),
    mdns: null,
    udpTargets: () => [],
    probeDelayMs: 60_000,
    udpRepeatMs: 60_000,
    fetchServerInfo: async (host, port, timeoutMs) => {
      calls.push({ host, port, timeoutMs });
      return info();
    },
    agentCheck: async (h) => {
      agentAsked.push(h);
      return false;
    },
    ...over,
  };
  return { d: new LanDiscovery(deps), calls, log, agentAsked };
}

describe('addManual: typed internet addresses', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7', 47989],
    ['203.0.113.7:47989', '203.0.113.7', 47989],
    ['203.0.113.7:50000', '203.0.113.7', 50000],
    ['[2001:db8::1]:47989', '2001:db8::1', 47989],
    ['2001:db8::1', '2001:db8::1', 47989],
    ['100.64.1.2', '100.64.1.2', 47989],
  ])('%s becomes a remote host', async (typed, ip, port) => {
    const { d, calls, agentAsked } = discovery();
    const h = await d.addManual(typed);
    expect(agentAsked).toEqual([]);
    expect(h).toMatchObject({ remote: true, preferredAddress: ip, addresses: [ip], httpPort: port, sources: ['manual'], name: 'Friend-PC' });
    expect(h.agentReachable).toBe(false);
    expect(calls).toEqual([{ host: ip, port, timeoutMs: 5000 }]);
    expect(d.list()).toEqual([h]);
  });

  it('a LAN address stays a LAN host: no remote flag, 2.5 s confirm, agent is asked', async () => {
    const asked: string[] = [];
    const { d, calls } = discovery({
      agentCheck: async (h) => {
        asked.push(h);
        return true;
      },
    });
    const h = await d.addManual('192.168.1.20');
    expect(h.remote).toBeUndefined();
    expect(h).toMatchObject({ id: 'UNIQ-REMOTE', agentReachable: true, httpPort: 47989 });
    expect(calls[0]).toEqual({ host: '192.168.1.20', port: 47989, timeoutMs: 2500 });
    expect(asked).toEqual(['192.168.1.20']);
  });

  it('refuses a custom port on a LAN address (Moonlight would be given the plain IP) and malformed input', async () => {
    const { d, calls } = discovery();
    await expect(d.addManual('192.168.1.20:50000')).rejects.toThrow('Custom ports are only supported for internet addresses. Use the plain IP.');
    await expect(d.addManual('192.168.1.20:47989')).resolves.toMatchObject({ preferredAddress: '192.168.1.20' });
    for (const bad of ['', 'bad host/name', '1.2.3.4:0', '1.2.3.4:99999', '[1.2.3.4]:47989', 'a b', 'user@1.2.3.4', '203.0.113.7/24']) {
      await expect(d.addManual(bad), bad).rejects.toThrow('Enter an IP address like 192.168.1.20 or a PC name.');
    }
    expect(calls).toHaveLength(1);
  });

  it('keeps an internet entry separate from a LAN entry with the same Sunshine id', async () => {
    const { d } = discovery();
    const lan = await d.addManual('192.168.1.20');
    const remote = await d.addManual('203.0.113.7');
    expect(remote.id).not.toBe(lan.id);
    const again = await d.addManual('203.0.113.7');
    expect(again.id).toBe(remote.id);
    const all = d.list();
    expect(all).toHaveLength(2);
    expect(all.find((h) => h.id === lan.id)).toMatchObject({ addresses: ['192.168.1.20'], preferredAddress: '192.168.1.20' });
    expect(all.find((h) => h.id === lan.id)!.remote).toBeUndefined();
    expect(all.find((h) => h.id === remote.id)).toMatchObject({ addresses: ['203.0.113.7'], remote: true });
  });

  it('tells the service about a new remote host, never about a LAN host', async () => {
    const seen: string[] = [];
    const { d } = discovery({ onRemoteHost: (_h, typed) => void seen.push(typed) });
    await d.addManual('192.168.1.20');
    await d.addManual(' 203.0.113.7:50000 ');
    expect(seen).toEqual(['203.0.113.7:50000']);
  });
});

describe('discovery sources stay private-only', () => {
  it('drops public mDNS answers and never fetches them', async () => {
    const asked: string[] = [];
    const { d } = discovery({
      fetchServerInfo: async (h) => {
        asked.push(h);
        return info('UNIQ-LAN');
      },
      agentCheck: async () => false,
      mdns: { start: (cb) => setTimeout(() => cb({ name: 'Sunshine', addresses: ['203.0.113.7', '2001:db8::1', '100.64.0.9', '192.168.77.5'], port: 47989 }), 5), stop: () => undefined },
    });
    d.start(() => undefined);
    await new Promise((r) => setTimeout(r, 80));
    d.stop();
    expect(asked).toEqual(['192.168.77.5']);
    expect(d.list().map((h) => h.addresses)).toEqual([['192.168.77.5']]);
    expect(d.list()[0]!.remote).toBeUndefined();
  });

  it('drops a UDP agent answer from a public source address', async () => {
    const asked: string[] = [];
    const sock = Object.assign(new EventEmitter(), {
      bind: (_p: number, cb: () => void) => cb(),
      setBroadcast: () => undefined,
      send: () => undefined,
      close: () => undefined,
    });
    vi.spyOn(dgram, 'createSocket').mockReturnValue(sock as unknown as dgram.Socket);
    const { d } = discovery({
      udpTargets: () => ['255.255.255.255'],
      fetchServerInfo: async (h) => {
        asked.push(h);
        return info('UNIQ-LAN');
      },
      agentCheck: async () => true,
    });
    d.start(() => undefined);
    const reply = Buffer.from(JSON.stringify({ magic: 'x' }));
    const magic = (await import('../../src/contracts.js')).LANPLAY.agentDiscoveryMagic;
    const msg = Buffer.from(JSON.stringify({ magic, hostName: 'Evil' }));
    sock.emit('message', msg, { address: '203.0.113.9', port: 47920, family: 'IPv4', size: msg.length });
    sock.emit('message', msg, { address: '2001:db8::5', port: 47920, family: 'IPv6', size: msg.length });
    sock.emit('message', reply, { address: '192.168.1.9', port: 47920, family: 'IPv4', size: reply.length });
    sock.emit('message', msg, { address: '192.168.1.9', port: 47920, family: 'IPv4', size: msg.length });
    await new Promise((r) => setTimeout(r, 30));
    d.stop();
    expect(asked).toEqual(['192.168.1.9']);
  });

  it('never port-probes or confirms a public address', async () => {
    const asked: string[] = [];
    const probed: string[] = [];
    const { d } = discovery({
      probeDelayMs: 10,
      probeHosts: () => ['203.0.113.7', '192.168.1.50'],
      tcpProbe: async (h) => {
        probed.push(h);
        return true;
      },
      fetchServerInfo: async (h) => {
        asked.push(h);
        return info('UNIQ-LAN');
      },
      agentCheck: async () => false,
    });
    d.start(() => undefined);
    await new Promise((r) => setTimeout(r, 120));
    d.stop();
    expect(probed).toContain('203.0.113.7');
    expect(asked).toEqual(['192.168.1.50']);
    expect(d.list().every((h) => h.remote === undefined && h.addresses.every((a) => a.startsWith('192.168.')))).toBe(true);
  });
});

describe('failure messages for a typed internet address (plan 2.6)', () => {
  const cases: Array<[string, string, number, unknown, string]> = [
    ['refused', '203.0.113.7', 47989, coded('ECONNREFUSED'), '203.0.113.7 answered but port 47989 is closed. On the host: switch on Allow connections from the internet and forward the ports, and check that Sunshine is running.'],
    ['refused, custom port', '203.0.113.7', 50000, coded('ECONNREFUSED'), '203.0.113.7 answered but port 50000 is closed. On the host: switch on Allow connections from the internet and forward the ports, and check that Sunshine is running.'],
    ['no answer', '203.0.113.7', 47989, coded('ETIMEDOUT', 'timeout'), "No answer from 203.0.113.7:47989. The IP is wrong, the host PC is off, the ports are not forwarded, or the host's provider uses CGNAT (no public IPv4). LanPlay cannot tell which from here."],
    ['no route (IPv6)', '2001:db8::1', 47989, coded('ENETUNREACH'), 'This computer has no route to 2001:db8::1. An IPv6 address needs IPv6 on both sides.'],
    ['host unreachable', '203.0.113.7', 47989, coded('EHOSTUNREACH'), 'This computer has no route to 203.0.113.7. An IPv6 address needs IPv6 on both sides.'],
    ['not Sunshine (HTTP)', '203.0.113.7', 47989, new Error('GET /serverinfo -> HTTP 404'), 'Something answered at 203.0.113.7:47989 but it is not Sunshine.'],
    ['not Sunshine (body)', '203.0.113.7', 47989, new Error('not a serverinfo XML document'), 'Something answered at 203.0.113.7:47989 but it is not Sunshine.'],
  ];
  it.each(cases)('%s', async (_n, ip, port, err, message) => {
    const { d } = discovery({
      fetchServerInfo: async () => {
        throw err;
      },
    });
    await expect(d.addManual(port === 47989 ? ip : `${ip}:${port}`)).rejects.toThrow(new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    expect(d.list()).toEqual([]);
  });

  it('an IPv6 address in the "no answer" text is bracketed', () => {
    expect(describeInternetProbeError(coded('ETIMEDOUT'), '2001:db8::1', 47989)).toMatch(/^No answer from \[2001:db8::1\]:47989\. /);
  });

  it('keeps the LAN wording for a private address', async () => {
    const { d } = discovery({
      fetchServerInfo: async () => {
        throw coded('ECONNREFUSED');
      },
    });
    await expect(d.addManual('192.168.1.20')).rejects.toThrow('No Sunshine host answered at 192.168.1.20:47989. Is LanPlay set up on the PC and is the PC on?');
  });

  it('the real HTTP client reports a silent server as ETIMEDOUT and a closed port as ECONNREFUSED', async () => {
    const silent = http.createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as AddressInfo).port;
    try {
      const e1 = await fetchServerInfo('127.0.0.1', port, 150).catch((e: unknown) => e);
      expect((e1 as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
      expect(describeInternetProbeError(e1, '203.0.113.7', 47989)).toMatch(/^No answer from 203\.0\.113\.7:47989\./);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((r) => silent.close(() => r()));
    }
    const e2 = await httpGet('127.0.0.1', port, '/serverinfo', 500).catch((e: unknown) => e);
    expect((e2 as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });
});

describe('Moonlight host argument', () => {
  it('accepts ip, ip:port and [v6]:port; refuses names, options and bad ports', () => {
    for (const ok of ['203.0.113.7', '203.0.113.7:47989', '203.0.113.7:65535', '[2001:db8::1]:47989', '2001:db8::1', 'fe80::1']) expect(assertHostArg(ok)).toBe(ok);
    for (const bad of ['gaming-pc.local', '--help', '-x', '203.0.113.7:0', '203.0.113.7:65536', '203.0.113.7:x', '[203.0.113.7]:47989', '[2001:db8::1]', '[2001:db8::1]:0', 'name:47989', '']) expect(() => assertHostArg(bad), bad).toThrow(/IP address/);
  });

  it('puts the port into pair, list and stream argv', () => {
    expect(buildPairArgs('203.0.113.7:50000', '0042')).toEqual(['pair', '203.0.113.7:50000', '--pin', '0042']);
    expect(buildListArgs('[2001:db8::1]:50000')).toEqual(['list', '[2001:db8::1]:50000']);
    expect(buildStreamArgs({ host: '203.0.113.7:50000', settings: DEFAULT_STREAM_SETTINGS, resolvedCodec: 'hevc' }).slice(0, 3)).toEqual(['stream', '203.0.113.7:50000', 'Desktop']);
  });

  it('moonlightTarget adds a port only for an internet host on a non-default port', () => {
    const base = { preferredAddress: '203.0.113.7', httpPort: 47989 } as const;
    expect(moonlightTarget({ ...base, remote: true })).toBe('203.0.113.7');
    expect(moonlightTarget({ ...base, httpPort: 50000, remote: true })).toBe('203.0.113.7:50000');
    expect(moonlightTarget({ preferredAddress: '2001:db8::1', httpPort: 50000, remote: true })).toBe('[2001:db8::1]:50000');
    expect(moonlightTarget({ preferredAddress: '127.0.0.1', httpPort: 50000 })).toBe('127.0.0.1');
    expect(moonlightTarget({ preferredAddress: '192.168.1.5', httpPort: 50000, remote: false })).toBe('192.168.1.5');
  });
});

describe('Internet preset and bitrate floor', () => {
  it('floor is 5 Mbps', () => {
    expect(clampBitrate(1, false)).toBe(5);
    expect(clampBitrate(7.4, false)).toBe(7);
    expect(normalizeStreamSettings({ bitrateMbps: 0 }).bitrateMbps).toBe(5);
  });

  it('the Internet preset is 1080p, 60 fps, 15 Mbps, codec auto and survives normalising', () => {
    const p = PRESETS.find((x) => x.id === 'internet')!;
    expect(p.settings).toMatchObject({ resolution: '1080p', fps: 60, bitrateMbps: 15, codec: 'auto' });
    const s = applyPreset('internet', DEFAULT_STREAM_SETTINGS);
    expect(s).toMatchObject({ presetId: 'internet', resolution: '1080p', fps: 60, bitrateMbps: 15, codec: 'auto' });
    expect(matchingPreset(s)).toBe('internet');
    expect(normalizeStreamSettings({ ...s, bitrateMbps: 16 }).presetId).toBe('custom');
  });
});

describe('remote pairing with a code', () => {
  function setup(env: Record<string, string>, timing: Record<string, number> = {}, host: Partial<HostInfo> = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-online-'));
    const stateFile = path.join(dir, 'state.json');
    const log = new MemoryLogger();
    const moonlight = createMoonlightRunner({ binary: process.execPath, prefixArgs: [FAKE_ML], runner: new NodeProcessRunner(), log, env: { FAKE_ML_STATE: stateFile, ...env } });
    const agentCalls: unknown[][] = [];
    const svc = new ClientPairingService({
      moonlight,
      log: log.child('pair'),
      clientName: () => 'Mac mini',
      clientId: () => '6f1c2b8e-1d2a-4c55-9b7e-0a1b2c3d4e5f',
      agentPort: 47920,
      pin: () => '4821',
      agentRequest: async (...a) => {
        agentCalls.push(a);
        throw new Error('the agent must not be called for an internet host');
      },
      timing: { postSuccessFlushMs: 50, terminateGraceMs: 500, overallTimeoutMs: 15_000, listTimeoutMs: 5000, codePollMs: 60, codeWaitMs: 5000, ...timing },
    });
    const h: HostInfo = { id: 'remote:203.0.113.7:47989', name: 'Friend-PC', addresses: ['203.0.113.7'], preferredAddress: '203.0.113.7', sources: ['manual'], httpPort: 47989, lastSeen: new Date().toISOString(), remote: true, ...host };
    const state = () => JSON.parse(readFileSync(stateFile, 'utf8')) as { paired: Record<string, boolean>; calls: string[][] };
    return { svc, h, log, agentCalls, state };
  }

  it('shows the code, never calls the agent, and succeeds when Moonlight exits 0', async () => {
    const t = setup({ FAKE_ML_PAIR_EXIT_MS: '250' });
    const seen: PairProgress[] = [];
    const r = await t.svc.pair(t.h, (p) => seen.push(p));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, alreadyPaired: false });
    expect(seen.map((p) => p.phase)).toEqual(['checking', 'starting-moonlight', 'show-code', 'confirming', 'verifying', 'done']);
    expect(seen.find((p) => p.phase === 'show-code')).toMatchObject({ hostId: t.h.id, code: '4821' });
    expect(seen.filter((p) => p.phase !== 'show-code').every((p) => p.code === undefined && !p.message.includes('4821'))).toBe(true);
    expect(t.agentCalls).toEqual([]);
    const calls = t.state().calls;
    expect(calls[0]).toEqual(['list', '203.0.113.7']);
    expect(calls[1]).toEqual(['pair', '203.0.113.7', '--pin', '4821']);
    expect(calls.at(-1)).toEqual(['list', '203.0.113.7']);
    expect(JSON.stringify(t.log.entries)).not.toContain('4821');
  });

  it('also succeeds when Moonlight stays open but `list` says paired', async () => {
    const t = setup({ FAKE_ML_PAIR_PAIRED_MS: '200' });
    const phases: string[] = [];
    const r = await t.svc.pair(t.h, (p) => phases.push(p.phase));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, alreadyPaired: false });
    expect(phases).toEqual(['checking', 'starting-moonlight', 'show-code', 'confirming', 'verifying', 'done']);
    expect(t.agentCalls).toEqual([]);
    expect(t.state().calls.filter((c) => c[0] === 'list').length).toBeGreaterThanOrEqual(3);
  });

  it('gives code-timeout with the exact sentence when nobody enters the code', async () => {
    const t = setup({}, { codeWaitMs: 400 });
    const r = await t.svc.pair(t.h, () => undefined);
    expect(r).toMatchObject({ ok: false, code: 'code-timeout', message: 'The host did not enter the code in time. Press Stream to get a new code.', retryable: true });
    expect(t.agentCalls).toEqual([]);
  });

  it('waits 180 s by default and the 60 s overall timeout does not cut it short (fake clock, fake Moonlight)', async () => {
    vi.useFakeTimers();
    try {
      const log = new MemoryLogger();
      const never = new Promise<never>(() => undefined);
      let terminated = 0;
      const moonlight = {
        binaryPath: () => '/fake',
        isPaired: async () => ({ paired: false, result: { exitCode: 255, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false } }),
        startPair: () => ({ pid: 1, argv: [], exited: never, terminate: async () => void terminated++ }),
      } as unknown as ConstructorParameters<typeof ClientPairingService>[0]['moonlight'];
      const svc = new ClientPairingService({ moonlight, log, clientName: () => 'Mac', clientId: () => 'id', agentPort: 47920, pin: () => '1234' });
      const host: HostInfo = { id: 'r', name: 'Friend', addresses: ['203.0.113.7'], preferredAddress: '203.0.113.7', sources: ['manual'], httpPort: 47989, lastSeen: '', remote: true };
      let result: Awaited<ReturnType<typeof svc.pair>> | undefined;
      void svc.pair(host, () => undefined).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(179_000);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(result).toMatchObject({ ok: false, code: 'code-timeout' });
      expect(terminated).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports Moonlight crashing, and a window closed before the host entered the code', async () => {
    const crash = setup({ FAKE_ML_MODE: 'crash' });
    expect(await crash.svc.pair(crash.h, () => undefined)).toMatchObject({ ok: false, code: 'moonlight-failed', retryable: true });
    // A refusal within seconds is retried once (a leftover pairing on the host is erased by the refusal): two `pair` runs, no more.
    expect(crash.state().calls.filter((c) => c[0] === 'pair')).toHaveLength(2);
    const quit = setup({ FAKE_ML_PAIR_QUIT_MS: '150' });
    expect(await quit.svc.pair(quit.h, () => undefined)).toMatchObject({ ok: false, code: 'verify-failed' });
    expect(quit.agentCalls).toEqual([]);
  });

  it('passes the typed port to Moonlight', async () => {
    const t = setup({ FAKE_ML_PAIR_EXIT_MS: '150' }, {}, { httpPort: 50000, id: 'remote:203.0.113.7:50000' });
    const r = await t.svc.pair(t.h, () => undefined);
    expect(r).toMatchObject({ ok: true });
    expect(t.state().calls.every((c) => c[1] === '203.0.113.7:50000')).toBe(true);
  });

  describe('a leftover pending pairing on the host (after a code timeout)', () => {
    type Ex = { exitCode: number | null; signal: null; stdout: string; stderr: string; durationMs: number; timedOut: boolean; spawnError?: string };
    const exit = (exitCode: number): Ex => ({ exitCode, signal: null, stdout: '', stderr: 'Pairing failed: A pairing session with this uniqueid already exists', durationMs: 5, timedOut: false });
    /** Moonlight stub: each `pair` start gets the next script entry: an exit after `afterMs` of fake time, or 'paired' (list says paired, process stays open). */
    function stub(script: Array<{ exit: number; afterMs: number } | 'paired'>) {
      let paired = false;
      const starts: string[] = [];
      const terminated: number[] = [];
      let clock = 0;
      const moonlight = {
        binaryPath: () => '/fake',
        isPaired: async () => ({ paired, result: { exitCode: paired ? 0 : 255, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false } }),
        startPair: (target: string, pin: string) => {
          const step = script[starts.length]!;
          starts.push(`${target} ${pin}`);
          const idx = starts.length;
          let resolve!: (r: Ex) => void;
          const exited = new Promise<Ex>((r) => (resolve = r));
          if (step === 'paired') setTimeout(() => (paired = true), 20);
          else setTimeout(() => ((clock += step.afterMs), resolve(exit(step.exit))), 5);
          return { pid: idx, argv: [], exited, terminate: async () => void terminated.push(idx) };
        },
      } as unknown as ConstructorParameters<typeof ClientPairingService>[0]['moonlight'];
      return { moonlight, starts, terminated, now: () => clock };
    }
    const host: HostInfo = { id: 'remote:203.0.113.7:47989', name: 'Friend-PC', addresses: ['203.0.113.7'], preferredAddress: '203.0.113.7', sources: ['manual'], httpPort: 47989, lastSeen: '', remote: true };
    const make = (st: ReturnType<typeof stub>, pins: string[]) => {
      const agent = vi.fn();
      const svc = new ClientPairingService({
        moonlight: st.moonlight,
        log: new MemoryLogger(),
        clientName: () => 'Mac',
        clientId: () => 'id',
        agentPort: 47920,
        pin: () => pins.shift() ?? '0000',
        agentRequest: agent,
        now: () => st.now(),
        timing: { postSuccessFlushMs: 5, terminateGraceMs: 50, codePollMs: 20, codeWaitMs: 5000, leftoverWaitMs: 5000 },
      });
      return { svc, agent };
    };

    it('retries once when Moonlight is refused at once, with a fresh code, and then succeeds', async () => {
      const st = stub([{ exit: 1, afterMs: 400 }, 'paired']);
      const { svc, agent } = make(st, ['1111', '2222']);
      const seen: PairProgress[] = [];
      const r = await svc.pair(host, (p) => seen.push(p));
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true, alreadyPaired: false });
      expect(st.starts).toEqual(['203.0.113.7 1111', '203.0.113.7 2222']);
      expect(seen.filter((p) => p.phase === 'show-code').map((p) => p.code)).toEqual(['1111', '2222']);
      expect(seen.some((p) => p.message === 'Clearing an old pairing attempt and trying again...')).toBe(true);
      expect(agent).not.toHaveBeenCalled();
    });

    it('retries only once: a second quick refusal is reported as moonlight-failed', async () => {
      const st = stub([{ exit: 1, afterMs: 100 }, { exit: 1, afterMs: 100 }, 'paired']);
      const { svc } = make(st, ['1111', '2222', '3333']);
      expect(await svc.pair(host, () => undefined)).toMatchObject({ ok: false, code: 'moonlight-failed', retryable: true });
      expect(st.starts).toHaveLength(2);
    });

    it('does not retry a Moonlight that ran for a while before failing', async () => {
      const st = stub([{ exit: 1, afterMs: 60_000 }, 'paired']);
      const { svc } = make(st, ['1111', '2222']);
      expect(await svc.pair(host, () => undefined)).toMatchObject({ ok: false, code: 'moonlight-failed' });
      expect(st.starts).toHaveLength(1);
    });
  });

  describe('the pair agent is never addressed at a public address', () => {
    function lan(over: Partial<HostInfo>) {
      const log = new MemoryLogger();
      const agent = vi.fn(async () => {
        throw new Error('stop here');
      });
      const startPair = vi.fn();
      const moonlight = {
        binaryPath: () => '/fake',
        isPaired: async () => ({ paired: false, result: { exitCode: 255, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false } }),
        startPair,
      } as unknown as ConstructorParameters<typeof ClientPairingService>[0]['moonlight'];
      const svc = new ClientPairingService({ moonlight, log, clientName: () => 'Mac', clientId: () => 'id', agentPort: 47920, pin: () => '1234', agentRequest: agent });
      const h: HostInfo = { id: 'x', name: 'PC', addresses: ['203.0.113.7'], preferredAddress: '203.0.113.7', sources: ['manual'], httpPort: 47989, lastSeen: '', ...over };
      return { svc, h, agent, startPair };
    }

    it.each(['203.0.113.7', '8.8.8.8', '2001:db8::1', '100.64.1.2'])('a non-remote host at %s is refused before Moonlight or the agent is touched', async (addr) => {
      const t = lan({ preferredAddress: addr, addresses: [addr] });
      const r = await t.svc.pair(t.h, () => undefined);
      expect(r).toMatchObject({ ok: false, code: 'agent-forbidden', retryable: false });
      expect(t.agent).not.toHaveBeenCalled();
      expect(t.startPair).not.toHaveBeenCalled();
    });

    it('a private address still reaches the agent (flag unset or false)', async () => {
      for (const remote of [undefined, false]) {
        const t = lan({ preferredAddress: '192.168.1.20', addresses: ['192.168.1.20'], ...(remote === undefined ? {} : { remote }) });
        t.startPair.mockReturnValue({ pid: 1, argv: [], exited: new Promise(() => undefined), terminate: async () => undefined });
        await t.svc.pair(t.h, () => undefined);
        expect(t.agent).toHaveBeenCalled();
      }
    });
  });

  it('an already paired internet host returns at once', async () => {
    const t = setup({ FAKE_ML_PAIR_EXIT_MS: '50' });
    await t.svc.pair(t.h, () => undefined);
    const phases: string[] = [];
    const again = await t.svc.pair(t.h, (p) => phases.push(p.phase));
    expect(again).toMatchObject({ ok: true, alreadyPaired: true });
    expect(phases).toEqual(['checking', 'done']);
  });
});

describe('MacClientService with internet hosts', () => {
  function make(env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-online-svc-'));
    const stateFile = path.join(dir, 'state.json');
    const log = new MemoryLogger();
    const settings = new MemoryStore();
    const deps: ServiceDeps = {
      log,
      paths: { logDir: dir, userData: dir, sharedData: dir, resources: dir, vendorDir: dir, psDir: dir, diagnosticsOutDir: dir, logDirFellBack: false },
      secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined, backend: () => 'keychain' },
      settings,
      runner: new NodeProcessRunner(),
    };
    const svc = new MacClientService(deps, {
      moonlightBinary: process.execPath,
      prefixArgs: [FAKE_ML],
      moonlightEnv: { FAKE_ML_STATE: stateFile, ...env },
      cpuModel: 'Apple M4',
      discovery: { mdns: null, udpTargets: () => [], probeDelayMs: 60_000, fetchServerInfo: async () => info(), agentCheck: async () => true },
      streamStartupMs: 300,
      ...extra,
    });
    return { svc, settings, stateFile, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as { streams: string[][] } };
  }

  it('remembers the last 5 typed internet addresses, newest first, once each, and not LAN addresses', async () => {
    const { svc, settings } = make();
    expect(svc.recentRemote()).toEqual([]);
    await svc.discovery.addManual('192.168.1.20');
    expect(svc.recentRemote()).toEqual([]);
    for (const a of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4', '203.0.113.5', '203.0.113.6']) await svc.discovery.addManual(a);
    expect(svc.recentRemote()).toEqual(['203.0.113.6', '203.0.113.5', '203.0.113.4', '203.0.113.3', '203.0.113.2']);
    await svc.discovery.addManual('203.0.113.3');
    expect(svc.recentRemote()).toEqual(['203.0.113.3', '203.0.113.6', '203.0.113.5', '203.0.113.4', '203.0.113.2']);
    expect(settings.get(RECENT_REMOTE_KEY, null)).toEqual(svc.recentRemote());
    await expect(svc.discovery.addManual('203.0.113.9:70000')).rejects.toThrow();
    expect(svc.recentRemote()).toHaveLength(5);
  });

  it('survives a restart (persisted in settings) and ignores a damaged value', () => {
    const a = make();
    a.settings.set(RECENT_REMOTE_KEY, ['203.0.113.1', 5, null, '203.0.113.2']);
    expect(a.svc.recentRemote()).toEqual(['203.0.113.1', '203.0.113.2']);
    a.settings.set(RECENT_REMOTE_KEY, 'nope');
    expect(a.svc.recentRemote()).toEqual([]);
  });

  it('selects the Internet preset when a remote address is first added, and leaves later edits alone', async () => {
    const { svc } = make();
    expect(svc.getSettings().presetId).toBe('balanced');
    await svc.discovery.addManual('192.168.1.20');
    expect(svc.getSettings().presetId).toBe('balanced');
    await svc.discovery.addManual('203.0.113.7');
    expect(svc.getSettings()).toMatchObject({ presetId: 'internet', resolution: '1080p', fps: 60, bitrateMbps: 15 });
    svc.setSettings({ ...svc.getSettings(), bitrateMbps: 8 });
    await svc.discovery.addManual('203.0.113.7');
    expect(svc.getSettings()).toMatchObject({ presetId: 'custom', bitrateMbps: 8 });
  });

  it('streams to the typed port', async () => {
    const t = make({}, { discovery: { mdns: null, udpTargets: () => [], probeDelayMs: 60_000, fetchServerInfo: async () => info(), agentCheck: async () => true } });
    const h = await t.svc.discovery.addManual('203.0.113.7:50000');
    await t.svc.startStream(h.id, DEFAULT_STREAM_SETTINGS, () => undefined);
    expect(t.state().streams[0]!.slice(0, 3)).toEqual(['stream', '203.0.113.7:50000', 'Desktop']);
  });

  it('adds the UDP hint when a remote stream dies non-zero within 15 s, not after, not for a LAN host', async () => {
    let clock = 1_000;
    const t = make({ FAKE_ML_STREAM_EXIT: '3' }, { now: () => clock });
    const lan = await t.svc.discovery.addManual('192.168.1.20');
    const remote = await t.svc.discovery.addManual('203.0.113.7');
    const stLan = await t.svc.startStream(lan.id, DEFAULT_STREAM_SETTINGS, () => undefined);
    expect(stLan).toMatchObject({ state: 'failed' });
    expect(stLan.message).not.toContain('UDP');
    const st = await t.svc.startStream(remote.id, DEFAULT_STREAM_SETTINGS, () => undefined);
    expect(st).toMatchObject({ state: 'failed', exitCode: 3 });
    expect(st.message).toMatch(/^Moonlight exited right away \(code 3\)\./);
    expect(st.message!.endsWith(UDP_HINT)).toBe(true);
    expect(UDP_HINT).toBe('The host answered, so TCP works. If there was no picture, UDP 47998-48000 is probably not forwarded.');

    // dies after the startup window but still within 15 s: reported through onState
    const later = make({ FAKE_ML_STREAM_EXIT: '3', FAKE_ML_STREAM_MS: '500' }, { now: () => clock, streamStartupMs: 100 });
    const r2 = await later.svc.discovery.addManual('203.0.113.7');
    const ended = new Promise<string | undefined>((res) => void later.svc.startStream(r2.id, DEFAULT_STREAM_SETTINGS, (s) => s.state === 'ended' && res(s.message)));
    expect((await ended)!.endsWith(UDP_HINT)).toBe(true);

    // 20 s later: no hint
    const slow = make({ FAKE_ML_STREAM_EXIT: '3', FAKE_ML_STREAM_MS: '500' }, { now: () => (clock += 20_000), streamStartupMs: 100 });
    const r3 = await slow.svc.discovery.addManual('203.0.113.7');
    const ended3 = new Promise<string | undefined>((res) => void slow.svc.startStream(r3.id, DEFAULT_STREAM_SETTINGS, (s) => s.state === 'ended' && res(s.message)));
    const m3 = (await ended3)!;
    expect(m3).toMatch(/^Moonlight stopped with code 3\./);
    expect(m3).not.toContain('UDP');
  });
});
