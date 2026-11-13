// LAN-only pair agent (host). HTTP JSON API + UDP discovery reply on LANPLAY.agentPort.
// Guards (contracts §7, in order): private source -> Host header allow-list -> no Origin/Referer -> JSON content type
// -> body size -> rate limit. No CORS headers, ever.
import dgram from 'node:dgram';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { LANPLAY, SUNSHINE, SunshineApiError } from '../../contracts.js';
import type {
  AgentDiscoveryReply,
  AgentInfoResponse,
  AgentPairRequest,
  AgentPairResponse,
  AgentState,
  CreatePairAgent,
  KeyValueStore,
  PairAgent,
  PairAgentOptions,
  PairErrorCode,
  PairedDevice,
  PendingApproval,
} from '../../contracts.js';
import { isPrivateAddress, normalizeAddress, parseHostHeader } from '../shared/ipnet.js';

export const AGENT_VERSION = '1';
export const AUTO_APPROVE_KEY = 'agent.autoApprove';
export const LEDGER_KEY = 'agent.pairedDevices';

/* ---------------- token bucket ---------------- */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly perMs: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }
  take(): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.perMs);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - this.tokens) / this.perMs / 1000)) };
  }
}

export class RateLimiter {
  private readonly perIp = new Map<string, TokenBucket>();
  private readonly global: TokenBucket;
  constructor(
    private readonly perIpPerMinute: number,
    globalPerMinute: number,
    private readonly now: () => number,
  ) {
    this.global = new TokenBucket(globalPerMinute, globalPerMinute / 60_000, now);
  }
  take(ip: string): { ok: boolean; retryAfterSec: number } {
    if (this.perIp.size > 1024) this.perIp.clear(); // bounded memory
    let b = this.perIp.get(ip);
    if (!b) {
      b = new TokenBucket(this.perIpPerMinute, this.perIpPerMinute / 60_000, this.now);
      this.perIp.set(ip, b);
    }
    const r = b.take();
    if (!r.ok) return r;
    return this.global.take();
  }
}

/* ---------------- validation ---------------- */
const NAME_RE = /^[\p{L}\p{N} ._-]+$/u;

/** Sanitise an untrusted client name: trim, collapse spaces, 1..64 chars of letters/digits/space/._- */
export function sanitizeClientName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < 1 || [...s].length > 64) return null;
  if (!NAME_RE.test(s)) return null;
  if (Buffer.byteLength(s, 'utf8') > SUNSHINE.maxClientNameBytes) return null;
  return s;
}

export function parsePairRequest(body: unknown): AgentPairRequest | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.pin !== 'string' || !/^\d{4}$/.test(b.pin)) return { error: 'pin must be exactly 4 digits' };
  const clientName = sanitizeClientName(b.clientName);
  if (!clientName) return { error: 'clientName must be 1..64 letters, digits, spaces, dots, dashes or underscores' };
  if (typeof b.clientId !== 'string' || !/^[0-9A-Za-z-]{8,64}$/.test(b.clientId)) return { error: 'clientId must be a uuid' };
  const out: AgentPairRequest = { pin: b.pin, clientName, clientId: b.clientId };
  if (b.clientAddresses !== undefined) {
    const a = b.clientAddresses;
    if (!Array.isArray(a) || a.length > 8 || !a.every((x) => typeof x === 'string' && net.isIP(normalizeAddress(x)) !== 0 && isPrivateAddress(x))) {
      return { error: 'clientAddresses must be up to 8 private IP addresses' };
    }
    out.clientAddresses = [...new Set(a.map((x) => normalizeAddress(x as string)))];
  }
  return out;
}

/** Host header allow-list (DNS rebinding guard). */
export function isAllowedHost(hostHeader: string | undefined, port: number, identity: { hostName: string; addresses: string[] }): boolean {
  const h = parseHostHeader(hostHeader);
  if (!h || h.port !== port) return false;
  const host = normalizeAddress(h.host);
  const addrs = new Set(identity.addresses.map((a) => normalizeAddress(a)));
  if (addrs.has(host)) return true;
  const name = identity.hostName.toLowerCase();
  return host === name || host === `${name}.local`;
}

