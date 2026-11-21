// LAN server for phone controllers: serves the phone page, the layout API and the input WebSocket.
// Threat model: anything on the home network can reach the port, so every request must (1) come from a private address,
// (2) address the host by IP (no DNS-rebinding hostnames), (3) not be a cross-site browser request, and for the API and the
// socket (4) carry the access token shown only on the host screen. The token is persistent (saved links and home-screen
// shortcuts keep working); only "New link" replaces it. Input frames are clamped by parseClientMessage.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import { parseHostHeader } from '../shared/ipnet.js';
import { LIMITS, defaultLayout } from './layout.js';
import type { LayoutFileStore } from './layout-store.js';
import type { ControllerManager } from './manager.js';
import { parseClientMessage, sanitizePhoneId } from './protocol.js';
import type { ServerMessage } from './protocol.js';

export interface ControllerServerOptions {
  manager: ControllerManager;
  layouts: LayoutFileStore;
  /** Folder with index.html, controller.js, controller.css and the other static files (dist/controller-ui); read into memory once. */
  uiDir: string;
  port: number;
  token: string;
  /** Production: isPrivateAddress. Tests inject their own. */
  isAllowedAddress(address: string): boolean;
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void;
  tickMs?: number;
}

interface StaticEntry {
  file: string;
  type: string;
  /** Compress with gzip (text types; images and video are already compressed). */
  gzip: boolean;
  /** Honour a single Range header (iOS Safari will not play a video from a server without it). */
  ranges?: boolean;
}
const TEXT = true;
const STATIC: Record<string, StaticEntry> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', gzip: TEXT },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', gzip: TEXT },
  '/controller.js': { file: 'controller.js', type: 'text/javascript; charset=utf-8', gzip: TEXT },
  '/controller.css': { file: 'controller.css', type: 'text/css; charset=utf-8', gzip: TEXT },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png', gzip: false },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png', gzip: false },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png', gzip: false },
  // Home-screen install info; contains no token, so it is served like the other static files.
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8', gzip: TEXT },
  // Tiny looping video the page plays to keep the screen on where the Wake Lock API is missing.
  '/wake.mp4': { file: 'wake.mp4', type: 'video/mp4', gzip: false, ranges: true },
};

interface Asset {
  raw: Buffer;
  gz: Buffer | null;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; manifest-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HELLO_TIMEOUT_MS = 5000;
const MAX_SOCKETS = 8;
const MAX_SOCKETS_PER_IP = 6;
const MAX_FRAMES_PER_SEC = 300;
const API_WINDOW_MS = 10_000;
const API_MAX_PER_WINDOW = 60;

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

interface Conn {
  id: string;
  ws: WebSocket;
  address: string;
  joined: boolean;
  /** Phone id from hello, once validated. */
  phoneId: string | undefined;
  windowStart: number;
  frames: number;
}

export class ControllerServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly conns = new Map<string, Conn>();
  private readonly apiHits = new Map<string, { start: number; n: number }>();
  private readonly tokenDigest: Buffer;
  private readonly assets = new Map<string, Asset>();

  constructor(private readonly o: ControllerServerOptions) {
    this.tokenDigest = digest(o.token);
  }

  get token(): string {
    return this.o.token;
  }

  /** Resolves with the real port (pass port 0 in tests). */
  async start(): Promise<number> {
    await this.loadAssets();
    return this.listen();
  }

  /** Reads every static file once. A file that is missing now is tried again on the first request for it. */
  private async loadAssets(): Promise<void> {
    await Promise.all(Object.values(STATIC).map((e) => this.asset(e)));
  }

  private async asset(e: StaticEntry): Promise<Asset | null> {
    const have = this.assets.get(e.file);
    if (have) return have;
    try {
      const raw = await readFile(path.join(this.o.uiDir, e.file));
      const gz = e.gzip ? gzipSync(raw, { level: 9 }) : null;
      const a: Asset = { raw, gz: gz && gz.length < raw.length ? gz : null };
      this.assets.set(e.file, a);
      return a;
    } catch {
      return null;
    }
  }

