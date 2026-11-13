// Mock Sunshine web UI / REST server, built ONLY from documented behaviour (pinned tag v2026.914.233613):
//  - Basic auth: "You can authenticate using basic authentication with the admin username and password."
//    https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/api.md
//  - No admin user yet -> authenticate() redirects to /welcome (307). confighttp.cpp#L595-L635
//  - CSRF: "Requests with no Origin or Referer header ... are automatically allowed without a CSRF token" (docs/api.md);
//    with Origin/Referer and no token -> rejected (400 here).
//  - origin_web_ui_allowed=lan: non-LAN remote -> 403. confighttp.cpp#L595-L635
//  - POST/DELETE require Content-Type application/json (check_content_type, confighttp.cpp#L684).
//  - GET /api/pin {"pairings":[{"id","name","address"}]} confighttp.cpp#L1741-L1763
//  - POST /api/pin {"pairing_id","pin","name"} held "up to the configured ping_timeout" -> {"status":bool};
//    errors "pairing_id must contain exactly 32 hexadecimal characters", "PIN must contain exactly 4 numeric digits".
//    confighttp.cpp#L1810-L1869
//  - DELETE /api/pin {"pairing_id"} confighttp.cpp#L1765-L1808
//  - GET /api/clients/list {"named_certs":[{name,uuid,enabled}],"status":true} confighttp.cpp#L1255-L1275
//  - POST /api/clients/unpair {"uuid"} confighttp.cpp#L1332-L1380
//  - GET /api/config {"status":true,"platform","version",...} confighttp.cpp#L1409-L1435
// Plus a plain-HTTP test hook (used by tests/fixtures/fake-moonlight.mjs) to register a pending pairing the way
// Moonlight's `pair` would (nvhttp.cpp#L979 stores the normalised client address).
import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const here = __dirname;
export const SUNSHINE_TEST_CERT = readFileSync(path.join(here, 'certs', 'sunshine-cert.pem'), 'utf8');
const SUNSHINE_TEST_KEY = readFileSync(path.join(here, 'certs', 'sunshine-key.pem'), 'utf8');
export const WRONG_TEST_CERT = readFileSync(path.join(here, 'certs', 'wrong-cert.pem'), 'utf8');
const WRONG_TEST_KEY = readFileSync(path.join(here, 'certs', 'wrong-key.pem'), 'utf8');