/* ---------------- agent ---------------- */
interface PendingEntry extends PendingApproval {
  remote: string;
  alsoFrom: string[];
  pin: string;
  status: 'waiting' | 'approved' | 'denied' | 'expired' | 'done';
  result?: AgentPairResponse;
  timer?: NodeJS.Timeout;
}

export interface PairAgentExtraOptions {
  /** Separate store for the paired-devices ledger (%ProgramData%\LanPlay\paired-devices.json). Defaults to settings. */
  ledger?: KeyValueStore;
  /** Bind address; default '0.0.0.0' (LAN). Tests use 127.0.0.1. */
  bindAddress?: string;
  /** Override LANPLAY.agentPendingPollMs / WaitMs (tests). */
  pendingPollMs?: number;
  pendingWaitMs?: number;
  approvalTimeoutMs?: number;
  /** Disable the UDP discovery responder (tests that only need HTTP). */
  udp?: boolean;
  /** Flood guard for all requests (default 120 per IP / 600 total per minute). */
  floodPerIpPerMinute?: number;
  floodGlobalPerMinute?: number;
  /** How long GET /v1/info reuses its last answer (default 3000 ms): one Sunshine API call per window at most. */
  infoCacheMs?: number;
}

/** Max requests waiting for manual approval: in total, and from one address. */
export const MAX_PENDING_TOTAL = 8;
export const MAX_PENDING_PER_ADDRESS = 2;