  private listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => void this.onRequest(req, res));
      this.http = http;
      this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
      http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket as Socket, head));
      http.on('error', reject);
      http.listen(this.o.port, '0.0.0.0', () => {
        http.off('error', reject);
        const addr = http.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.o.port;
        this.timer = setInterval(() => this.onTick(), this.o.tickMs ?? 1000);
        this.timer.unref();
        this.o.log('info', 'phone controller server listening', { port });
        resolve(port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.conns.values()) c.ws.terminate();
    this.conns.clear();
    this.assets.clear();
    this.o.manager.closeAll();
    this.wss?.close();
    const http = this.http;
    this.http = null;
    if (http) await new Promise<void>((r) => http.close(() => r()));
  }

  /** Remove a player from the host screen: tells the phone, releases the pad, closes the socket. */
  kick(playerId: string): boolean {
    const c = this.conns.get(playerId);
    const ok = this.o.manager.kick(playerId);
    if (c) {
      this.send(c.ws, { t: 'kicked' });
      c.ws.close(1000, 'kicked');
    }
    return ok;
  }

  // ---- guards -------------------------------------------------------------------------------------------------

  /** Private source address, IP-literal Host header (net.isIP, so a DNS name made of hex letters does not pass), and (when a browser sends one) same-origin. */
  private guard(req: IncomingMessage): { ok: true; address: string } | { ok: false; status: number; reason: string } {
    const address = req.socket.remoteAddress ?? '';
    if (!this.o.isAllowedAddress(address)) return { ok: false, status: 403, reason: 'address' };
    const host = parseHostHeader(req.headers.host);
    if (!host || isIP(host.host) === 0) return { ok: false, status: 421, reason: 'host' };
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let oh = '';
      try {
        oh = new URL(origin).host;
      } catch {
        /* falls through to the mismatch below */
      }
      if (oh !== req.headers.host) return { ok: false, status: 403, reason: 'origin' };
    }
    return { ok: true, address };
  }

  private tokenOk(url: URL): boolean {
    const t = url.searchParams.get('t');
    return t !== null && timingSafeEqual(digest(t), this.tokenDigest);
  }

  private apiAllowed(address: string): boolean {
    const now = Date.now();
    const h = this.apiHits.get(address);
    if (!h || now - h.start > API_WINDOW_MS) {
      this.apiHits.set(address, { start: now, n: 1 });
      if (this.apiHits.size > 256) this.apiHits.clear();
      return true;
    }
    return ++h.n <= API_MAX_PER_WINDOW;
  }

  // ---- HTTP ---------------------------------------------------------------------------------------------------

  private reply(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const g = this.guard(req);
      if (!g.ok) return this.reply(res, g.status, 'Forbidden');
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await this.onApi(req, res, url, g.address);
      const st = req.method === 'GET' || req.method === 'HEAD' ? STATIC[url.pathname] : undefined;
      if (!st) return this.reply(res, 404, 'Not found');
      const a = await this.asset(st);
      if (!a) return this.reply(res, 404, 'Not found');
      this.sendAsset(req, res, st, a);
    } catch (e) {
      this.o.log('warn', 'controller http error', { error: (e as Error).message });
      if (!res.headersSent) this.reply(res, 500, 'Server error');
    }
  }

  private sendAsset(req: IncomingMessage, res: ServerResponse, st: StaticEntry, a: Asset): void {
    const head = req.method === 'HEAD';
    const base = {
      'Content-Type': st.type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Accept-Encoding',
    };
    if (a.gz && acceptsGzip(req.headers['accept-encoding'])) {
      res.writeHead(200, { ...base, 'Content-Encoding': 'gzip', 'Content-Length': a.gz.length });
      res.end(head ? undefined : a.gz);
      return;
    }
    const total = a.raw.length;
    if (st.ranges) {
      const range = parseRange(req.headers.range, total);
      if (range === 'bad') {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${total}`, 'Content-Length': 0 });
        res.end();
        return;
      }
      if (range) {
        res.writeHead(206, { ...base, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${range.start}-${range.end}/${total}`, 'Content-Length': range.end - range.start + 1 });
        res.end(head ? undefined : a.raw.subarray(range.start, range.end + 1));
        return;
      }
    }
    res.writeHead(200, { ...base, ...(st.ranges ? { 'Accept-Ranges': 'bytes' } : {}), 'Content-Length': total });
    res.end(head ? undefined : a.raw);
  }

  private async onApi(req: IncomingMessage, res: ServerResponse, url: URL, address: string): Promise<void> {
    if (!this.tokenOk(url)) return this.reply(res, 401, 'Bad or missing token');
    if (!this.apiAllowed(address)) return this.reply(res, 429, 'Slow down');
    const json = (status: number, v: unknown) => this.reply(res, status, JSON.stringify(v), 'application/json; charset=utf-8');
    const phoneId = sanitizePhoneId(url.searchParams.get('id') ?? undefined);
    if (url.pathname === '/api/layouts' && req.method === 'GET') return json(200, this.o.layouts.get(address, phoneId));
    if (url.pathname === '/api/default-layout' && req.method === 'GET') return json(200, defaultLayout());
    if (url.pathname === '/api/layouts' && req.method === 'PUT') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return this.reply(res, 415, 'Send application/json');
      const body = await readBody(req, LIMITS.maxStoreBytes);
      if (body === null) {
        res.setHeader('Connection', 'close');
        return this.reply(res, 413, 'Too large');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return this.reply(res, 400, 'Bad JSON');
      }
      return json(200, this.o.layouts.put(address, parsed, phoneId));
    }
    return this.reply(res, 404, 'Not found');
  }

  // ---- WebSocket ----------------------------------------------------------------------------------------------

  private refuse(socket: Socket, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const g = this.guard(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!g.ok) return this.refuse(socket, `${g.status} Forbidden`);
    if (url.pathname !== '/ws') return this.refuse(socket, '404 Not Found');
    if (!this.tokenOk(url)) return this.refuse(socket, '401 Unauthorized');
    const perIp = [...this.conns.values()].filter((c) => c.address === g.address).length;
    if (this.conns.size >= MAX_SOCKETS || perIp >= MAX_SOCKETS_PER_IP) return this.refuse(socket, '503 Service Unavailable');
    this.wss?.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, g.address));
  }

  private send(ws: WebSocket, m: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  }

  private onConnection(ws: WebSocket, address: string): void {
    const c: Conn = { id: randomBytes(8).toString('hex'), ws, address, joined: false, phoneId: undefined, windowStart: Date.now(), frames: 0 };
    this.conns.set(c.id, c);
    const helloTimer = setTimeout(() => {
      if (!c.joined) ws.close(1008, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - c.windowStart >= 1000) {
        c.windowStart = now;
        c.frames = 0;
      }
      if (++c.frames > MAX_FRAMES_PER_SEC) {
        ws.close(1008, 'too many messages');
        return;
      }
      const m = parseClientMessage(data.toString('utf8'));
      if (!m) return;
      if (m.t === 'hello') {
        if (c.joined) return;
        const r = this.o.manager.join(c.id, m.name, address, m.id);
        if (r.ok) {
          c.joined = true;
          c.phoneId = m.id;
          // The OLD socket gets close reason 'replaced' (documented in protocol.ts): the page treats it as final so two tabs of one phone
          // do not take the slot from each other in a loop.
          if (r.replaced) this.conns.get(r.replaced)?.ws.close(1000, 'replaced');
          this.send(ws, { t: 'welcome', slot: r.slot });
        } else {
          if (r.reason === 'driver') this.o.log('warn', 'phone controller: cannot create a virtual pad', { message: r.message });
          this.send(ws, { t: 'full' });
          ws.close(1000, r.reason);
        }
        return;
      }
      if (!c.joined) return;
      if (m.t === 's') this.o.manager.update(c.id, m.pad);
      else if (m.t === 'p') this.send(ws, { t: 'p', n: m.n });
      else this.o.manager.keepalive(c.id);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(c.id);
      this.o.manager.detach(c.id);
    });
    ws.on('error', () => ws.terminate());
  }

  private onTick(): void {
    for (const id of this.o.manager.tick()) this.conns.get(id)?.ws.close(1001, 'idle');
  }
}

function acceptsGzip(h: string | undefined): boolean {
  if (!h) return false;
  for (const part of h.split(',')) {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (!q || Number(q.slice(2)) > 0) return true;
  }
  return false;
}

/** One "bytes=a-b" / "bytes=a-" / "bytes=-n" range. null: no usable header (send the whole file); 'bad': 416. */
function parseRange(h: string | undefined, total: number): { start: number; end: number } | 'bad' | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  return start > end || start >= total ? 'bad' : { start, end };
}

/** Collects at most maxBytes; null if the body is larger (the rest of it is read and thrown away). */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      n += c.length;
      if (n > maxBytes) {
        over = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
