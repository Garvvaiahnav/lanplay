import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ControllersState, KeyValueStore } from '../../src/contracts.js';
import { ControllerService } from '../../src/core/controller/service.js';
import type { ControllerServiceDeps } from '../../src/core/controller/service.js';
import type { VirtualPad } from '../../src/core/controller/manager.js';
import type { PadBackend, PadBackendStatus } from '../../src/core/controller/vigem.js';

class MemStore implements KeyValueStore {
  m = new Map<string, unknown>();
  get<T>(k: string, fb: T): T {
    return this.m.has(k) ? (this.m.get(k) as T) : fb;
  }
  set<T>(k: string, v: T): void {
    this.m.set(k, v);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ControllerService', () => {
  let tmp: string;
  let settings: MemStore;
  let status: PadBackendStatus;
  let created: number[];
  let setupCalls: number;
  let setupResult: { ok: boolean; message: string };
  let svc: ControllerService;
  let changes: ControllersState[];

  const backend: PadBackend = {
    status: () => status,
    createPad: (slot) => {
      created.push(slot);
      const pad: VirtualPad = { update: () => undefined, close: () => undefined };
      return pad;
    },
  };

  const make = (over: Partial<ControllerServiceDeps> = {}) => {
    const s = new ControllerService({
      backend,
      layoutsDir: path.join(tmp, 'layouts'),
      uiDir: path.join(tmp, 'ui'),
      port: 0,
      settings,
      localAddresses: () => ['127.0.0.1'],
      isAllowedAddress: () => true,
      log: () => undefined,
      runSetup: async () => {
        setupCalls++;
        if (setupResult.ok) status = { ok: true };
        return setupResult;
      },
      ...over,
    });
    s.onChange((st) => changes.push(st));
    return s;
  };

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lanplay-svc-'));
    mkdirSync(path.join(tmp, 'ui'));
    writeFileSync(path.join(tmp, 'ui', 'index.html'), 'x');
    settings = new MemStore();
    status = { ok: true };
    created = [];
    setupCalls = 0;
    setupResult = { ok: true, message: 'ok' };
    changes = [];
    svc = make();
  });
  afterEach(async () => {
    await svc.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('starts switched off and idle', () => {
    expect(svc.state()).toMatchObject({ enabled: false, running: false, links: [], players: [], setupRunning: false, error: null });
  });

  it('turning it on starts the server and offers a join link with QR for each home-network address', async () => {
    const st = await svc.setEnabled(true);
    expect(st.enabled).toBe(true);
    expect(st.running).toBe(true);
    expect(st.port).toBeGreaterThan(0);
    expect(st.links).toHaveLength(1);
    expect(st.links[0]!.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${st.port}/\\?t=[A-Za-z0-9_-]{20,}$`));
    expect(st.links[0]!.qrDataUrl).toMatch(/^data:image\/svg\+xml/);
    expect(settings.get('controllers.enabled', false)).toBe(true);
  });

  it('a phone that joins shows up in the player list, and the list updates when it leaves', async () => {
    const st = await svc.setEnabled(true);
    const token = new URL(st.links[0]!.url).searchParams.get('t');
    const ws = new WebSocket(`ws://127.0.0.1:${st.port}/ws?t=${token}`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', name: 'Pixel' }));
    for (let i = 0; i < 100 && svc.state().players.length === 0; i++) await sleep(10);
    expect(svc.state().players).toMatchObject([{ slot: 1, name: 'Pixel', address: expect.any(String), stale: false }]);
    expect(created).toEqual([1]);
    expect(changes.some((c) => c.players.length === 1)).toBe(true);
    ws.close();
    for (let i = 0; i < 100 && svc.state().players.length > 0; i++) await sleep(10);
    expect(svc.state().players).toEqual([]);
  });

  it('kick removes that player', async () => {
    const st = await svc.setEnabled(true);
    const token = new URL(st.links[0]!.url).searchParams.get('t');
    const ws = new WebSocket(`ws://127.0.0.1:${st.port}/ws?t=${token}`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', name: 'x' }));
    for (let i = 0; i < 100 && svc.state().players.length === 0; i++) await sleep(10);
    const after = svc.kick(svc.state().players[0]!.id);
    expect(after.players).toEqual([]);
  });

  it('turning it off stops the server and keeps the choice', async () => {
    const on = await svc.setEnabled(true);
    const off = await svc.setEnabled(false);
    expect(off).toMatchObject({ enabled: false, running: false, links: [] });
    expect(settings.get('controllers.enabled', true)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${on.port}/`)).rejects.toThrow();
  });

  it('with the driver missing it does not run, says why, and remembers the switch', async () => {
    status = { ok: false, reason: 'driver-missing', message: 'ViGEmBus is not installed' };
    const st = await svc.setEnabled(true);
    expect(st).toMatchObject({ enabled: true, running: false, driver: { ok: false, reason: 'driver-missing' } });
    expect(st.error).toMatch(/driver/i);
  });

  it('setup() installs the driver through the elevated step, re-checks it and then starts', async () => {
    status = { ok: false, reason: 'driver-missing', message: 'not installed' };
    await svc.setEnabled(true);
    const st = await svc.setup();
    expect(setupCalls).toBe(1);
    expect(st).toMatchObject({ enabled: true, running: true, driver: { ok: true }, setupRunning: false, error: null });
    expect(changes.some((c) => c.setupRunning)).toBe(true);
  });

  it('a failed or cancelled setup is reported and nothing starts', async () => {
    status = { ok: false, reason: 'driver-missing', message: 'not installed' };
    setupResult = { ok: false, message: 'The Windows permission prompt was cancelled.' };
    await svc.setEnabled(true);
    const st = await svc.setup();
    expect(st).toMatchObject({ running: false, setupRunning: false });
    expect(st.error).toContain('cancelled');
  });

  it('two setup() calls at once run it once', async () => {
    status = { ok: false, reason: 'driver-missing', message: 'x' };
    await Promise.all([svc.setup(), svc.setup()]);
    expect(setupCalls).toBe(1);
  });

  it('init() starts it again after a restart when it was left on', async () => {
    await svc.setEnabled(true);
    await svc.shutdown();
    const again = make();
    expect(again.state().running).toBe(false);
    await again.init();
    expect(again.state().running).toBe(true);
    await again.shutdown();
  });

  it('keeps the same link across restarts until a new one is asked for, which kills the old token', async () => {
    const first = await svc.setEnabled(true);
    const url1 = first.links[0]!.url;
    await svc.shutdown();
    const again = make();
    await again.init();
    expect(again.state().links[0]!.url.split('?t=')[1]).toBe(url1.split('?t=')[1]);
    const fresh = await again.newLink();
    const tok = fresh.links[0]!.url.split('?t=')[1];
    expect(tok).not.toBe(url1.split('?t=')[1]);
    expect((await fetch(`http://127.0.0.1:${fresh.port}/api/layouts?t=${url1.split('?t=')[1]}`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${fresh.port}/api/layouts?t=${tok}`)).status).toBe(200);
    await again.shutdown();
  });

  it('reports a busy port instead of crashing', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '0.0.0.0', r));
    const port = (blocker.address() as net.AddressInfo).port;
    const busy = make({ port });
    const st = await busy.setEnabled(true);
    expect(st.running).toBe(false);
    expect(st.error).toMatch(new RegExp(String(port)));
    await busy.shutdown();
    blocker.close();
  });
});
