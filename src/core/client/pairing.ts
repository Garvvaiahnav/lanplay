// No-PIN-typing pairing (client side). moonlight-qt does not print its PIN, it ACCEPTS one (--pin), so we generate it:
//  1. `Moonlight list <ip>` exit 0 -> already paired.
//  2. pin = randomInt(0,10000); spawn `Moonlight pair <ip> --pin <pin>`; POST http://<ip>:47920/v1/pair {pin, clientName, clientId}.
//  3. agent finds Moonlight's pending pairing (by our address) and submits the PIN to Sunshine.
//  4. wait PAIR_TIMING.postSuccessFlushMs, end the pair window, verify with `Moonlight list <ip>`.
import http from 'node:http';
import { randomInt } from 'node:crypto';
import net from 'node:net';
import { LANPLAY, PAIR_TIMING } from '../../contracts.js';
import type { AgentPairRequest, AgentPairResponse, HostInfo, Logger, MoonlightProcessHandle, MoonlightRunner, PairErrorCode, PairingService, PairProgress, PairResult } from '../../contracts.js';
import { tail } from '../shared/exec.js';

export function generatePin(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

export interface AgentHttpResult {
  status: number;
  json: unknown;
  retryAfter?: number;
}

/** JSON request to the pair agent from the main process (Node http: sends no Origin/Referer). */
export function agentRequest(host: string, port: number, method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<AgentHttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Host: net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`, Accept: 'application/json' };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host, port, method, path, headers, setHost: false, timeout: timeoutMs, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { error: 'invalid-json', raw: text.slice(0, 200) };
        }
        const ra = Number(res.headers['retry-after']);
        const out: AgentHttpResult = { status: res.statusCode ?? 0, json };
        if (Number.isFinite(ra)) out.retryAfter = ra;
        resolve(out);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('agent request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export interface PairingDeps {
  moonlight: MoonlightRunner;
  log: Logger;
  clientName: () => string;
  clientId: () => string;
  /** Our private IPv4 addresses (multi-homed Macs); see AgentPairRequest.clientAddresses. */
  clientAddresses?: () => string[];
  agentPort: number;
  timing?: Partial<Record<keyof typeof PAIR_TIMING | 'approvalPollMs' | 'listTimeoutMs', number>>;
  agentRequest?: typeof agentRequest;
  pin?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class PairFail extends Error {
  constructor(
    readonly code: PairErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const RETRYABLE: Record<PairErrorCode, boolean> = {
  'agent-unreachable': true,
  'agent-forbidden': false,
  'agent-rate-limited': true,
  'approval-denied': false,
  'approval-timeout': true,
  'no-pending-pairing': true,
  'wrong-pin': true,
  'sunshine-not-ready': true,
  'sunshine-api-error': true,
  'moonlight-missing': false,
  'moonlight-failed': true,
  'verify-failed': true,
  timeout: true,
};

export class ClientPairingService implements PairingService {
  constructor(private readonly d: PairingDeps) {}

  private get t() {
    const base: Record<keyof typeof PAIR_TIMING | 'approvalPollMs' | 'listTimeoutMs', number> = { ...PAIR_TIMING, approvalPollMs: 1000, listTimeoutMs: 20_000 };
    return { ...base, ...(this.d.timing ?? {}) };
  }

  async pair(host: HostInfo, onProgress: (p: PairProgress) => void): Promise<PairResult> {
    const now = this.d.now ?? Date.now;
    const t0 = now();
    const log = this.d.log;
    const progress = (phase: PairProgress['phase'], message: string) => {
      log.log('info', 'pair', `${phase}: ${message}`, { hostId: host.id });
      try {
        onProgress({ hostId: host.id, phase, message });
      } catch {
        /* ignore UI errors */
      }
    };
    let handle: MoonlightProcessHandle | null = null;
    let overallTimer: NodeJS.Timeout | undefined;
    const run = async (): Promise<PairResult> => {
      const ip = host.preferredAddress;
      progress('checking', 'Checking whether this Mac is already paired…');
      const first = await this.list(ip);
      if (first.paired) {
        progress('done', 'Already paired.');
        return { ok: true, hostId: host.id, alreadyPaired: true, durationMs: now() - t0 };
      }
      const pin = (this.d.pin ?? generatePin)();
      log.redactor.addSecret(pin);
      progress('starting-moonlight', 'Starting Moonlight pairing…');
      handle = this.d.moonlight.startPair(ip, pin);
      const early = handle.exited.then((r) => r);

      progress('contacting-agent', `Asking ${host.name} to accept this Mac…`);
      const req: AgentPairRequest = { pin, clientName: this.d.clientName(), clientId: this.d.clientId() };
      const addrs = this.d.clientAddresses?.().slice(0, 8) ?? [];
      if (addrs.length) req.clientAddresses = addrs;
      const agentCall = this.callAgent(ip, req, progress);
      // If Moonlight dies before the agent answers, report Moonlight's error rather than waiting.
      const raced = await Promise.race([agentCall.then((r) => ({ kind: 'agent' as const, r })), early.then((r) => ({ kind: 'moonlight' as const, r }))]);
      let resp: AgentPairResponse;
      if (raced.kind === 'moonlight') {
        const r = raced.r;
        if (r.spawnError) throw new PairFail('moonlight-missing', `Moonlight could not start: ${r.spawnError}`, false);
        if (r.exitCode !== 0) throw new PairFail('moonlight-failed', `Moonlight pair exited with ${r.exitCode}: ${tail(r.stderr || r.stdout, 300).trim()}`, true);
        resp = await agentCall;
      } else {
        resp = raced.r;
      }
      if (resp.status === 'denied') throw new PairFail('approval-denied', 'The PC said no to this Mac.', false);
      if (resp.status === 'failed') throw new PairFail(resp.code, resp.message, RETRYABLE[resp.code] ?? true);
      if (resp.status !== 'paired') throw new PairFail('sunshine-api-error', `Unexpected agent answer: ${JSON.stringify(resp).slice(0, 200)}`, true);

      progress('confirming', 'PC accepted. Finishing in Moonlight…');
      await this.sleep(this.t.postSuccessFlushMs);
      await handle.terminate(this.t.terminateGraceMs);
      progress('verifying', 'Checking the pairing…');
      const verify = await this.list(ip);
      if (!verify.paired) throw new PairFail('verify-failed', `Moonlight still says it is not paired (list exit ${verify.exitCode}).`, true);
      progress('done', 'Paired.');
      return { ok: true, hostId: host.id, alreadyPaired: false, durationMs: now() - t0 };
    };

    const timeout = new Promise<PairResult>((_r, reject) => {
      overallTimer = setTimeout(() => reject(new PairFail('timeout', `Pairing took longer than ${this.t.overallTimeoutMs / 1000} s.`, true)), this.t.overallTimeoutMs);
    });
    try {
      return await Promise.race([run(), timeout]);
    } catch (e) {
      const f = e instanceof PairFail ? e : new PairFail('moonlight-failed', (e as Error)?.message ?? String(e), true);
      log.log('warn', 'pair', `pairing failed: ${f.code}`, { hostId: host.id, message: f.message });
      return { ok: false, hostId: host.id, code: f.code, message: f.message, retryable: f.retryable, durationMs: now() - t0 };
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
      const h = handle as MoonlightProcessHandle | null;
      if (h) await h.terminate(this.t.terminateGraceMs).catch(() => undefined);
    }
  }

  private sleep(ms: number) {
    return (this.d.sleep ?? ((x: number) => new Promise<void>((r) => setTimeout(r, x))))(ms);
  }

  private async list(ip: string): Promise<{ paired: boolean; exitCode: number | null }> {
    const r = await this.d.moonlight.isPaired(ip, this.t.listTimeoutMs);
    if (r.result.spawnError) throw new PairFail('moonlight-missing', `Moonlight is missing or cannot run (${r.result.spawnError}). Path: ${this.d.moonlight.binaryPath()}`, false);
    return { paired: r.paired, exitCode: r.result.exitCode };
  }

  private async callAgent(ip: string, body: AgentPairRequest, progress: (phase: PairProgress['phase'], m: string) => void): Promise<AgentPairResponse> {
    const req = this.d.agentRequest ?? agentRequest;
    const port = this.d.agentPort;
    let r: AgentHttpResult;
    try {
      // The agent may hold the request: pending wait (20 s) + Sunshine's handshake (ping_timeout).
      r = await req(ip, port, 'POST', '/v1/pair', body, LANPLAY.agentPendingWaitMs + 30_000);
    } catch (e) {
      throw new PairFail('agent-unreachable', `Cannot reach LanPlay on the PC (${ip}:${port}): ${(e as Error).message}. Is LanPlay running there and was "Set up this PC" done?`, true);
    }
    const code = mapHttp(r);
    if (code) throw code;
    let resp = r.json as AgentPairResponse;
    if (r.status === 202 && resp?.status === 'pending-approval') {
      progress('waiting-approval', 'Waiting for someone to click Approve on the PC…');
      const id = resp.requestId;
      const deadline = (this.d.now ?? Date.now)() + Math.max(resp.expiresInMs, 1000) + 5000;
      while ((this.d.now ?? Date.now)() < deadline) {
        await this.sleep(this.t.approvalPollMs);
        let s: AgentHttpResult;
        try {
          s = await req(ip, port, 'GET', `/v1/pair/${encodeURIComponent(id)}`, undefined, 45_000);
        } catch (e) {
          throw new PairFail('agent-unreachable', `Lost contact with the PC while waiting for approval: ${(e as Error).message}`, true);
        }
        const c = mapHttp(s);
        if (c) throw c;
        resp = s.json as AgentPairResponse;
        if (s.status === 200) return resp;
      }
      throw new PairFail('approval-timeout', 'Nobody approved this Mac on the PC in time.', true);
    }
    if (r.status !== 200 || !resp || typeof resp !== 'object') throw new PairFail('sunshine-api-error', `Agent answered HTTP ${r.status}`, true);
    return resp;
  }
}

function mapHttp(r: AgentHttpResult): PairFail | null {
  const err = (r.json as { error?: string; message?: string } | null)?.error ?? '';
  if (r.status === 403 || r.status === 421) return new PairFail('agent-forbidden', `The PC refused the request (${err || r.status}).`, false);
  if (r.status === 429) return new PairFail('agent-rate-limited', `Too many attempts; try again in ${r.retryAfter ?? 60} s.`, true);
  if (r.status === 400 || r.status === 413 || r.status === 415) return new PairFail('sunshine-api-error', `The PC rejected the request (${err || r.status}).`, false);
  if (r.status >= 500) return new PairFail('sunshine-api-error', `The PC had an internal error (${r.status}).`, true);
  if (r.status === 404) return new PairFail('approval-timeout', 'The pairing request expired on the PC.', true);
  return null;
}
