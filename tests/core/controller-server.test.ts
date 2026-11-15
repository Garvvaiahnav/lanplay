import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

class FakePad implements VirtualPad {
  updates: PadState[] = [];
  closed = 0;
  update(s: PadState) {
    this.updates.push({ ...s });
  }
  close() {
    this.closed++;
  }
  get last() {
    return this.updates[this.updates.length - 1];
  }
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function request(port: number, method: string, urlPath: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** A WebSocket with a queue of received JSON messages. */
class Phone {
  messages: unknown[] = [];
  closed: Promise<number>;
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
    this.closed = new Promise((r) => ws.on('close', (code) => r(code)));
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
function connect(port: number, query = `?t=${TOKEN}`, headers: Record<string, string> = {}): Promise<Phone> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
    ws.once('open', () => resolve(new Phone(ws)));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe('ControllerServer', () => {
  let tmp: string;
  let pads: FakePad[];
  let manager: ControllerManager;
  let server: ControllerServer;
  let port: number;
  let allowed: boolean;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lanplay-ctl-'));
    const ui = path.join(tmp, 'ui');
    await import('node:fs').then((fs) => fs.mkdirSync(ui));
    writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>pad</title>');
    writeFileSync(path.join(ui, 'controller.js'), 'console.log(1)');
    writeFileSync(path.join(ui, 'controller.css'), 'body{}');
    writeFileSync(path.join(tmp, 'secret.txt'), 'nope');
    pads = [];
    allowed = true;
    manager = new ControllerManager({
      createPad: () => {
        const p = new FakePad();
        pads.push(p);
        return p;
      },
      now: () => Date.now(),
    });
    server = new ControllerServer({ manager, layouts: new LayoutFileStore(path.join(tmp, 'layouts')), uiDir: ui, port: 0, token: TOKEN, isAllowedAddress: () => allowed, log: () => undefined, tickMs: 50 });
    port = await server.start();
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('HTTP', () => {
    it('serves the phone page and its two files with a strict CSP, and nothing else', async () => {
      for (const [p, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/controller.js', 'text/javascript'], ['/controller.css', 'text/css']] as const) {
        const r = await request(port, 'GET', p);
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toContain(type);
        expect(r.headers['content-security-policy']).toContain("default-src 'none'");
        expect(r.headers['x-content-type-options']).toBe('nosniff');
      }
      for (const p of ['/secret.txt', '/../secret.txt', '/%2e%2e/secret.txt', '/controller.js/../../secret.txt', '/ui/index.html', '/api']) {
        expect((await request(port, 'GET', p)).status).toBe(404);
      }
      expect((await request(port, 'POST', '/')).status).toBe(404);
    });

    it('refuses a source address that is not on the home network', async () => {
      allowed = false;
      expect((await request(port, 'GET', '/')).status).toBe(403);
    });

    it('refuses a Host header that is not an IP address (DNS rebinding) and cross-site Origins', async () => {
      expect((await request(port, 'GET', '/', { headers: { Host: `evil.example:${port}` } })).status).toBe(421);
      expect((await request(port, 'GET', `/api/layouts?t=${TOKEN}`, { headers: { Origin: 'http://evil.example' } })).status).toBe(403);
      expect((await request(port, 'GET', `/api/layouts?t=${TOKEN}`, { headers: { Origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    });

    it('API needs the token', async () => {
      expect((await request(port, 'GET', '/api/layouts')).status).toBe(401);
      expect((await request(port, 'GET', '/api/layouts?t=wrong')).status).toBe(401);
      expect((await request(port, 'GET', '/api/default-layout?t=')).status).toBe(401);
      expect((await request(port, 'PUT', '/api/layouts?t=x', { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    });

    it('GET /api/layouts gives the default store first, PUT saves a sanitized one, GET returns it', async () => {
      const first = JSON.parse((await request(port, 'GET', `/api/layouts?t=${TOKEN}`)).body);
      expect(first).toEqual(defaultStore());
      const body = JSON.stringify({ version: 1, activeId: 'a', layouts: [{ id: 'a', name: 'Racing', controls: [{ id: 'd', type: 'dpad', x: 500, y: 20, size: 30 }, { id: 'z', type: 'laser' }] }] });
      const put = await request(port, 'PUT', `/api/layouts?t=${TOKEN}`, { headers: { 'Content-Type': 'application/json' }, body });
      expect(put.status).toBe(200);
      const saved = JSON.parse(put.body);
      expect(saved.layouts[0].controls).toHaveLength(1);
      expect(saved.layouts[0].controls[0].x).toBe(100);
      expect(JSON.parse((await request(port, 'GET', `/api/layouts?t=${TOKEN}`)).body)).toEqual(saved);
    });

    it('GET /api/default-layout returns the stock Xbox layout', async () => {
      const l = JSON.parse((await request(port, 'GET', `/api/default-layout?t=${TOKEN}`)).body);
      expect(l.id).toBe('default');
      expect(l.controls.length).toBeGreaterThan(10);
    });

    it('PUT rejects wrong content type, bad JSON and oversized bodies', async () => {
      const q = `/api/layouts?t=${TOKEN}`;
      expect((await request(port, 'PUT', q, { headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
      expect((await request(port, 'PUT', q, { headers: { 'Content-Type': 'application/json' }, body: '{nope' })).status).toBe(400);
      const big = '{"x":"' + 'a'.repeat(300 * 1024) + '"}';
      expect((await request(port, 'PUT', q, { headers: { 'Content-Type': 'application/json' }, body: big })).status).toBe(413);
      expect((await request(port, 'GET', q)).status).toBe(200); // server still fine
    });
  });

  describe('WebSocket', () => {
    it('needs the token, a private address and an IP-literal host', async () => {
      await expect(connect(port, '')).rejects.toThrow('401');
      await expect(connect(port, '?t=bad')).rejects.toThrow('401');
      await expect(connect(port, `?t=${TOKEN}`, { Origin: 'http://evil.example' })).rejects.toThrow('403');
      allowed = false;
      await expect(connect(port)).rejects.toThrow('403');
    });

    it('welcomes a phone with its player number and forwards state to its own virtual pad', async () => {
      const p1 = await connect(port);
      p1.send({ t: 'hello', name: 'Pixel' });
      expect(await p1.next()).toEqual({ t: 'welcome', slot: 1 });
      const p2 = await connect(port);
      p2.send({ t: 'hello', name: 'iPhone' });
      expect(await p2.next()).toEqual({ t: 'welcome', slot: 2 });
      p1.send({ t: 's', b: BTN.A, lt: 0, rt: 255, lx: 1000, ly: -1000, rx: 0, ry: 0 });
      for (let i = 0; i < 50 && pads[0]!.updates.length === 0; i++) await sleep(10);
      expect(pads[0]!.last).toEqual({ buttons: BTN.A, lt: 0, rt: 255, lx: 1000, ly: -1000, rx: 0, ry: 0 });
      expect(pads[1]!.updates).toEqual([]);
      expect(manager.list().map((p) => p.name)).toEqual(['Pixel', 'iPhone']);
      p1.ws.close();
      p2.ws.close();
    });

    it('ignores state before hello, malformed frames and binary frames', async () => {
      const p = await connect(port);
      p.send({ t: 's', b: BTN.A });
      p.ws.send('garbage');
      p.ws.send(Buffer.from([1, 2, 3]));
      await sleep(80);
      expect(pads).toHaveLength(0);
      p.send({ t: 'hello', name: 'x' });
      expect(await p.next()).toEqual({ t: 'welcome', slot: 1 });
      p.ws.close();
    });

    it('says full to the fifth player and closes that socket', async () => {
      const phones: Phone[] = [];
      for (let i = 0; i < 4; i++) {
        const p = await connect(port);
        p.send({ t: 'hello', name: `P${i}` });
        expect(await p.next()).toMatchObject({ t: 'welcome' });
        phones.push(p);
      }
      const fifth = await connect(port);
      fifth.send({ t: 'hello', name: 'late' });
      expect(await fifth.next()).toEqual({ t: 'full' });
      await fifth.closed;
      expect(pads).toHaveLength(4);
      phones.forEach((p) => p.ws.close());
    });

    it('releases the pad when the phone disconnects', async () => {
      const p = await connect(port);
      p.send({ t: 'hello', name: 'x' });
      await p.next();
      p.send({ t: 's', b: BTN.B });
      await sleep(50);
      p.ws.close();
      for (let i = 0; i < 50 && pads[0]!.closed === 0; i++) await sleep(10);
      expect(pads[0]!.last).toEqual(neutralPad());
      expect(pads[0]!.closed).toBe(1);
      expect(manager.list()).toEqual([]);
    });

    it('kick tells the phone, frees the slot and closes the socket', async () => {
      const p = await connect(port);
      p.send({ t: 'hello', name: 'x' });
      await p.next();
      const id = manager.list()[0]!.id;
      expect(server.kick(id)).toBe(true);
      expect(await p.next()).toEqual({ t: 'kicked' });
      await p.closed;
      expect(pads[0]!.closed).toBe(1);
      expect(server.kick(id)).toBe(false);
    });

    it('closes a phone that never says hello, and one that floods frames', async () => {
      const flood = await connect(port);
      flood.send({ t: 'hello', name: 'flood' });
      await flood.next();
      for (let i = 0; i < 500; i++) flood.send({ t: 'k' });
      expect(await flood.closed).toBe(1008);
    });

    it('stop() releases every pad', async () => {
      const p = await connect(port);
      p.send({ t: 'hello', name: 'x' });
      await p.next();
      await server.stop();
      expect(pads[0]!.closed).toBe(1);
    });
  });
});
