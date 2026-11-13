// Sunshine REST client (https://127.0.0.1:47990). Basic auth, JSON, NO Origin/Referer, pinned self-signed cert.
// API facts: https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/api.md and src/confighttp.cpp (see SUNSHINE_API).
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import { SUNSHINE, SUNSHINE_API, SunshineApiError } from '../../contracts.js';
import type { CreateSunshineClient, RestCallRecord, SunshineClient, SunshineClientEntry, SunshineClientOptions, SunshinePendingPairing } from '../../contracts.js';
import { DefaultRedactor } from '../shared/redact.js';

export const DEFAULT_SUNSHINE_BASE_URL = `https://127.0.0.1:${SUNSHINE.webUiPort}`;

/** colon-hex SHA-256 like X509Certificate.fingerprint256. */
export function certFingerprint256(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'LANPLAY_PIN_MISMATCH',
]);

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const HEX32 = /^[0-9a-fA-F]{32}$/;
const PIN4 = /^\d{4}$/;

export const createSunshineClient: CreateSunshineClient = (opts: SunshineClientOptions) => new HttpsSunshineClient(opts);

export class HttpsSunshineClient implements SunshineClient {
  private readonly base: URL;
  private readonly expectedFp: string;
  private readonly redactor = new DefaultRedactor();

  constructor(private readonly o: SunshineClientOptions) {
    this.base = new URL(o.baseUrl || DEFAULT_SUNSHINE_BASE_URL);
    if (this.base.protocol !== 'https:') throw new Error('Sunshine base URL must be https');
    this.expectedFp = certFingerprint256(o.pinnedCertPem);
  }

