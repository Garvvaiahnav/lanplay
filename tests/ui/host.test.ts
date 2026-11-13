// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, fakeApi, flush, loadRenderer, q, type FakeApi, type LP } from './helpers.js';

let LPG: LP;
beforeAll(() => {
  LPG = loadRenderer();
});

const step = (stepId: string, status: string, message = '') => ({ stepId, status, title: 'Step ' + stepId, message, startedAt: '', durationMs: 1, commands: [] });
const INSTALL = { root: 'C:\\Program Files\\Sunshine', exe: '', serviceExe: '', configDir: '', configFile: '', logFile: '', certFile: '', foundVia: 'service-binpath' };
const AGENT = { listening: true, port: 47920, autoApprove: true, pending: [] as unknown[] };
const DEVICES = [{ uuid: 'u1', name: 'Mac mini', enabled: true, pairedVia: 'lanplay', lastAddress: '192.168.1.5' }, { uuid: 'u2', name: 'Phone', enabled: true }];

let root: HTMLElement;
let api: FakeApi;
let handle: { destroy(): void };
let clipboard: string[];

function setup(over: Record<string, (r: unknown) => unknown> = {}): void {
  api = fakeApi({
    'app:info': () => ({ role: 'host', version: '0.1.0', platform: 'win32', arch: 'x64', logFile: 'C:\\ProgramData\\LanPlay\\logs\\x.log', hostName: 'GARV-PC' }),
    'host:setup-status': () => ({ lastRunAt: 'now', ok: true, steps: [step('service', 'pass'), step('web-ui', 'pass')], install: INSTALL, isAdmin: true }),
    'host:agent-state': () => ({ ...AGENT }),
    'host:devices-list': () => DEVICES,
    'host:agent-set-auto-approve': (r) => ({ ...AGENT, autoApprove: (r as { on: boolean }).on }),
    'host:agent-decide': () => ({ ...AGENT }),
    'host:devices-revoke': (r) => DEVICES.filter((d) => d.uuid !== (r as { uuid: string }).uuid),
    ...over,
  });
  root = document.createElement('div');
  document.body.appendChild(root);
  handle = LPG.Host.mount(root, api, { onSwitchMode: () => undefined });
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

const ready = async (): Promise<void> => flush(12);

describe('host screen', () => {
  it('shows host name and Sunshine installed/running chips', async () => {
    setup();
    await ready();
    expect(q(root, '.copyable').textContent).toBe('GARV-PC');
    const chips = [...root.querySelectorAll('.chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Installed: yes', 'Running: yes']);
    expect(buttonByText(root, 'Set up / Repair')).toBeTruthy();
  });

  it('not installed yet: says so and offers Install and set up', async () => {
    setup({ 'host:setup-status': () => ({ lastRunAt: null, ok: false, steps: [], install: null, isAdmin: false }) });
    await ready();
    const chips = [...root.querySelectorAll('.chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Installed: no', 'Running: unknown']);
    expect(buttonByText(root, 'Install and set up')).toBeTruthy();
    // not elevated (the normal case): no admin warning
    expect([...root.querySelectorAll('p.hint.err')].every((p) => (p as HTMLElement).hidden || p.textContent === '')).toBe(true);
  });

  it('started with "Run as administrator": says to start it normally instead', async () => {
    setup({ 'host:setup-status': () => ({ lastRunAt: null, ok: false, steps: [], install: null, isAdmin: true }) });
    await ready();
    const warn = [...root.querySelectorAll('p.hint.err')].find((p) => /Run as administrator/.test(p.textContent ?? '')) as HTMLElement;
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toMatch(/start it normally/);
  });

  it('copies the host name', async () => {
    setup();
    await ready();
    buttonByText(root, 'Copy').click();
    await ready();
    expect(clipboard).toEqual(['GARV-PC']);
    expect(q(root, '.status').textContent).toBe('Name copied.');
  });

  it('Set up / Repair shows live step progress and the final result', async () => {
    let finish: (v: unknown) => void = () => undefined;
    setup({ 'host:setup-run': () => new Promise((r) => { finish = r; }) });
    await ready();
    buttonByText(root, 'Set up / Repair').click();
    await flush();
    expect(buttonByText(root, 'Working...').disabled).toBe(true);
    api.emit('host:setup-progress', step('admin', 'pass', 'Running as administrator') as never);
    api.emit('host:setup-progress', step('install-sunshine', 'fail', 'msiexec exit 1603') as never);
    expect(root.querySelectorAll('.steps')[0]?.textContent).toMatch(/Running as administrator/);
    finish({ lastRunAt: 'now', ok: false, steps: [step('admin', 'pass'), step('install-sunshine', 'fail', 'msiexec exit 1603')], install: null, isAdmin: true });
    await ready();
    expect(q(root, '.status').textContent).toMatch(/problems/);
    expect(q(root, '.status').className).toContain('error-text');
    expect(root.querySelector('.badge.fail')?.textContent).toBe('Fail');
  });

  it('Auto-approve is an accessible switch that calls main and rolls back on error', async () => {
    setup();
    await ready();
    const sw = q(root, '[role="switch"]');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click();
    await ready();
    expect(api.called('host:agent-set-auto-approve')).toEqual([{ on: false }]);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    api.handlers['host:agent-set-auto-approve'] = () => { throw new Error('nope'); };
    sw.click();
    await ready();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(q(root, '.status').textContent).toMatch(/Could not change the switch: nope/);
  });

  it('pending approvals can be approved or denied', async () => {
    setup({ 'host:agent-state': () => ({ ...AGENT, autoApprove: false, pending: [{ requestId: 'r1', clientName: 'Mac mini', remoteAddress: '192.168.1.5', requestedAt: '', expiresAt: '' }] }) });
    await ready();
    expect(root.textContent).toMatch(/Mac mini/);
    buttonByText(root, 'Approve').click();
    buttonByText(root, 'Deny').click();
    await ready();
    expect(api.called('host:agent-decide')).toEqual([{ requestId: 'r1', approve: true }, { requestId: 'r1', approve: false }]);
  });

  it('paired devices: Revoke needs a second click, then calls main and updates the list', async () => {
    setup();
    await ready();
    expect(root.querySelectorAll('[aria-label="Paired devices"] .item')).toHaveLength(2);
    q(root, '[aria-label="Revoke Mac mini"]').click();
    expect(api.called('host:devices-revoke')).toHaveLength(0);
    q(root, '[aria-label="Confirm revoke Mac mini"]').click();
    await ready();
    expect(api.called('host:devices-revoke')).toEqual([{ uuid: 'u1' }]);
    expect(root.querySelectorAll('[aria-label="Paired devices"] .item')).toHaveLength(1);
    expect(q(root, '.status').textContent).toBe('Mac mini can no longer connect.');
  });

  it('the revoke confirmation expires by itself', async () => {
    setup();
    await ready();
    q(root, '[aria-label="Revoke Phone"]').click();
    expect(root.querySelector('[aria-label="Confirm revoke Phone"]')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(4100);
    expect(root.querySelector('[aria-label="Confirm revoke Phone"]')).toBeNull();
    expect(api.called('host:devices-revoke')).toHaveLength(0);
  });

  it('self-check lists each step with a pass/fail word', async () => {
    setup({ 'selfcheck:run': () => ({ role: 'host', startedAt: '', durationMs: 5, ok: false, steps: [step('web-ui', 'pass'), step('firewall-agent', 'fail', 'rule "LanPlay Pair Agent" missing'), step('agent-listening', 'warn')] }) });
    await ready();
    buttonByText(root, 'Run self-check').click();
    await ready();
    const rows = [...root.querySelectorAll('[aria-label="Self-check results"] .step')].map((r) => r.textContent);
    expect(rows[0]).toMatch(/Some checks failed/);
    expect(rows[1]).toMatch(/Pass.*Step web-ui/);
    expect(rows[2]).toMatch(/Fail.*missing/);
    expect(rows[3]).toMatch(/Warning/);
  });

  it('Copy diagnostics collects the zip, copies its path and can reveal it', async () => {
    const zip = 'C:\\Users\\Zoë Ünal\\AppData\\Local\\Temp\\LanPlay-diagnostics-GARV-PC-20260101-101010.zip';
    setup({ 'diagnostics:collect': () => ({ zipPath: zip, bytes: 1234 }), 'diagnostics:reveal': () => undefined });
    await ready();
    buttonByText(root, 'Copy diagnostics').click();
    await ready();
    expect(clipboard).toEqual([zip]);
    expect(root.textContent).toContain(zip);
    buttonByText(root, 'Show file').click();
    await ready();
    expect(api.called('diagnostics:reveal')).toEqual([{ zipPath: zip }]);
  });

  it('diagnostics failure is shown', async () => {
    setup({ 'diagnostics:collect': () => { throw new Error('disk full'); } });
    await ready();
    buttonByText(root, 'Copy diagnostics').click();
    await ready();
    expect(q(root, '.status').textContent).toMatch(/Could not collect diagnostics: disk full/);
    expect(buttonByText(root, 'Copy diagnostics').disabled).toBe(false);
  });

  it('agent state pushes update the screen', async () => {
    setup();
    await ready();
    api.emit('host:agent-state-changed', { ...AGENT, listening: false, lastError: 'port busy' } as never);
    expect(root.textContent).toMatch(/Pair agent is not running. port busy/);
  });
});
