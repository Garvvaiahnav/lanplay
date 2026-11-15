// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, fakeApi, flush, loadRenderer, q, type FakeApi, type LP } from './helpers.js';

let LPG: LP;
beforeAll(() => {
  LPG = loadRenderer();
});

const step = (stepId: string) => ({ stepId, status: 'pass', title: 'Step ' + stepId, message: '', startedAt: '', durationMs: 1, commands: [] });
const INSTALL = { root: 'C:\\Program Files\\Sunshine', exe: '', serviceExe: '', configDir: '', configFile: '', logFile: '', certFile: '', foundVia: 'service-binpath' };
const AGENT = { listening: true, port: 47920, autoApprove: true, pending: [] as unknown[] };
const OFF: import('../../src/contracts.js').ControllersState = { enabled: false, running: false, port: 47921, links: [], driver: { ok: true as const }, players: [], setupRunning: false, error: null };
const ON = {
  ...OFF,
  enabled: true,
  running: true,
  links: [{ address: '192.168.1.20', url: 'http://192.168.1.20:47921/?t=abc', qrDataUrl: 'data:image/svg+xml;utf8,%3Csvg%2F%3E' }],
  players: [{ id: 'aaaaaaaaaaaaaaaa', slot: 1, name: 'Pixel', address: '192.168.1.55', stale: false }],
};

let root: HTMLElement;
let api: FakeApi;
let handle: { destroy(): void };
let clipboard: string[];

function setup(over: Record<string, (r: unknown) => unknown> = {}): void {
  api = fakeApi({
    'app:info': () => ({ role: 'host', version: '0.3.0', platform: 'win32', arch: 'x64', logFile: 'x.log', hostName: 'GARV-PC' }),
    'host:setup-status': () => ({ lastRunAt: 'now', ok: true, steps: [step('service')], install: INSTALL, isAdmin: false }),
    'host:agent-state': () => ({ ...AGENT }),
    'host:devices-list': () => [],
    'host:controllers-state': () => OFF,
    ...over,
  });
  root = document.createElement('div');
  document.body.appendChild(root);
  handle = LPG.Host.mount(root, api, {});
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  clipboard = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void clipboard.push(t) } });
});
afterEach(() => {
  handle?.destroy();
  vi.useRealTimers();
});

const card = (): HTMLElement => q(root, 'section[aria-labelledby="h-pad"]');

describe('phone controllers card', () => {
  it('is off by default: no links, no players, no install button', async () => {
    setup();
    await flush(12);
    expect(card().querySelector('.qr')).toBeNull();
    expect(card().querySelectorAll('li.item')).toHaveLength(0);
    expect(buttonByText(card(), 'Install driver').hidden).toBe(true);
  });

  it('the switch turns it on and shows the join link, QR code and connected phones', async () => {
    setup({ 'host:controllers-set-enabled': () => ON });
    await flush(12);
    const sw = q<HTMLInputElement>(card(), 'input[type="checkbox"], [role="switch"]');
    sw.click();
    await flush(12);
    expect(api.called('host:controllers-set-enabled')).toEqual([{ on: true }]);
    expect(q(card(), 'code.copyable').textContent).toBe('http://192.168.1.20:47921/?t=abc');
    expect(q<HTMLImageElement>(card(), 'img.qr').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(card().textContent).toContain('Player 1: Pixel');
    expect(card().textContent).toContain('Ready on port 47921');
  });

  it('Remove kicks that phone by id', async () => {
    setup({ 'host:controllers-state': () => ON, 'host:controllers-kick': () => ({ ...ON, players: [] }) });
    await flush(12);
    buttonByText(card(), 'Remove').click();
    await flush(12);
    expect(api.called('host:controllers-kick')).toEqual([{ id: 'aaaaaaaaaaaaaaaa' }]);
    expect(card().textContent).not.toContain('Pixel');
  });

  it('live updates from the host replace the player list', async () => {
    setup({ 'host:controllers-state': () => ON });
    await flush(12);
    api.emit('host:controllers-changed', { ...ON, players: [{ id: 'bbbbbbbbbbbbbbbb', slot: 2, name: 'iPhone', address: '192.168.1.56', stale: true }] });
    expect(card().textContent).toContain('Player 2: iPhone');
    expect(card().textContent).toContain('not responding');
  });

  it('missing driver: explains it and offers Install driver, which calls the elevated setup', async () => {
    const MISSING = { ...OFF, enabled: true, driver: { ok: false, reason: 'driver-missing', message: 'not installed' }, error: 'The virtual controller driver is not installed yet.' };
    setup({ 'host:controllers-state': () => MISSING, 'host:controllers-setup': () => ON });
    await flush(12);
    const b = buttonByText(card(), 'Install driver');
    expect(b.hidden).toBe(false);
    b.click();
    await flush(12);
    expect(api.called('host:controllers-setup')).toHaveLength(1);
    expect(card().querySelector('.qr')).not.toBeNull();
  });

  it('copies the link and offers New link only while running', async () => {
    setup({ 'host:controllers-state': () => ON, 'host:controllers-new-link': () => ON });
    await flush(12);
    buttonByText(card(), 'Copy link').click();
    await flush(12);
    expect(clipboard).toEqual(['http://192.168.1.20:47921/?t=abc']);
    expect(buttonByText(card(), 'New link').hidden).toBe(false);
    buttonByText(card(), 'New link').click();
    await flush(12);
    expect(api.called('host:controllers-new-link')).toHaveLength(1);
  });

  it('shows a port-in-use style error from the host', async () => {
    setup({ 'host:controllers-state': () => ({ ...OFF, enabled: true, error: 'Port 47921 is already used by another program.' }) });
    await flush(12);
    expect(card().textContent).toContain('Port 47921 is already used');
  });
});