  private async request(method: string, pathName: string, body?: unknown, timeoutMs?: number): Promise<RawResponse> {
    const password = await this.o.getPassword();
    this.redactor.addSecret(password);
    const auth = 'Basic ' + Buffer.from(`${this.o.username}:${password}`, 'utf8').toString('base64');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const url = new URL(pathName, this.base);
    const t0 = Date.now();
    const rec: RestCallRecord = { at: new Date(t0).toISOString(), method, url: url.toString(), status: null, durationMs: 0 };
    if (payload !== undefined) rec.requestBody = this.redactor.redact(payload);
    const headers: Record<string, string> = { Authorization: auth, Accept: 'application/json' };
    // Never send Origin/Referer: "Requests with no Origin or Referer header ... are automatically allowed without a CSRF token" (docs/api.md).
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const expected = this.expectedFp;
    try {
      const res = await new Promise<RawResponse>((resolve, reject) => {
        const req = https.request(
          {
            protocol: 'https:',
            hostname: url.hostname.replace(/^\[|\]$/g, ''),
            port: url.port || 443,
            path: url.pathname + url.search,
            method,
            headers,
            agent: false,
            ca: [this.o.pinnedCertPem],
            rejectUnauthorized: true,
            checkServerIdentity: (_host: string, cert: PeerCertificate) => {
              if (!cert || cert.fingerprint256 !== expected) {
                const e = new Error(`Sunshine certificate does not match the pinned cacert.pem (got ${cert?.fingerprint256 ?? 'none'})`) as NodeJS.ErrnoException;
                e.code = 'LANPLAY_PIN_MISMATCH';
                return e;
              }
              return undefined;
            },
            timeout: timeoutMs ?? this.o.timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (c: Buffer) => {
              size += c.length;
              if (size <= 8 * 1024 * 1024) chunks.push(c);
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
          },
        );
        req.on('timeout', () => req.destroy(Object.assign(new Error('Sunshine request timed out'), { code: 'LANPLAY_TIMEOUT' })));
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      });
      rec.status = res.status;
      rec.durationMs = Date.now() - t0;
      rec.responseBody = this.redactor.redact(res.body.slice(0, 4096));
      this.o.onCall?.(rec);
      return res;
    } catch (err) {
      rec.durationMs = Date.now() - t0;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      rec.error = this.redactor.redact(`${code ? code + ': ' : ''}${(err as Error).message}`);
      this.o.onCall?.(rec);
      if (TLS_ERROR_CODES.has(code)) throw new SunshineApiError(`TLS pin check failed (${code}). The Sunshine certificate changed; run setup again.`, null, 'tls-pin-mismatch');
      if (code === 'LANPLAY_TIMEOUT') throw new SunshineApiError('Sunshine did not answer in time', null, 'timeout');
      throw new SunshineApiError(`Cannot reach Sunshine at ${this.base.origin}: ${code || (err as Error).message}`, null, 'network');
    }
  }

  private check(res: RawResponse, what: string): void {
    if (res.status >= 200 && res.status < 300) return;
    const loc = String(res.headers.location ?? '');
    if (res.status === 307 || res.status === 302 || res.status === 303) {
      if (loc.includes('/welcome')) throw new SunshineApiError(`${what}: Sunshine has no admin user yet (redirect to /welcome)`, res.status, 'redirect-welcome');
      throw new SunshineApiError(`${what}: unexpected redirect to ${loc}`, res.status, 'bad-response');
    }
    if (res.status === 401) throw new SunshineApiError(`${what}: Sunshine rejected the LanPlay admin password (401)`, 401, 'auth');
    if (res.status === 403) throw new SunshineApiError(`${what}: Sunshine refused the request origin (403)`, 403, 'forbidden-origin');
    if (res.status === 400) throw new SunshineApiError(`${what}: bad request (400): ${this.redactor.redact(res.body.slice(0, 300))}`, 400, 'bad-request');
    throw new SunshineApiError(`${what}: HTTP ${res.status}`, res.status, 'bad-response');
  }

  private json(res: RawResponse, what: string): Record<string, unknown> {
    this.check(res, what);
    try {
      const v = JSON.parse(res.body) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
    throw new SunshineApiError(`${what}: response is not a JSON object`, res.status, 'bad-response');
  }

  async getPendingPairings(): Promise<SunshinePendingPairing[]> {
    const r = this.json(await this.request(SUNSHINE_API.pendingPairings.method, SUNSHINE_API.pendingPairings.path), 'GET /api/pin');
    const list = Array.isArray(r.pairings) ? r.pairings : [];
    const out: SunshinePendingPairing[] = [];
    for (const p of list as Array<Record<string, unknown>>) {
      if (p && typeof p.id === 'string' && HEX32.test(p.id)) {
        out.push({ id: p.id, name: typeof p.name === 'string' ? p.name : '', address: typeof p.address === 'string' ? p.address : '' });
      }
    }
    return out;
  }

  async submitPin(req: { pairingId: string; pin: string; name: string }): Promise<boolean> {
    if (!HEX32.test(req.pairingId)) throw new SunshineApiError('pairing_id must contain exactly 32 hexadecimal characters', null, 'bad-request');
    if (!PIN4.test(req.pin)) throw new SunshineApiError('PIN must contain exactly 4 numeric digits', null, 'bad-request');
    const nameBytes = Buffer.byteLength(req.name, 'utf8');
    if (nameBytes < 1 || nameBytes > SUNSHINE.maxClientNameBytes) throw new SunshineApiError('name must be 1..128 bytes', null, 'bad-request');
    this.redactor.addSecret(req.pin);
    // The request "remains open for up to the configured ping_timeout" -> allow generously more than that.
    const timeout = Math.max(this.o.timeoutMs, SUNSHINE.pingTimeoutDefaultMs * 3);
    const r = this.json(
      await this.request(SUNSHINE_API.submitPin.method, SUNSHINE_API.submitPin.path, { pairing_id: req.pairingId, pin: req.pin, name: req.name }, timeout),
      'POST /api/pin',
    );
    return r.status === true || r.status === 'true';
  }

  async cancelPairing(pairingId: string): Promise<boolean> {
    if (!HEX32.test(pairingId)) throw new SunshineApiError('pairing_id must contain exactly 32 hexadecimal characters', null, 'bad-request');
    const r = this.json(await this.request(SUNSHINE_API.cancelPairing.method, SUNSHINE_API.cancelPairing.path, { pairing_id: pairingId }), 'DELETE /api/pin');
    return r.status === true || r.status === 'true';
  }

  async listClients(): Promise<SunshineClientEntry[]> {
    const r = this.json(await this.request(SUNSHINE_API.listClients.method, SUNSHINE_API.listClients.path), 'GET /api/clients/list');
    const list = Array.isArray(r.named_certs) ? r.named_certs : [];
    return (list as Array<Record<string, unknown>>)
      .filter((c) => c && typeof c.uuid === 'string')
      .map((c) => ({ name: typeof c.name === 'string' ? c.name : '', uuid: String(c.uuid), enabled: c.enabled === undefined ? true : c.enabled === true || c.enabled === 'true' }));
  }

  async unpairClient(uuid: string): Promise<boolean> {
    if (!/^[0-9A-Za-z-]{1,64}$/.test(uuid)) throw new SunshineApiError('invalid uuid', null, 'bad-request');
    const r = this.json(await this.request(SUNSHINE_API.unpairClient.method, SUNSHINE_API.unpairClient.path, { uuid }), 'POST /api/clients/unpair');
    return r.status === true || r.status === 'true';
  }

  async getVersion(): Promise<string> {
    const r = this.json(await this.request(SUNSHINE_API.getConfig.method, SUNSHINE_API.getConfig.path), 'GET /api/config');
    return typeof r.version === 'string' ? r.version : 'unknown';
  }

  async getLogsTail(maxBytes: number): Promise<string> {
    const res = await this.request(SUNSHINE_API.getLogs.method, SUNSHINE_API.getLogs.path, undefined, Math.max(this.o.timeoutMs, 15_000));
    this.check(res, 'GET /api/logs');
    const buf = Buffer.from(res.body, 'utf8');
    return buf.length <= maxBytes ? res.body : buf.subarray(buf.length - maxBytes).toString('utf8');
  }
}
