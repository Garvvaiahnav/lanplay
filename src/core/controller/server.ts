// LAN server for phone controllers: serves the phone page, the layout API and the input WebSocket.
// Threat model: anything on the home network can reach the port, so every request must (1) come from a private address,
// (2) address the host by IP (no DNS-rebinding hostnames), (3) not be a cross-site browser request, and for the API and the
// socket (4) carry the per-session token shown only on the host screen. Input frames are clamped by parseClientMessage.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import { parseHostHeader } from '../shared/ipnet.js';
import { LIMITS, defaultLayout } from './layout.js';
import type { LayoutFileStore } from './layout-store.js';
import type { ControllerManager } from './manager.js';
import { parseClientMessage } from './protocol.js';
import type { ServerMessage } from './protocol.js';

export interface ControllerServerOptions {
  manager: ControllerManager;
  layouts: LayoutFileStore;
  /** Folder with index.html, controller.js, controller.css (dist/controller-ui). */
  uiDir: string;
  port: number;
  token: string;
  /** Production: isPrivateAddress. Tests inject their own. */
  isAllowedAddress(address: string): boolean;
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void;
  tickMs?: number;
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/controller.js': { file: 'controller.js', type: 'text/javascript; charset=utf-8' },
  '/controller.css': { file: 'controller.css', type: 'text/css; charset=utf-8' },
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
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

  constructor(private readonly o: ControllerServerOptions) {
    this.tokenDigest = digest(o.token);
  }

  get token(): string {
    return this.o.token;
  }

  /** Resolves with the real port (pass port 0 in tests). */
  start(): Promise<number> {
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

  /** Private source address, IP-literal Host header, and (when a browser sends one) same-origin. */
  private guard(req: IncomingMessage): { ok: true; address: string } | { ok: false; status: number; reason: string } {
    const address = req.socket.remoteAddress ?? '';
    if (!this.o.isAllowedAddress(address)) return { ok: false, status: 403, reason: 'address' };
    const host = parseHostHeader(req.headers.host);
    if (!host || !/^[0-9a-f.:]+$/i.test(host.host)) return { ok: false, status: 421, reason: 'host' };
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
      const body = await readFile(path.join(this.o.uiDir, st.file));
      this.reply(res, 200, req.method === 'HEAD' ? '' : body, st.type);
    } catch (e) {
      this.o.log('warn', 'controller http error', { error: (e as Error).message });
      if (!res.headersSent) this.reply(res, 500, 'Server error');
    }
  }

  private async onApi(req: IncomingMessage, res: ServerResponse, url: URL, address: string): Promise<void> {
    if (!this.tokenOk(url)) return this.reply(res, 401, 'Bad or missing token');
    if (!this.apiAllowed(address)) return this.reply(res, 429, 'Slow down');
    const json = (status: number, v: unknown) => this.reply(res, status, JSON.stringify(v), 'application/json; charset=utf-8');
    if (url.pathname === '/api/layouts' && req.method === 'GET') return json(200, this.o.layouts.get(address));
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
      return json(200, this.o.layouts.put(address, parsed));
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
    const c: Conn = { id: randomBytes(8).toString('hex'), ws, address, joined: false, windowStart: Date.now(), frames: 0 };
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
        const r = this.o.manager.join(c.id, m.name, address);
        if (r.ok) {
          c.joined = true;
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
      else this.o.manager.keepalive(c.id);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(c.id);
      this.o.manager.leave(c.id);
    });
    ws.on('error', () => ws.terminate());
  }

  private onTick(): void {
    for (const id of this.o.manager.tick()) this.conns.get(id)?.ws.close(1001, 'idle');
  }
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
