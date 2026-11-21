// No-PIN-typing pairing (client side). moonlight-qt does not print its PIN, it ACCEPTS one (--pin), so we generate it:
//  1. `Moonlight list <ip>` exit 0 -> already paired.
//  2. pin = randomInt(0,10000); spawn `Moonlight pair <ip> --pin <pin>`; POST http://<ip>:47920/v1/pair {pin, clientName, clientId}.
//  3. agent finds Moonlight's pending pairing (by our address) and submits the PIN to Sunshine.
//  4. wait PAIR_TIMING.postSuccessFlushMs, end the pair window, verify with `Moonlight list <ip>`.
// Internet host (host.remote): no agent (it never leaves the LAN). The PIN is shown to the player (phase 'show-code'), who reads it
// out; the host owner types it into LanPlay on the host. We wait for `Moonlight pair` to exit or `Moonlight list` to say paired.
import http from 'node:http';
import { randomInt } from 'node:crypto';
import net from 'node:net';
import { LANPLAY, PAIR_TIMING } from '../../contracts.js';
import type { AgentPairRequest, AgentPairResponse, HostInfo, Logger, MoonlightProcessHandle, MoonlightRunner, PairErrorCode, PairingService, PairProgress, PairResult } from '../../contracts.js';
import { tail } from '../shared/exec.js';
import { isPrivateAddress } from '../shared/ipnet.js';
import { moonlightTarget } from './moonlight.js';

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
  timing?: Partial<Record<keyof typeof PAIR_TIMING | 'approvalPollMs' | 'listTimeoutMs' | 'leftoverWaitMs' | 'codeWaitMs' | 'codePollMs', number>>;
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
  'code-timeout': true,
  timeout: true,
};

export class ClientPairingService implements PairingService {
  constructor(private readonly d: PairingDeps) {}

  private get t() {
    const base: Record<keyof typeof PAIR_TIMING | 'approvalPollMs' | 'listTimeoutMs' | 'leftoverWaitMs' | 'codeWaitMs' | 'codePollMs', number> = { ...PAIR_TIMING, approvalPollMs: 1000, listTimeoutMs: 20_000, leftoverWaitMs: 5000, codeWaitMs: 180_000, codePollMs: 5000 };
    return { ...base, ...(this.d.timing ?? {}) };
  }