class Mutex {
  private p: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.p.then(fn, fn);
    this.p = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export class LanPairAgent implements PairAgent {
  private server: http.Server | null = null;
  private udp: dgram.Socket | null = null;
  private port: number;
  private lastError: string | undefined;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly listeners = new Set<(s: AgentState) => void>();
  private readonly limiter: RateLimiter;
  private readonly udpLimiter: RateLimiter;
  /** Cheap flood guard for EVERY request (GET polls, /v1/info, rejected requests), checked before any other work. */
  private readonly floodLimiter: RateLimiter;
  /** Rejections are logged at most this often so a LAN device cannot fill the disk with warn lines. */
  private readonly rejectLogLimiter: TokenBucket;
  private suppressedRejects = 0;
  private infoCache: { at: number; value: AgentInfoResponse } | null = null;
  private idleReason: string | undefined;
  private readonly now: () => number;
  private readonly pairMutex = new Mutex();
  private readonly ledger: KeyValueStore;

  constructor(
    private readonly o: PairAgentOptions,
    private readonly x: PairAgentExtraOptions = {},
  ) {
    this.port = o.port;
    this.now = o.now ?? Date.now;
    this.limiter = new RateLimiter(LANPLAY.agentRateLimit.perIpPerMinute, LANPLAY.agentRateLimit.globalPerMinute, this.now);
    this.udpLimiter = new RateLimiter(30, 120, this.now);
    this.floodLimiter = new RateLimiter(x.floodPerIpPerMinute ?? 120, x.floodGlobalPerMinute ?? 600, this.now);
    this.rejectLogLimiter = new TokenBucket(20, 20 / 60_000, this.now);
    this.ledger = x.ledger ?? o.settings;
  }

  private get log() {
    return this.o.log;
  }

  /* ----- lifecycle ----- */
  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 120_000; // pair requests are held while Sunshine completes the handshake
    server.maxHeadersCount = 50;
    server.maxConnections = 64; // a LAN device cannot hold the agent open with idle sockets
    server.keepAliveTimeout = 5_000;
    this.idleReason = undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.o.port, this.x.bindAddress ?? '0.0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.lastError =
        code === 'EADDRINUSE'
          ? `Port ${this.o.port} is already used by another program (or a second LanPlay). Close it, then press Set up / Repair. (${(err as Error).message})`
          : `Cannot listen on TCP ${this.o.port}: ${(err as Error).message}`;
      this.log.log('error', 'agent', this.lastError);
      this.emit();
      throw err;
    }
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    if (this.x.udp !== false) await this.startUdp();
    this.lastError = undefined;
    this.log.log('info', 'agent', 'pair agent listening', { port: this.port, bind: this.x.bindAddress ?? '0.0.0.0', autoApprove: this.autoApprove() });
    this.emit();
  }

  private async startUdp(): Promise<void> {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    sock.on('message', (msg, rinfo) => this.onUdp(sock, msg, rinfo));
    sock.on('error', (e) => {
      this.lastError = `UDP discovery: ${e.message}`;
      this.log.log('warn', 'agent', this.lastError);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once('error', reject);
        sock.bind(this.port, this.x.bindAddress ?? '0.0.0.0', () => {
          sock.off('error', reject);
          resolve();
        });
      });
      this.udp = sock;
    } catch (e) {
      this.lastError = `UDP discovery disabled: ${(e as Error).message}`;
      this.log.log('warn', 'agent', this.lastError);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
  }

  private onUdp(sock: dgram.Socket, msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length > 64 || msg.toString('ascii') !== LANPLAY.agentDiscoveryMagic) return;
    if (!isPrivateAddress(rinfo.address)) return;
    if (!this.udpLimiter.take(normalizeAddress(rinfo.address)).ok) return;
    const id = this.o.localIdentity();
    const reply: AgentDiscoveryReply = {
      magic: LANPLAY.agentDiscoveryMagic,
      hostName: id.hostName,
      agentPort: this.port,
      sunshineHttpPort: SUNSHINE.httpPort,
      addresses: id.addresses.filter((a) => isPrivateAddress(a) && !a.startsWith('127.') && a !== '::1'),
    };
    sock.send(Buffer.from(JSON.stringify(reply)), rinfo.port, rinfo.address);
  }

  async stop(): Promise<void> {
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    const s = this.server;
    this.server = null;
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        /* ignore */
      }
      this.udp = null;
    }
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    this.emit();
  }

  /* ----- state ----- */
  private autoApprove(): boolean {
    return this.o.settings.get<boolean>(AUTO_APPROVE_KEY, true) !== false;
  }

  getState(): AgentState {
    const st: AgentState = {
      listening: this.server !== null,
      port: this.port,
      autoApprove: this.autoApprove(),
      pending: [...this.pending.values()]
        .filter((p) => p.status === 'waiting')
        .map(({ requestId, clientName, remoteAddress, requestedAt, expiresAt }) => ({ requestId, clientName, remoteAddress, requestedAt, expiresAt })),
    };
    const err = this.server === null ? (this.lastError ?? this.idleReason) : this.lastError;
    if (err !== undefined) st.lastError = err;
    return st;
  }

  /** Why the agent was deliberately not started (shown next to "Pair agent is not running"). */
  setIdleReason(reason: string | undefined): void {
    this.idleReason = reason;
    this.emit();
  }

  onChange(cb: (s: AgentState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const s = this.getState();
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  async setAutoApprove(on: boolean): Promise<void> {
    this.o.settings.set(AUTO_APPROVE_KEY, Boolean(on));
    this.log.log('info', 'agent', `auto-approve ${on ? 'ON' : 'OFF'}`);
    this.emit();
  }

  async decide(requestId: string, approve: boolean): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p || p.status !== 'waiting') throw new Error('No such pending request (it may have expired).');
    if (p.timer) clearTimeout(p.timer);
    this.log.log('info', 'agent', `request ${approve ? 'approved' : 'denied'} by user`, { requestId, clientName: p.clientName, remote: p.remote });
    if (!approve) {
      p.status = 'denied';
      p.result = { status: 'denied' };
      this.emit();
      this.scheduleForget(p);
      return;
    }
    p.status = 'approved';
    this.emit();
    void this.pairMutex
      .run(() => this.doPair(p.remote, p.pin, p.clientName, p.alsoFrom))
      .then((r) => {
        p.result = r;
        p.status = 'done';
        this.scheduleForget(p);
      });
  }

  private scheduleForget(p: PendingEntry): void {
    const t = setTimeout(() => this.pending.delete(p.requestId), 5 * 60_000);
    t.unref?.();
  }

  /* ----- devices ----- */
  private readLedger(): PairedDevice[] {
    const v = this.ledger.get<PairedDevice[]>(LEDGER_KEY, []);
    return Array.isArray(v) ? v : [];
  }

  async listDevices(): Promise<PairedDevice[]> {
    const ledger = this.readLedger();
    const clients = await this.o.sunshine.listClients();
    return clients.map((c) => {
      const l = ledger.find((d) => d.uuid === c.uuid);
      const d: PairedDevice = { uuid: c.uuid, name: c.name, enabled: c.enabled, pairedVia: l ? 'lanplay' : 'other' };
      if (l?.pairedAt) d.pairedAt = l.pairedAt;
      if (l?.lastAddress) d.lastAddress = l.lastAddress;
      return d;
    });
  }

  async revoke(uuid: string): Promise<void> {
    const ok = await this.o.sunshine.unpairClient(uuid);
    if (!ok) throw new Error('Sunshine did not unpair this device (it may already be gone).');
    this.ledger.set(
      LEDGER_KEY,
      this.readLedger().filter((d) => d.uuid !== uuid),
    );
    this.log.log('info', 'agent', 'device revoked', { uuid });
  }

  /* ----- HTTP ----- */
  private send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const s = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(s)),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(s);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = normalizeAddress(req.socket.remoteAddress ?? '');
    const method = req.method ?? 'GET';
    const url = (req.url ?? '/').split('?')[0]!;
    const deny = (status: number, error: string, extra: Record<string, string> = {}) => {
      if (this.rejectLogLimiter.take().ok) {
        const data: Record<string, unknown> = { remote, status, host: String(req.headers.host ?? '').slice(0, 100) || null };
        if (this.suppressedRejects > 0) data.suppressedSinceLastLog = this.suppressedRejects;
        this.suppressedRejects = 0;
        this.log.log('warn', 'agent', `rejected ${method.slice(0, 16)} ${url.slice(0, 100)}: ${error}`, data);
      } else this.suppressedRejects++;
      this.send(res, status, { error }, { Connection: 'close', ...extra });
      req.resume();
    };
    try {
      // 1. private source
      if (!isPrivateAddress(remote)) return deny(403, 'forbidden-source');
      // 1b. flood guard for every request, before any parsing, Sunshine call or per-request logging
      const flood = this.floodLimiter.take(remote);
      if (!flood.ok) return deny(429, 'rate-limited', { 'Retry-After': String(flood.retryAfterSec) });
      // 2. Host header (DNS rebinding)
      if (!isAllowedHost(req.headers.host, this.port, this.o.localIdentity())) return deny(421, 'bad-host');
      // 3. browsers (CSRF): any Origin or Referer, including "null"
      if (req.headers.origin !== undefined || req.headers.referer !== undefined) return deny(403, 'browser-origin');
      if (method === 'OPTIONS') return deny(405, 'method-not-allowed');
      // 4. JSON only for POST
      if (method === 'POST') {
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!/^application\/json(\s*;\s*charset=utf-8)?$/.test(ct.trim())) return deny(415, 'unsupported-media-type');
      }
      // 5. body size
      let body = '';
      if (method === 'POST') {
        const declared = Number(req.headers['content-length'] ?? '0');
        if (declared > LANPLAY.agentRateLimit.maxBodyBytes) return deny(413, 'body-too-large');
        const read = await readLimited(req, LANPLAY.agentRateLimit.maxBodyBytes);
        if (read === null) return deny(413, 'body-too-large');
        body = read;
        // 6. rate limit
        const rl = this.limiter.take(remote);
        if (!rl.ok) return deny(429, 'rate-limited', { 'Retry-After': String(rl.retryAfterSec) });
      } else {
        req.resume();
      }

      if (method === 'GET' && url === '/v1/info') return this.send(res, 200, await this.info());
      if (method === 'POST' && url === '/v1/pair') return await this.handlePair(remote, body, res);
      if (method === 'GET' && url.startsWith('/v1/pair/')) return this.handlePairStatus(remote, url.slice('/v1/pair/'.length), res);
      if (['/v1/info', '/v1/pair'].includes(url)) return this.send(res, 405, { error: 'method-not-allowed' });
      return this.send(res, 404, { error: 'not-found' });
    } catch (err) {
      this.log.log('error', 'agent', 'request failed', { error: (err as Error).message });
      if (!res.headersSent) this.send(res, 500, { error: 'internal' });
    }
  }

  private async info(): Promise<AgentInfoResponse> {
    // Unauthenticated callers must not be able to make the agent hammer Sunshine's API: reuse the answer briefly.
    const ttl = this.x.infoCacheMs ?? 3000;
    const t = this.now();
    if (this.infoCache && t - this.infoCache.at < ttl) return { ...this.infoCache.value, autoApprove: this.autoApprove() };
    const value = await this.infoFresh();
    this.infoCache = { at: t, value };
    return value;
  }

  private async infoFresh(): Promise<AgentInfoResponse> {
    let sunshineVersion: string | null = null;
    let ready = false;
    try {
      sunshineVersion = await this.o.sunshine.getVersion();
      ready = true;
      if (this.lastError?.startsWith('Sunshine API:')) this.lastError = undefined; // recovered
    } catch (e) {
      this.lastError = `Sunshine API: ${(e as Error).message}`;
    }
    return { agentVersion: AGENT_VERSION, hostName: this.o.localIdentity().hostName, sunshineVersion, autoApprove: this.autoApprove(), ready };
  }

  private async handlePair(remote: string, body: string, res: http.ServerResponse): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.send(res, 400, { error: 'invalid-json' });
    }
    const r = parsePairRequest(parsed);
    if ('error' in r) return this.send(res, 400, { error: 'bad-request', message: r.error });
    this.log.log('info', 'agent', 'pair request', { remote, clientName: r.clientName, clientId: r.clientId, autoApprove: this.autoApprove() });

    if (!this.autoApprove()) {
      const waiting = [...this.pending.values()].filter((p) => p.status === 'waiting');
      if (waiting.length >= MAX_PENDING_TOTAL || waiting.filter((p) => p.remote === remote).length >= MAX_PENDING_PER_ADDRESS) {
        return this.send(res, 429, { error: 'too-many-pending' }, { 'Retry-After': '30' });
      }
      const ttl = this.x.approvalTimeoutMs ?? LANPLAY.manualApprovalTimeoutMs;
      const t = this.now();
      const entry: PendingEntry = {
        requestId: randomUUID(),
        clientName: r.clientName,
        remoteAddress: remote,
        remote,
        alsoFrom: r.clientAddresses ?? [],
        pin: r.pin,
        requestedAt: new Date(t).toISOString(),
        expiresAt: new Date(t + ttl).toISOString(),
        status: 'waiting',
      };
      entry.timer = setTimeout(() => {
        if (entry.status === 'waiting') {
          entry.status = 'expired';
          entry.result = { status: 'failed', code: 'approval-timeout', message: 'Nobody approved the request on the PC in time.' };
          this.emit();
          this.scheduleForget(entry);
        }
      }, ttl);
      entry.timer.unref?.();
      this.pending.set(entry.requestId, entry);
      this.emit();
      const out: AgentPairResponse = { status: 'pending-approval', requestId: entry.requestId, expiresInMs: ttl };
      return this.send(res, 202, out);
    }
    const result = await this.pairMutex.run(() => this.doPair(remote, r.pin, r.clientName, r.clientAddresses ?? []));
    return this.send(res, 200, result);
  }

  private handlePairStatus(remote: string, id: string, res: http.ServerResponse): void {
    const p = this.pending.get(id);
    // Only the device that asked may poll its request.
    if (!p || p.remote !== remote) return this.send(res, 404, { error: 'not-found' });
    if (p.result) return this.send(res, 200, p.result);
    const left = Math.max(0, Date.parse(p.expiresAt) - this.now());
    const out: AgentPairResponse = { status: 'pending-approval', requestId: p.requestId, expiresInMs: p.status === 'approved' ? Math.max(left, 1000) : left };
    return this.send(res, 202, out);
  }

  /** Find Moonlight's pending pairing from `remote` in GET /api/pin and submit the PIN. */
  private async doPair(remote: string, pin: string, clientName: string, alsoFrom: readonly string[] = []): Promise<AgentPairResponse> {
    const fail = (code: PairErrorCode, message: string): AgentPairResponse => {
      this.log.log('warn', 'agent', `pair failed: ${code}`, { remote, message });
      return { status: 'failed', code, message };
    };
    const pollMs = this.x.pendingPollMs ?? LANPLAY.agentPendingPollMs;
    const waitMs = this.x.pendingWaitMs ?? LANPLAY.agentPendingWaitMs;
    const deadline = this.now() + waitMs;
    const seen = new Set<string>();
    let match: { id: string; name: string; address: string } | undefined;
    let before: string[] = [];
    try {
      before = (await this.o.sunshine.listClients()).map((c) => c.uuid);
      for (;;) {
        const list = await this.o.sunshine.getPendingPairings();
        for (const p of list) seen.add(p.address);
        // Prefer the HTTP source address; then the client's other addresses (multi-homed Mac).
        for (const addr of [remote, ...alsoFrom.filter((a) => a !== remote)]) {
          const mine = list.filter((p) => normalizeAddress(p.address) === addr);
          match = mine[mine.length - 1];
          if (match) break;
        }
        if (match || this.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch (e) {
      return this.sunshineFail(e, fail);
    }
    if (!match) {
      this.log.log('warn', 'agent', 'no pending pairing from requester', { remote, clientAddresses: alsoFrom, addressesSeen: [...seen] });
      return fail('no-pending-pairing', `Sunshine never saw a Moonlight pairing request from ${[remote, ...alsoFrom.filter((a) => a !== remote)].join(' / ')}. Seen: ${[...seen].join(', ') || 'none'}.`);
    }
    let ok: boolean;
    try {
      ok = await this.o.sunshine.submitPin({ pairingId: match.id, pin, name: clientName });
    } catch (e) {
      return this.sunshineFail(e, fail);
    }
    if (!ok) return fail('wrong-pin', 'Sunshine rejected the PIN or the handshake did not finish.');
    let uuid: string | undefined;
    try {
      const after = await this.o.sunshine.listClients();
      uuid = after.find((c) => !before.includes(c.uuid))?.uuid ?? after.filter((c) => c.name === clientName).pop()?.uuid;
    } catch {
      /* ledger is best-effort */
    }
    if (uuid) {
      const ledger = this.readLedger().filter((d) => d.uuid !== uuid);
      ledger.push({ uuid, name: clientName, enabled: true, pairedVia: 'lanplay', pairedAt: new Date(this.now()).toISOString(), lastAddress: remote });
      this.ledger.set(LEDGER_KEY, ledger.slice(-100));
    }
    this.log.log('info', 'agent', 'paired', { remote, matchedAddress: match.address, clientName, uuid: uuid ?? null });
    this.emit();
    return { status: 'paired', sunshineClientName: clientName };
  }

  private sunshineFail(e: unknown, fail: (c: PairErrorCode, m: string) => AgentPairResponse): AgentPairResponse {
    if (e instanceof SunshineApiError) {
      // GET/POST /api/pin with a pairing_id exists only in recent Sunshine (confighttp.cpp route table of v2026.914.233613).
      if (e.status === 404 || e.status === 405) {
        return fail(
          'sunshine-api-error',
          `The Sunshine installed on the PC is too old for LanPlay (its API has no pairing list: ${e.message}). On the PC: Windows Settings > Apps > Sunshine > Uninstall, then press "Set up / Repair" in LanPlay so it installs Sunshine ${SUNSHINE.version}.`,
        );
      }
      const notReady = e.kind === 'auth' || e.kind === 'redirect-welcome' || e.kind === 'tls-pin-mismatch' || e.kind === 'network' || e.kind === 'forbidden-origin';
      return fail(notReady ? 'sunshine-not-ready' : 'sunshine-api-error', e.message);
    }
    return fail('sunshine-api-error', (e as Error)?.message ?? String(e));
  }
}

function readLimited(req: http.IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        resolve(null);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve(null);
      }
    });
  });
}

export const createPairAgent: CreatePairAgent = (opts) => new LanPairAgent(opts);