export interface MockPending {
  id: string;
  name: string;
  address: string;
  /** PIN the "Moonlight" side entered; POST /api/pin succeeds only if it matches. */
  expectedPin: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface MockSunshineOptions {
  username?: string;
  password?: string;
  /** No admin user configured yet -> 307 /welcome. */
  noUser?: boolean;
  /** Serve a different certificate than SUNSHINE_TEST_CERT (pin mismatch tests). */
  wrongCert?: boolean;
  version?: string;
  /** Delay before POST /api/pin answers (simulates the held handshake). */
  handshakeDelayMs?: number;
  /** Override handshake result. Default: pin === expectedPin. */
  handshake?: (p: MockPending, pin: string) => boolean | Promise<boolean>;
  /** Treat requests as coming from a non-LAN origin (403). */
  forbidOrigin?: boolean;
}

export interface MockSunshine {
  url: string;
  port: number;
  hookUrl: string;
  requests: RecordedRequest[];
  pending: MockPending[];
  clients: Array<{ name: string; uuid: string; enabled: boolean }>;
  addPending(p: Omit<MockPending, 'id'> & { id?: string }): MockPending;
  setPassword(pw: string): void;
  setNoUser(v: boolean): void;
  logText: string;
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startMockSunshine(opts: MockSunshineOptions = {}): Promise<MockSunshine> {
  let username = opts.username ?? 'lanplay';
  let password = opts.password ?? 'test-password-0123456789';
  let noUser = opts.noUser ?? false;
  const requests: RecordedRequest[] = [];
  const pending: MockPending[] = [];
  const clients: Array<{ name: string; uuid: string; enabled: boolean }> = [];
  const version = opts.version ?? '2026.914.233613';

  const addPending = (p: Omit<MockPending, 'id'> & { id?: string }): MockPending => {
    const full: MockPending = { id: p.id ?? randomBytes(16).toString('hex'), name: p.name, address: p.address, expectedPin: p.expectedPin };
    pending.push(full);
    return full;
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    const url = new URL(req.url ?? '/', 'https://127.0.0.1');

    if (opts.forbidOrigin) return json(res, 403, { status_code: 403, status: false, error: 'Forbidden' });
    if (noUser) {
      res.writeHead(307, { Location: '/welcome' });
      return res.end();
    }
    const auth = req.headers.authorization ?? '';
    const expected = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    if (auth !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Sunshine Gamestream Host", charset="UTF-8"' });
      return res.end();
    }
    if ((req.headers.origin || req.headers.referer) && !req.headers['x-csrf-token']) {
      return json(res, 400, { status_code: 400, status: false, error: 'Missing CSRF token' });
    }
    if ((req.method === 'POST' || req.method === 'DELETE') && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return json(res, 400, { status_code: 400, status: false, error: 'Content type not supported' });
    }
    let parsed: Record<string, unknown> = {};
    if (body) {
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return json(res, 400, { status_code: 400, status: false, error: 'Invalid JSON' });
      }
    }

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/pin':
        return json(res, 200, { pairings: pending.map(({ id, name, address }) => ({ id, name, address })) });
      case 'POST /api/pin': {
        const id = String(parsed.pairing_id ?? '');
        const pin = String(parsed.pin ?? '');
        const name = String(parsed.name ?? '');
        if (!/^[0-9a-fA-F]{32}$/.test(id)) return json(res, 400, { status_code: 400, status: false, error: 'pairing_id must contain exactly 32 hexadecimal characters' });
        if (!/^\d{4}$/.test(pin)) return json(res, 400, { status_code: 400, status: false, error: 'PIN must contain exactly 4 numeric digits' });
        const nb = Buffer.byteLength(name);
        if (nb < 1 || nb > 128) return json(res, 400, { status_code: 400, status: false, error: 'name must be 1-128 bytes' });
        const idx = pending.findIndex((p) => p.id.toLowerCase() === id.toLowerCase());
        if (idx < 0) return json(res, 200, { status: false });
        const p = pending[idx]!;
        if (opts.handshakeDelayMs) await new Promise((r) => setTimeout(r, opts.handshakeDelayMs));
        const ok = opts.handshake ? await opts.handshake(p, pin) : pin === p.expectedPin;
        pending.splice(pending.indexOf(p), 1);
        if (ok) clients.push({ name, uuid: randomUUID().toUpperCase(), enabled: true });
        return json(res, 200, { status: ok });
      }
      case 'DELETE /api/pin': {
        const id = String(parsed.pairing_id ?? '');
        const idx = pending.findIndex((p) => p.id === id);
        if (idx >= 0) pending.splice(idx, 1);
        return json(res, 200, { status: idx >= 0 });
      }
      case 'GET /api/clients/list':
        return json(res, 200, { named_certs: clients, status: true });
      case 'POST /api/clients/unpair': {
        const idx = clients.findIndex((c) => c.uuid === parsed.uuid);
        if (idx >= 0) clients.splice(idx, 1);
        return json(res, 200, { status: idx >= 0 });
      }
      case 'GET /api/config':
        return json(res, 200, { status: true, platform: 'windows', version, origin_web_ui_allowed: 'lan' });
      case 'GET /api/logs': {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(mock.logText);
      }
      default:
        return json(res, 404, { status_code: 404, status: false, error: 'Not Found' });
    }
  };

  const server = https.createServer(
    { cert: opts.wrongCert ? WRONG_TEST_CERT : SUNSHINE_TEST_CERT, key: opts.wrongCert ? WRONG_TEST_KEY : SUNSHINE_TEST_KEY },
    (req, res) => void handler(req, res),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  // Test hook (plain HTTP): POST /hook/pair {"address","name","pin"} registers a pending pairing like Moonlight would.
  const hook = http.createServer((req, res) => {
    void readBody(req).then((b) => {
      if (req.method === 'POST' && req.url === '/hook/pair') {
        const p = JSON.parse(b) as { address: string; name: string; pin: string };
        const added = addPending({ address: p.address, name: p.name, expectedPin: p.pin });
        return json(res, 200, { id: added.id });
      }
      if (req.method === 'GET' && req.url === '/hook/state') return json(res, 200, { pending, clients });
      return json(res, 404, {});
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = (hook.address() as AddressInfo).port;

  const mock: MockSunshine = {
    url: `https://127.0.0.1:${port}`,
    port,
    hookUrl: `http://127.0.0.1:${hookPort}`,
    requests,
    pending,
    clients,
    addPending,
    setPassword: (pw) => {
      password = pw;
      username = opts.username ?? 'lanplay';
    },
    setNoUser: (v) => {
      noUser = v;
    },
    logText: '[2026-11-13 10:00:00.000]: Info: Sunshine version: v2026.914.233613\n',
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        hook.closeAllConnections();
        server.close(() => hook.close(() => r()));
      }),
  };
  return mock;
}