  async pair(host: HostInfo, onProgress: (p: PairProgress) => void): Promise<PairResult> {
    const now = this.d.now ?? Date.now;
    const t0 = now();
    const log = this.d.log;
    const progress = (phase: PairProgress['phase'], message: string, code?: string) => {
      log.log('info', 'pair', `${phase}: ${message}`, { hostId: host.id });
      try {
        onProgress(code === undefined ? { hostId: host.id, phase, message } : { hostId: host.id, phase, message, code });
      } catch {
        /* ignore UI errors */
      }
    };
    let handle: MoonlightProcessHandle | null = null;
    /** Set by attemptWithCode when Moonlight exited non-zero within leftoverWaitMs of starting (a refused leftover pairing). */
    let quickExit = false;
    let overallTimer: NodeJS.Timeout | undefined;
    const run = async (): Promise<PairResult> => {
      const ip = moonlightTarget(host);
      // Defence in depth (callAgent checks again): the pair agent is for home-network PCs only. A non-remote host with a
      // public address means host.remote was set wrong, and the PIN must never be sent there.
      if (!host.remote) assertPrivate(ip);
      progress('checking', 'Checking whether this Mac is already paired...');
      const first = await this.list(ip);
      if (first.paired) {
        progress('done', 'Already paired.');
        return { ok: true, hostId: host.id, alreadyPaired: true, durationMs: now() - t0 };
      }
      if (host.remote) {
        // Sunshine keeps the pending pairing of a timed-out code for up to 5 minutes (see the comment below), so the next
        // attempt can be refused at once (HTTP 409, Moonlight exits non-zero within seconds); that refusal erases the leftover.
        // Retry once on such a quick failure so "Press Stream to get a new code" works the first time.
        for (let attempt = 1; ; attempt++) {
          quickExit = false;
          try {
            return await attemptWithCode(ip);
          } catch (e) {
            const retry = e instanceof PairFail && e.code === 'moonlight-failed' && quickExit && attempt < 2;
            if (!retry) throw e;
            log.log('info', 'pair', 'first attempt hit a leftover pairing on the host; trying once more', { hostId: host.id });
            const h = handle as MoonlightProcessHandle | null;
            handle = null;
            if (h) await h.terminate(this.t.terminateGraceMs).catch(() => undefined);
            progress('starting-moonlight', 'Clearing an old pairing attempt and trying again...');
          }
        }
      }
      /**
       * Sunshine keeps at most ONE pending pairing per Moonlight client id ("map_id_sess.emplace(sess.client.uniqueID, ...)",
       * a second getservercert gets HTTP 409 "A pairing session with this uniqueid already exists") for up to 5 minutes
       * (PAIRING_SESSION_TIMEOUT). A leftover from an interrupted earlier attempt therefore makes the next attempt fail
       * once; that failure erases the leftover ("complete_pairing(sess, false); map_id_sess.erase(sess_it);"), so a
       * second try succeeds. Retry once here instead of making the user press the button twice.
       * https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/nvhttp.cpp (insert_pair_session, pin)
       */
      const maxAttempts = 2;
      for (let attempt = 1; ; attempt++) {
        try {
          return await attemptOnce(ip);
        } catch (e) {
          const retry = e instanceof PairFail && e.code === 'wrong-pin' && attempt < maxAttempts;
          if (!retry) throw e;
          log.log('info', 'pair', 'first attempt hit a leftover pairing on the PC; trying once more', { hostId: host.id });
          const h = handle as MoonlightProcessHandle | null;
          handle = null;
          if (h) await h.terminate(this.t.terminateGraceMs).catch(() => undefined);
          progress('starting-moonlight', 'Clearing an old pairing attempt and trying again...');
        }
      }
    };

    const attemptOnce = async (ip: string): Promise<PairResult> => {
      const pin = (this.d.pin ?? generatePin)();
      log.redactor.addSecret(pin);
      progress('starting-moonlight', 'Starting Moonlight pairing...');
      const started = this.d.moonlight.startPair(ip, pin);
      handle = started;
      const early = started.exited.then((r) => r);

      progress('contacting-agent', `Asking ${host.name} to accept this Mac...`);
      const req: AgentPairRequest = { pin, clientName: this.d.clientName(), clientId: this.d.clientId() };
      const addrs = this.d.clientAddresses?.().slice(0, 8) ?? [];
      if (addrs.length) req.clientAddresses = addrs;
      const agentCall = this.callAgent(ip, req, progress);
      // If Moonlight dies before the agent answers, report Moonlight's error rather than waiting.
      const raced = await Promise.race([agentCall.then((r) => ({ kind: 'agent' as const, r })), early.then((r) => ({ kind: 'moonlight' as const, r }))]);
      let resp: AgentPairResponse;
      if (raced.kind === 'moonlight') {
        const r = raced.r;
        // The agent call is still running; its late failure must not become an unhandled rejection.
        if (r.spawnError || r.exitCode !== 0) agentCall.catch(() => undefined);
        if (r.spawnError) throw new PairFail('moonlight-missing', `Moonlight could not start: ${r.spawnError}`, false);
        if (r.exitCode !== 0) {
          // A leftover pairing on the PC makes Moonlight fail at once (HTTP 409); give the agent a moment to report
          // (and thereby clear) it, so the automatic second attempt can run.
          const late = await Promise.race([agentCall.then((x) => x, () => null), new Promise<null>((res) => setTimeout(() => res(null), this.t.leftoverWaitMs))]);
          if (late && late.status === 'failed' && late.code === 'wrong-pin') throw new PairFail('wrong-pin', late.message, true);
          throw new PairFail('moonlight-failed', `Moonlight pair exited with ${r.exitCode}: ${tail(r.stderr || r.stdout, 300).trim()}`, true);
        }
        resp = await agentCall;
      } else {
        resp = raced.r;
      }
      if (resp.status === 'denied') throw new PairFail('approval-denied', 'The PC said no to this Mac.', false);
      if (resp.status === 'failed') throw new PairFail(resp.code, resp.message, RETRYABLE[resp.code] ?? true);
      if (resp.status !== 'paired') throw new PairFail('sunshine-api-error', `Unexpected agent answer: ${JSON.stringify(resp).slice(0, 200)}`, true);

      progress('confirming', 'PC accepted. Finishing in Moonlight...');
      await this.sleep(this.t.postSuccessFlushMs);
      await started.terminate(this.t.terminateGraceMs);
      progress('verifying', 'Checking the pairing...');
      const verify = await this.list(ip);
      if (!verify.paired) throw new PairFail('verify-failed', `Moonlight still says it is not paired (list exit ${verify.exitCode}).`, true);
      progress('done', 'Paired.');
      return { ok: true, hostId: host.id, alreadyPaired: false, durationMs: now() - t0 };
    };

    /** Internet host: the code never leaves this Mac except inside Moonlight's own pairing handshake with Sunshine. The agent is not involved. */
    const attemptWithCode = async (target: string): Promise<PairResult> => {
      const pin = (this.d.pin ?? generatePin)();
      log.redactor.addSecret(pin);
      progress('starting-moonlight', 'Starting Moonlight pairing...');
      const started = this.d.moonlight.startPair(target, pin);
      handle = started;
      const startedAt = now();
      const minutes = Math.round(this.t.codeWaitMs / 60_000);
      progress('show-code', `Tell the host this code. Waiting for them to enter it (${minutes} min).`, pin);

      let stop = false;
      let waitTimer: NodeJS.Timeout | undefined;
      const exited = started.exited.then((r) => ({ kind: 'exited' as const, r }));
      const expired = new Promise<{ kind: 'expired' }>((res) => {
        waitTimer = setTimeout(() => res({ kind: 'expired' }), this.t.codeWaitMs);
      });
      // `Moonlight pair` may stay open after success (it quits only when its dialog is closed): also ask `list`.
      const polled = (async (): Promise<{ kind: 'paired' }> => {
        while (!stop) {
          await this.sleep(this.t.codePollMs);
          if (stop) break;
          try {
            if ((await this.list(target)).paired) return { kind: 'paired' };
          } catch {
            /* keep waiting; the exit or the deadline decides */
          }
        }
        return new Promise<{ kind: 'paired' }>(() => undefined);
      })();
      let outcome: { kind: 'exited'; r: Awaited<typeof started.exited> } | { kind: 'paired' } | { kind: 'expired' };
      try {
        outcome = await Promise.race([exited, polled, expired]);
      } finally {
        stop = true;
        if (waitTimer) clearTimeout(waitTimer);
      }
      if (outcome.kind === 'expired') throw new PairFail('code-timeout', 'The host did not enter the code in time. Press Stream to get a new code.', true);
      if (outcome.kind === 'exited') {
        const r = outcome.r;
        if (r.spawnError) throw new PairFail('moonlight-missing', `Moonlight could not start: ${r.spawnError}`, false);
        if (r.exitCode !== 0) {
          quickExit = now() - startedAt < this.t.leftoverWaitMs;
          throw new PairFail('moonlight-failed', `Moonlight pair exited with ${r.exitCode}: ${tail(r.stderr || r.stdout, 300).trim()}`, true);
        }
      }
      progress('confirming', 'The host entered the code. Finishing in Moonlight...');
      // A Moonlight that exited by itself has already flushed its settings; one that stayed open gets the usual grace.
      if (outcome.kind === 'paired') {
        await this.sleep(this.t.postSuccessFlushMs);
        await started.terminate(this.t.terminateGraceMs);
      }
      progress('verifying', 'Checking the pairing...');
      const verify = await this.list(target);
      if (!verify.paired) throw new PairFail('verify-failed', `Moonlight still says it is not paired (list exit ${verify.exitCode}).`, true);
      progress('done', 'Paired.');
      return { ok: true, hostId: host.id, alreadyPaired: false, durationMs: now() - t0 };
    };

    const overallMs = host.remote ? this.t.overallTimeoutMs + this.t.codeWaitMs : this.t.overallTimeoutMs;
    const timeout = new Promise<PairResult>((_r, reject) => {
      overallTimer = setTimeout(() => reject(new PairFail('timeout', `Pairing took longer than ${overallMs / 1000} s.`, true)), overallMs);
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
    assertPrivate(ip);
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
      progress('waiting-approval', 'Waiting for someone to click Approve on the PC...');
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

/** The pair agent (and the PIN we send it) must only ever be addressed at a home-network IP. */
function assertPrivate(ip: string): void {
  if (!isPrivateAddress(ip)) throw new PairFail('agent-forbidden', 'LanPlay only asks PCs on your home network to accept this Mac. For a PC on the internet, add it with its address and use the code.', false);
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
