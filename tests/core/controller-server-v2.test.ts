import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultStore } from '../../src/core/controller/layout.js';
import { LayoutFileStore } from '../../src/core/controller/layout-store.js';
import { ControllerManager } from '../../src/core/controller/manager.js';
import type { VirtualPad } from '../../src/core/controller/manager.js';
import { BTN, neutralPad } from '../../src/core/controller/protocol.js';
import type { PadState } from '../../src/core/controller/protocol.js';
import { ControllerServer } from '../../src/core/controller/server.js';

const TOKEN = 'tok-1234567890abcdef';
const ID_A = 'phoneAAAAAAAAAAAA';
const ID_B = 'phoneBBBBBBBBBBBB';
const INDEX = '<!doctype html><title>pad</title>' + '<p>controller page text that repeats</p>'.repeat(60);
const JS = 'console.log("controller");\n'.repeat(80);
const MP4 = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

class FakePad implements VirtualPad {
  updates: PadState[] = [];
  closed = 0;
  update(s: PadState) {
    this.updates.push({ ...s });
  }
  close() {
    this.closed++;
  }
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  body: string;
}
function request(port: number, method: string, urlPath: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

class Phone {
  messages: unknown[] = [];
  closed: Promise<number>;
  /** The close reason the server sent (the page reads it as event.reason). */
  reason = '';
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
    this.closed = new Promise((r) =>
      ws.on('close', (code, reason) => {
        this.reason = reason.toString('utf8');
        r(code);
      }),
    );
  }
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  async next(): Promise<unknown> {
    for (let i = 0; i < 100 && this.messages.length === 0; i++) await sleep(10);
    return this.messages.shift();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function connect(port: number): Promise<Phone> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${TOKEN}`);
    ws.once('open', () => resolve(new Phone(ws)));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe('ControllerServer: ids, sticky slots, ping, static files', () => {
  let tmp: string;
  let ui: string;
  let pads: FakePad[];
  let manager: ControllerManager;
  let server: ControllerServer;
  let port: number;
  let layoutDir: string;

  async function boot(graceMs = 15_000, skipFiles: string[] = []) {
    manager = new ControllerManager(
      {
        createPad: () => {
          const p = new FakePad();
          pads.push(p);
          return p;
        },
        now: () => Date.now(),
      },
      { graceMs },
    );
    const files: Record<string, string | Buffer> = {
      'index.html': INDEX,
      'controller.js': JS,
      'controller.css': 'body{margin:0}\n'.repeat(50),
      'apple-touch-icon.png': PNG,
      'icon-192.png': PNG,
      'icon-512.png': PNG,
      'manifest.webmanifest': '{"name":"x"}',
      'wake.mp4': MP4,
    };
    for (const [n, v] of Object.entries(files)) if (!skipFiles.includes(n)) writeFileSync(path.join(ui, n), v);
    server = new ControllerServer({ manager, layouts: new LayoutFileStore(layoutDir), uiDir: ui, port: 0, token: TOKEN, isAllowedAddress: () => true, log: () => undefined, tickMs: 20 });
    port = await server.start();
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lanplay-ctl2-'));
    ui = path.join(tmp, 'ui');
    layoutDir = path.join(tmp, 'layouts');
    mkdirSync(ui);
    pads = [];
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('Host header', () => {
    beforeEach(() => boot());

    it('a DNS name made only of hex letters is refused, an IP with a port passes', async () => {
      expect((await request(port, 'GET', '/', { headers: { Host: 'dead.be:47921' } })).status).toBe(421);
      expect((await request(port, 'GET', '/', { headers: { Host: 'dead.be' } })).status).toBe(421);
      expect((await request(port, 'GET', '/', { headers: { Host: 'cafe:47921' } })).status).toBe(421);
      expect((await request(port, 'GET', '/', { headers: { Host: 'abc.def:47921' } })).status).toBe(421);
      expect((await request(port, 'GET', '/', { headers: { Host: '192.168.1.5:47921' } })).status).toBe(200);
      expect((await request(port, 'GET', '/', { headers: { Host: '192.168.1.5' } })).status).toBe(200);
      expect((await request(port, 'GET', '/', { headers: { Host: '[fe80::1]:47921' } })).status).toBe(200);
    });

    it('rejects strings that only look like an address', async () => {
      for (const h of ['999.1.1.1:1', '1.2.3:1', '1.2.3.4.5:1', 'a.b.c.d:1', '0x7f.1:1', 'localhost:1']) {
        expect((await request(port, 'GET', '/', { headers: { Host: h } })).status).toBe(421);
      }
    });
  });

  describe('static files', () => {
    beforeEach(() => boot());

    it('serves the icons and the wake video with the right types and media-src in the CSP', async () => {
      for (const [p, type] of [['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/wake.mp4', 'video/mp4']] as const) {
        const r = await request(port, 'GET', p);
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBe(type);
        expect(r.headers['content-security-policy']).toContain("media-src 'self'");
        expect(r.headers['content-encoding']).toBeUndefined();
      }
      expect((await request(port, 'GET', '/wake.mp4')).raw.equals(MP4)).toBe(true);
      expect((await request(port, 'GET', '/icon-512.png')).raw.equals(PNG)).toBe(true);
    });

    it('sends gzip when accepted: smaller body that decodes to the file, Vary and a correct length', async () => {
      const plain = await request(port, 'GET', '/controller.js');
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.body).toBe(JS);
      const gz = await request(port, 'GET', '/controller.js', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
      expect(gz.headers['content-encoding']).toBe('gzip');
      expect(gz.headers['vary']).toContain('Accept-Encoding');
      expect(Number(gz.headers['content-length'])).toBe(gz.raw.length);
      expect(gz.raw.length).toBeLessThan(plain.raw.length / 4);
      expect(gunzipSync(gz.raw).toString('utf8')).toBe(JS);
      for (const p of ['/', '/index.html', '/controller.css', '/manifest.webmanifest']) {
        const r = await request(port, 'GET', p, { headers: { 'Accept-Encoding': 'gzip' } });
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBeTruthy();
      }
      expect(gunzipSync((await request(port, 'GET', '/', { headers: { 'Accept-Encoding': 'gzip' } })).raw).toString('utf8')).toBe(INDEX);
    });

    it('does not gzip when the client refuses it (q=0, identity) and never gzips png or mp4', async () => {
      for (const ae of ['gzip;q=0', 'identity', 'br']) {
        expect((await request(port, 'GET', '/controller.js', { headers: { 'Accept-Encoding': ae } })).headers['content-encoding']).toBeUndefined();
      }
      for (const p of ['/icon-192.png', '/wake.mp4', '/apple-touch-icon.png']) {
        expect((await request(port, 'GET', p, { headers: { 'Accept-Encoding': 'gzip' } })).headers['content-encoding']).toBeUndefined();
      }
    });

    it('a tiny file that gzip would make bigger is sent as is', async () => {
      const r = await request(port, 'GET', '/manifest.webmanifest', { headers: { 'Accept-Encoding': 'gzip' } });
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.body).toBe('{"name":"x"}');
    });

    it('is read from memory: the files can disappear after start and the page still loads', async () => {
      rmSync(ui, { recursive: true, force: true });
      for (const p of ['/', '/controller.js', '/controller.css', '/icon-192.png', '/wake.mp4']) {
        expect((await request(port, 'GET', p)).status).toBe(200);
      }
      expect((await request(port, 'GET', '/controller.js', { headers: { 'Accept-Encoding': 'gzip' } })).status).toBe(200);
    });

    it('HEAD answers with the headers and no body', async () => {
      const r = await request(port, 'HEAD', '/controller.js', { headers: { 'Accept-Encoding': 'gzip' } });
      expect(r.status).toBe(200);
      expect(r.raw.length).toBe(0);
      expect(Number(r.headers['content-length'])).toBeGreaterThan(0);
    });

    it('answers a byte range of the video with 206, and 416 for one past the end', async () => {
      const r = await request(port, 'GET', '/wake.mp4', { headers: { Range: 'bytes=10-19' } });
      expect(r.status).toBe(206);
      expect(r.headers['content-range']).toBe('bytes 10-19/1000');
      expect(r.raw.equals(MP4.subarray(10, 20))).toBe(true);
      expect((await request(port, 'GET', '/wake.mp4', { headers: { Range: 'bytes=990-' } })).raw.equals(MP4.subarray(990))).toBe(true);
      expect((await request(port, 'GET', '/wake.mp4', { headers: { Range: 'bytes=-5' } })).raw.equals(MP4.subarray(995))).toBe(true);
      expect((await request(port, 'GET', '/wake.mp4', { headers: { Range: 'bytes=0-99999' } })).headers['content-range']).toBe('bytes 0-999/1000');
      const bad = await request(port, 'GET', '/wake.mp4', { headers: { Range: 'bytes=5000-6000' } });
      expect(bad.status).toBe(416);
      expect(bad.headers['content-range']).toBe('bytes */1000');
      expect((await request(port, 'GET', '/wake.mp4')).headers['accept-ranges']).toBe('bytes');
    });

    it('everything outside the table is still 404 (no path walking to new names)', async () => {
      for (const p of ['/wake.mp4.map', '/ICON-192.PNG', '/controller.js.map', '/icon-1024.png']) {
        expect((await request(port, 'GET', p)).status).toBe(404);
      }
    });
  });

  describe('a static file that is missing at start', () => {
    it('answers 404 for it, serves the rest, and picks it up once it exists', async () => {
      await boot(15_000, ['wake.mp4']);
      expect((await request(port, 'GET', '/wake.mp4')).status).toBe(404);
      expect((await request(port, 'GET', '/')).status).toBe(200);
      writeFileSync(path.join(ui, 'wake.mp4'), MP4);
      expect((await request(port, 'GET', '/wake.mp4')).status).toBe(200);
    });
  });

  describe('layouts by phone id', () => {
    beforeEach(() => boot());
    const put = (id: string | null, name: string) =>
      request(port, 'PUT', `/api/layouts?t=${TOKEN}${id ? `&id=${id}` : ''}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, activeId: 'm', layouts: [{ id: 'm', name, controls: [{ id: 'd', type: 'dpad', x: 20, y: 20, size: 30 }] }] }),
      });
    const get = async (id: string | null) => JSON.parse((await request(port, 'GET', `/api/layouts?t=${TOKEN}${id ? `&id=${id}` : ''}`)).body);

    it('two ids on one IP get separate layouts, and the id keeps its layout', async () => {
      expect((await put(ID_A, 'Racing')).status).toBe(200);
      expect((await put(ID_B, 'Shooter')).status).toBe(200);
      expect((await get(ID_A)).layouts[0].name).toBe('Racing');
      expect((await get(ID_B)).layouts[0].name).toBe('Shooter');
      expect(await get(null)).toEqual(defaultStore());
    });

    it('a malformed id falls back to the per-IP file instead of failing or escaping the folder', async () => {
      await put(null, 'ByIp');
      for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'short', 'x'.repeat(40)]) {
        const r = await request(port, 'GET', `/api/layouts?t=${TOKEN}&id=${bad}`);
        expect(r.status).toBe(200);
        expect(JSON.parse(r.body).layouts[0].name).toBe('ByIp');
      }
    });
  });

  describe('sticky slot over a real socket', () => {
    it('rejoin with the same id inside the window gives the same slot, one pad, and the pad is not closed', async () => {
      await boot(15_000);
      const p1 = await connect(port);
      p1.send({ t: 'hello', name: 'Pixel', id: ID_A });
      expect(await p1.next()).toEqual({ t: 'welcome', slot: 1 });
      p1.send({ t: 's', b: BTN.A, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
      await sleep(40);
      p1.ws.close();
      await p1.closed;
      await sleep(80);
      expect(pads[0]!.closed).toBe(0);
      expect(pads[0]!.updates.at(-1)).toEqual(neutralPad());
      expect(manager.list()).toMatchObject([{ slot: 1, detached: true }]);
      const other = await connect(port);
      other.send({ t: 'hello', name: 'Other', id: ID_B });
      expect(await other.next()).toEqual({ t: 'welcome', slot: 2 });
      const p2 = await connect(port);
      p2.send({ t: 'hello', name: 'Pixel', id: ID_A });
      expect(await p2.next()).toEqual({ t: 'welcome', slot: 1 });
      expect(pads).toHaveLength(2);
      expect(pads[0]!.closed).toBe(0);
      p2.send({ t: 's', b: BTN.B, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
      for (let i = 0; i < 50 && pads[0]!.updates.at(-1)?.buttons !== BTN.B; i++) await sleep(10);
      expect(pads[0]!.updates.at(-1)?.buttons).toBe(BTN.B);
      p2.ws.close();
      other.ws.close();
    });

    it('after the grace window the pad is closed by the server tick', async () => {
      await boot(120);
      const p1 = await connect(port);
      p1.send({ t: 'hello', name: 'x', id: ID_A });
      await p1.next();
      p1.ws.close();
      for (let i = 0; i < 100 && pads[0]!.closed === 0; i++) await sleep(10);
      expect(pads[0]!.closed).toBe(1);
      expect(manager.list()).toEqual([]);
    });

    it('a hello without an id still joins and is released when the socket closes', async () => {
      await boot();
      const p = await connect(port);
      p.send({ t: 'hello', name: 'old page' });
      expect(await p.next()).toEqual({ t: 'welcome', slot: 1 });
      p.ws.close();
      for (let i = 0; i < 50 && pads[0]!.closed === 0; i++) await sleep(10);
      expect(pads[0]!.closed).toBe(1);
      expect(manager.list()).toEqual([]);
    });

    it('a hello with a malformed id joins like one without an id', async () => {
      await boot();
      const p = await connect(port);
      p.send({ t: 'hello', name: 'x', id: '../../etc' });
      expect(await p.next()).toEqual({ t: 'welcome', slot: 1 });
      p.ws.close();
      for (let i = 0; i < 50 && pads[0]!.closed === 0; i++) await sleep(10);
      expect(pads[0]!.closed).toBe(1);
    });

    it('a second socket with the same id takes over and the old socket is closed', async () => {
      await boot();
      const p1 = await connect(port);
      p1.send({ t: 'hello', name: 'x', id: ID_A });
      await p1.next();
      const p2 = await connect(port);
      p2.send({ t: 'hello', name: 'x', id: ID_A });
      expect(await p2.next()).toEqual({ t: 'welcome', slot: 1 });
      expect(await p1.closed).toBe(1000);
      expect(p1.reason).toBe('replaced'); // documented in protocol.ts: the page treats this reason as final
      expect(p2.reason).toBe('');
      await sleep(60);
      expect(manager.list()).toMatchObject([{ slot: 1, detached: false }]);
      expect(pads).toHaveLength(1);
      expect(pads[0]!.closed).toBe(0);
      p2.ws.close();
    });

    it('kick still frees the slot at once for a phone that has an id', async () => {
      await boot();
      const p = await connect(port);
      p.send({ t: 'hello', name: 'x', id: ID_A });
      await p.next();
      expect(server.kick(manager.list()[0]!.id)).toBe(true);
      expect(await p.next()).toEqual({ t: 'kicked' });
      await p.closed;
      await sleep(40);
      expect(pads[0]!.closed).toBe(1);
      expect(manager.list()).toEqual([]);
    });

    it('stop() releases detached pads too', async () => {
      await boot();
      const p = await connect(port);
      p.send({ t: 'hello', name: 'x', id: ID_A });
      await p.next();
      p.ws.close();
      await p.closed;
      await sleep(40);
      expect(pads[0]!.closed).toBe(0);
      await server.stop();
      expect(pads[0]!.closed).toBe(1);
    });
  });

  describe('ping', () => {
    beforeEach(() => boot());

    it('echoes n unchanged and at once, for a phone with and without an id', async () => {
      for (const id of [ID_A, undefined]) {
        const p = await connect(port);
        p.send({ t: 'hello', name: 'x', ...(id ? { id } : {}) });
        await p.next();
        p.send({ t: 'p', n: 1731000000123 });
        p.send({ t: 'p', n: -7 });
        expect(await p.next()).toEqual({ t: 'p', n: 1731000000123 });
        expect(await p.next()).toEqual({ t: 'p', n: -7 });
        p.ws.close();
        await p.closed;
      }
    });

    it('gets no echo before hello, and a bad n gets none', async () => {
      const p = await connect(port);
      p.send({ t: 'p', n: 1 });
      await sleep(60);
      expect(p.messages).toEqual([]);
      p.send({ t: 'hello', name: 'x' });
      await p.next();
      p.send({ t: 'p', n: 1.5 });
      p.send({ t: 'p', n: 'x' });
      p.send({ t: 'p' });
      await sleep(60);
      expect(p.messages).toEqual([]);
      p.ws.close();
    });

    it('pings count against the frame limit', async () => {
      const p = await connect(port);
      p.send({ t: 'hello', name: 'x' });
      await p.next();
      for (let i = 0; i < 500; i++) p.send({ t: 'p', n: i });
      expect(await p.closed).toBe(1008);
    });
  });

  describe('transport facts', () => {
    it('no per-message deflate is negotiated, and the installed ws turns Nagle off on every socket it adopts', async () => {
      await boot();
      const p = await connect(port);
      expect(p.ws.extensions).toBe('');
      p.ws.close();
      const src = readFileSync(path.join(process.cwd(), 'node_modules', 'ws', 'lib', 'websocket.js'), 'utf8');
      expect(src).toMatch(/if \(socket\.setNoDelay\) socket\.setNoDelay\(\);/);
    });
  });
});
