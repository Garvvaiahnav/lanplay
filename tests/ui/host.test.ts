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

describe('host screen on macOS', () => {
  const mstep = (stepId: string, status: string, data?: Record<string, unknown>, message = '') => ({ ...step(stepId, status, message), data });
  const MAC_INSTALL = { root: '/Users/me/Library/Application Support/LanPlay/sunshine', exe: '', serviceExe: '', configDir: '', configFile: '', logFile: '', certFile: '', foundVia: 'lanplay-managed' };
  const macStatus = (steps: unknown[], over: Record<string, unknown> = {}) => ({ lastRunAt: 'now', ok: false, steps, install: MAC_INSTALL, isAdmin: false, ...over });
  const NEEDS_SCREEN = mstep('mac-screen-recording', 'fail', { settingsPane: 'screen-recording' }, 'Sunshine cannot see the screen yet.');
  const NEEDS_INPUT = mstep('mac-input', 'warn', { settingsPane: 'accessibility', userAction: 'confirm-input' });

  function setupMac(steps: unknown[] = [], over: Record<string, (r: unknown) => unknown> = {}, status: Record<string, unknown> = {}): void {
    setup({
      'app:info': () => ({ role: 'host', version: '0.4.0', platform: 'darwin', arch: 'arm64', logFile: '/x.log', hostName: 'Garvs-Mac' }),
      'host:setup-status': () => macStatus(steps, status),
      'host:open-settings': () => undefined,
      ...over,
    });
  }

  it('speaks Mac: no Windows, administrator or UAC wording, and one "Set up this Mac" card', async () => {
    setupMac([], { 'host:setup-status': () => macStatus([], { lastRunAt: null, install: null }) });
    await ready();
    expect(q(root, 'section[aria-labelledby="h-name"] h2').textContent).toBe('This Mac');
    expect(buttonByText(root, 'Set up this Mac')).toBeTruthy();
    const shown = root.cloneNode(true) as HTMLElement;
    shown.querySelectorAll('[hidden]').forEach((e) => e.remove());
    expect(shown.textContent).not.toMatch(/Windows|administrator|This PC|PC /);
    expect(q(root, 'section[aria-labelledby="h-name"]').textContent).toMatch(/Screen Recording.*Accessibility/);
  });

  it('after setup it offers Set up / Repair like Windows', async () => {
    setupMac([mstep('mac-launch-agent', 'pass'), mstep('web-ui', 'pass')]);
    await ready();
    expect(buttonByText(root, 'Set up / Repair')).toBeTruthy();
    // no Windows "service" step on a Mac: the LaunchAgent step says whether Sunshine runs
    expect([...root.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['Installed: yes', 'Running: yes']);
  });

  it('shows the last run steps without pressing setup, so the buttons survive a relaunch', async () => {
    setupMac([NEEDS_SCREEN]);
    await ready();
    expect(root.querySelector('[aria-label="Setup steps"]')?.textContent).toMatch(/Sunshine cannot see the screen yet/);
  });

  it('a failing Screen Recording step has a button that opens exactly that pane', async () => {
    setupMac([NEEDS_SCREEN, mstep('web-ui', 'pass')]);
    await ready();
    buttonByText(root, 'Open Screen Recording settings').click();
    await flush();
    expect(api.called('host:open-settings')).toEqual([{ pane: 'screen-recording' }]);
  });

  it('Screen Recording: after the grant, "Restart Sunshine" on the step restarts it (Sunshine only checks at start)', async () => {
    let restarted = false;
    const denied = mstep('mac-screen-recording', 'fail', { settingsPane: 'screen-recording', userAction: 'restart-sunshine' });
    setupMac([], {
      'host:setup-status': () => macStatus([restarted ? mstep('mac-screen-recording', 'pass') : denied]),
      'host:sunshine-restart': () => { restarted = true; return macStatus([mstep('mac-screen-recording', 'pass')], { ok: true }); },
    });
    await ready();
    const step = q(root, '[aria-label="Setup steps"]');
    expect([...step.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open Screen Recording settings', 'Restart Sunshine']);
    [...step.querySelectorAll('button')].find((b) => b.textContent === 'Restart Sunshine')!.click();
    await flush();
    expect(api.called('host:sunshine-restart')).toHaveLength(1);
    expect(q(root, '[aria-label="Setup steps"]').querySelector('button')).toBeNull();
  });

  it('Accessibility: Open settings plus "I did this", which confirms and shows the new status', async () => {
    let confirmed = false;
    setupMac([], {
      'host:setup-status': () => macStatus(confirmed ? [mstep('mac-input', 'pass')] : [NEEDS_INPUT]),
      'host:confirm-input': () => { confirmed = true; return macStatus([mstep('mac-input', 'pass')], { ok: true }); },
    });
    await ready();
    buttonByText(root, 'Open Accessibility settings').click();
    await flush();
    expect(api.called('host:open-settings')).toEqual([{ pane: 'accessibility' }]);
    buttonByText(root, 'I did this').click();
    await flush();
    expect(api.called('host:confirm-input')).toEqual([{ ok: true }]);
    expect(root.querySelector('[aria-label="Setup steps"]')?.hasAttribute('hidden')).toBe(true);
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'I did this')).toBe(false);
    expect([...root.querySelectorAll('button')].some((b) => /settings$/.test(b.textContent ?? ''))).toBe(false);
  });

  it('a step that already passed carries no button, and an unknown pane name draws none', async () => {
    setupMac([mstep('mac-screen-recording', 'pass', { settingsPane: 'screen-recording' }), mstep('mac-network', 'warn', { settingsPane: 'https://evil.example' })]);
    await ready();
    expect([...root.querySelectorAll('[aria-label="Setup steps"] button')]).toHaveLength(0);
  });

  it('when macOS refuses to open the pane the error is shown', async () => {
    setupMac([NEEDS_SCREEN], { 'host:open-settings': () => { throw new Error('unknown pane'); } });
    await ready();
    buttonByText(root, 'Open Screen Recording settings').click();
    await flush();
    expect(q(root, '.status').textContent).toMatch(/Could not open System Settings: unknown pane/);
  });

  it('polls the status every 2 s while a step waits for Screen Recording, then stops', async () => {
    let granted = false;
    setupMac([], { 'host:setup-status': () => macStatus(granted ? [mstep('mac-screen-recording', 'pass'), mstep('web-ui', 'pass')] : [NEEDS_SCREEN]) });
    await ready();
    const polls = (): number => api.called('host:setup-status').length;
    const first = polls();
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls()).toBe(first + 1);
    granted = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls()).toBe(first + 2);
    expect(root.querySelector('.step.fail')).toBeNull();
    await vi.advanceTimersByTimeAsync(6000);
    expect(polls()).toBe(first + 2);
  });

  it('does not poll while only a confirm-input warning is open, nor after the screen is destroyed', async () => {
    setupMac([NEEDS_INPUT]);
    await ready();
    const n = api.called('host:setup-status').length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.called('host:setup-status')).toHaveLength(n);
    handle.destroy();
    setupMac([NEEDS_SCREEN]);
    await ready();
    const m = api.called('host:setup-status').length;
    handle.destroy();
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.called('host:setup-status')).toHaveLength(m);
  });

  it('Windows never polls', async () => {
    setup({ 'host:setup-status': () => ({ lastRunAt: 'now', ok: false, steps: [mstep('web-ui', 'fail', { settingsPane: 'screen-recording' })], install: INSTALL, isAdmin: false }) });
    await ready();
    const n = api.called('host:setup-status').length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.called('host:setup-status')).toHaveLength(n);
  });

  it('setup run: says what macOS will show, then points at the permissions still open', async () => {
    let finish: (v: unknown) => void = () => undefined;
    setupMac([], { 'host:setup-run': () => new Promise((r) => { finish = r; }) });
    await ready();
    buttonByText(root, 'Set up / Repair').click();
    await flush();
    expect(q(root, '.status').textContent).toMatch(/Background items/);
    finish(macStatus([NEEDS_SCREEN]));
    await ready();
    expect(q(root, '.status').textContent).toMatch(/System Settings/);
    expect(q(root, '.status').className).not.toContain('error-text');
    expect(buttonByText(root, 'Open Screen Recording settings')).toBeTruthy();
  });

  it('setup run with nothing left to do says the Mac is ready', async () => {
    setupMac([], { 'host:setup-run': () => macStatus([mstep('mac-input', 'pass')], { ok: true }) });
    await ready();
    buttonByText(root, 'Set up / Repair').click();
    await ready();
    expect(q(root, '.status').textContent).toBe('Setup finished. This Mac is ready.');
  });

  it('a pending Sunshine update shows a banner whose button restarts Sunshine', async () => {
    let restarted = false;
    setupMac([], {
      'host:setup-status': () => macStatus([mstep('mac-install', 'pass')], restarted ? {} : { sunshineUpdate: { installed: '2025.1.0', bundled: '2025.2.0' } }),
      'host:sunshine-restart': () => { restarted = true; return macStatus([mstep('mac-install', 'pass')], { ok: true }); },
    });
    await ready();
    const banner = q(root, '.banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/Sunshine update ready/);
    expect(banner.textContent).toMatch(/2025\.2\.0/);
    buttonByText(root, 'Restart Sunshine').click();
    await flush();
    expect(api.called('host:sunshine-restart')).toHaveLength(1);
    expect(q(root, '.banner').hidden).toBe(true);
  });

  it('no banner without an update, and none on Windows', async () => {
    setupMac([mstep('mac-install', 'pass')]);
    await ready();
    expect(q(root, '.banner').hidden).toBe(true);
    handle.destroy();
    setup({ 'host:setup-status': () => ({ lastRunAt: 'now', ok: true, steps: [], install: INSTALL, isAdmin: false, sunshineUpdate: { installed: '1', bundled: '2' } }) });
    await ready();
    expect(q(root, '.banner').hidden).toBe(true);
  });

  it('a failed restart is reported', async () => {
    setupMac([], {
      'host:setup-status': () => macStatus([], { sunshineUpdate: { installed: '1', bundled: '2' } }),
      'host:sunshine-restart': () => { throw new Error('launchctl exit 5'); },
    });
    await ready();
    buttonByText(root, 'Restart Sunshine').click();
    await flush();
    expect(q(root, '.status').textContent).toMatch(/Could not restart Sunshine: launchctl exit 5/);
    expect(buttonByText(root, 'Restart Sunshine').disabled).toBe(false);
  });
});

const PEND = [
  { id: 'a'.repeat(32), name: 'Friend laptop', address: '203.0.113.9', remote: true },
  { id: 'b'.repeat(32), name: 'Phone', address: '192.168.1.55', remote: false },
];
const NET_OFF = { enabled: false, lanAddresses: ['192.168.1.20'], globalIpv6: [] as string[] };
const NET_ON = { enabled: true, lanAddresses: ['192.168.1.20'], globalIpv6: ['2001:db8::20'] };
const pinFor = (id: string): HTMLInputElement => q<HTMLInputElement>(root, '#pin-' + id);
const type = (el: HTMLInputElement, v: string): void => {
  el.value = v;
  el.dispatchEvent(new Event('input'));
};

describe('Add a device with a code', () => {
  it('lists every pending pairing with name, address and an Internet tag only on remote ones', async () => {
    setup({ 'host:pending-list': () => PEND });
    await ready();
    const rows = [...root.querySelectorAll('[aria-label="Devices waiting for a code"] .item')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toMatch(/Friend laptop.*203\.0\.113\.9/);
    expect(rows[0]?.querySelector('.tag')?.textContent).toBe('Internet');
    expect(rows[1]?.querySelector('.tag')).toBeNull();
    expect(q(root, '#h-codes').textContent).toBe('Add a device with a code');
  });

  it('says nothing is waiting when the list is empty', async () => {
    setup({ 'host:pending-list': () => [] });
    await ready();
    expect(q(root, '[aria-label="Devices waiting for a code"]').textContent).toBe('Nothing waiting for a code.');
  });

  it('Pair stays off until four digits are typed, keeps only digits, then pairs with that code and name', async () => {
    const paired = { uuid: 'u9', name: 'Friend laptop', enabled: true, pairedVia: 'code', lastAddress: '203.0.113.9' };
    setup({
      'host:pending-list': () => PEND,
      'host:pending-pair': () => ({ ok: true, pending: [PEND[1]], devices: [...DEVICES, paired] }),
    });
    await ready();
    const id = PEND[0]!.id;
    const pairBtn = (): HTMLButtonElement => [...q(root, '[aria-label="Devices waiting for a code"] .item').querySelectorAll('button')].find((b) => b.textContent === 'Pair')!;
    expect(pairBtn().disabled).toBe(true);
    type(pinFor(id), '48a2');
    expect(pinFor(id).value).toBe('482');
    expect(pairBtn().disabled).toBe(true);
    type(pinFor(id), '4821');
    expect(pairBtn().disabled).toBe(false);
    pairBtn().click();
    await ready();
    expect(api.called('host:pending-pair')).toEqual([{ id, pin: '4821', name: 'Friend laptop' }]);
    expect(root.querySelectorAll('[aria-label="Devices waiting for a code"] .item')).toHaveLength(1);
    expect(root.querySelectorAll('[aria-label="Paired devices"] .item')).toHaveLength(3);
    expect(root.textContent).toContain('paired with a code, 203.0.113.9');
    expect(q(root, '.status').textContent).toBe('Friend laptop is paired.');
  });

  it('Enter in the code box pairs too', async () => {
    setup({ 'host:pending-list': () => PEND, 'host:pending-pair': () => ({ ok: true, pending: [], devices: DEVICES }) });
    await ready();
    const id = PEND[0]!.id;
    type(pinFor(id), '1234');
    pinFor(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await ready();
    expect(api.called('host:pending-pair')).toEqual([{ id, pin: '1234', name: 'Friend laptop' }]);
  });

  it('a wrong code shows the sentence under that row, keeps the row and clears the box', async () => {
    setup({ 'host:pending-list': () => PEND, 'host:pending-pair': () => ({ ok: false, message: 'That code is not right.', pending: PEND, devices: DEVICES }) });
    await ready();
    const id = PEND[0]!.id;
    type(pinFor(id), '0000');
    pinFor(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await ready();
    expect(root.querySelectorAll('[aria-label="Devices waiting for a code"] .item')).toHaveLength(2);
    expect(q(root, '[aria-label="Devices waiting for a code"] .smsg').textContent).toBe('That code is not right.');
    expect(pinFor(id).value).toBe('');
    expect(root.querySelectorAll('[aria-label="Paired devices"] .item')).toHaveLength(2);
  });

  it('Reject asks main to cancel that pairing and shows the list it returns', async () => {
    setup({ 'host:pending-list': () => PEND, 'host:pending-reject': () => [PEND[1]] });
    await ready();
    q(root, '[aria-label="Reject Friend laptop"]').click();
    await ready();
    expect(api.called('host:pending-reject')).toEqual([{ id: PEND[0]!.id }]);
    expect(root.querySelectorAll('[aria-label="Devices waiting for a code"] .item')).toHaveLength(1);
  });

  it('a poll does not wipe a code that is being typed, and picks up a new device', async () => {
    let list: unknown[] = [PEND[0]];
    setup({ 'host:pending-list': () => list });
    await ready();
    const id = PEND[0]!.id;
    type(pinFor(id), '48');
    pinFor(id).focus();
    list = [PEND[0], PEND[1]];
    await vi.advanceTimersByTimeAsync(3100);
    expect(root.querySelectorAll('[aria-label="Devices waiting for a code"] .item')).toHaveLength(2);
    expect(pinFor(id).value).toBe('48');
    expect(document.activeElement).toBe(pinFor(id));
  });

  it('stops polling when the screen is destroyed', async () => {
    setup({ 'host:pending-list': () => [] });
    await ready();
    handle.destroy();
    const n = api.called('host:pending-list').length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(api.called('host:pending-list')).toHaveLength(n);
  });
});

describe('Internet card', () => {
  const card = (): HTMLElement => q(root, 'section[aria-labelledby="h-net"]');
  const sw = (): HTMLElement => q(card(), '[role="switch"]');

  it('is off by default: the switch is off, the exposure text is beside it, the body and the banner are hidden', async () => {
    setup({ 'host:internet-get': () => NET_OFF });
    await ready();
    expect(sw().getAttribute('aria-label')).toBe('Allow connections from the internet');
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(card().textContent).toMatch(/opens Sunshine to the whole internet/);
    expect(card().textContent).toMatch(/runs as SYSTEM/);
    expect(q(card(), '.net-body').hidden).toBe(true);
    expect(q(root, '.notice').hidden).toBe(true);
  });

  it('cards come in the planned order', async () => {
    setup({ 'host:internet-get': () => NET_OFF });
    await ready();
    const titles = [...root.querySelectorAll('section.card')].filter((c) => !(c as HTMLElement).hidden).map((c) => c.querySelector('h2')?.textContent);
    expect(titles).toEqual(['This PC', 'Devices', 'Internet', 'Phone controllers', 'Health']);
  });

  it('switching on calls main, then shows the banner, the ports table, the LAN address and the global IPv6 address', async () => {
    setup({ 'host:internet-get': () => NET_OFF, 'host:internet-set': () => NET_ON });
    await ready();
    sw().click();
    await ready();
    expect(api.called('host:internet-set')).toEqual([{ on: true }]);
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(q(root, '.notice').hidden).toBe(false);
    const body = q(card(), '.net-body');
    expect(body.hidden).toBe(false);
    const rows = [...body.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent));
    expect(rows).toEqual([['TCP', '47984', 'HTTPS (pairing, launch)'], ['TCP', '47989', 'HTTP (status, pairing start)'], ['TCP', '48010', 'RTSP'], ['UDP', '47998, 47999, 48000', 'video, control, audio']]);
    expect(body.textContent).toContain('192.168.1.20');
    expect(body.textContent).toContain('2001:db8::20');
    expect(body.textContent).toMatch(/Never forward 47990, 47920, 47921/);
    expect(body.textContent).toMatch(/CGNAT/);
    expect(q(root, '.status').textContent).toBe('Internet play is on.');
  });

  it('the banner has a Switch off button that turns it off', async () => {
    setup({ 'host:internet-get': () => NET_ON, 'host:internet-set': () => NET_OFF });
    await ready();
    expect(q(root, '.notice').hidden).toBe(false);
    buttonByText(q(root, '.notice'), 'Switch off').click();
    await ready();
    expect(api.called('host:internet-set')).toEqual([{ on: false }]);
    expect(q(root, '.notice').hidden).toBe(true);
    expect(q(card(), '.net-body').hidden).toBe(true);
  });

  it('a refused switch rolls back and says why; main\'s own error text is shown', async () => {
    setup({ 'host:internet-get': () => NET_OFF, 'host:internet-set': () => { throw new Error('Windows permission was refused.'); } });
    await ready();
    sw().click();
    await ready();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(q(root, '.status').textContent).toBe('Could not change internet play: Windows permission was refused.');
    expect(q(root, '.status').className).toContain('error-text');
    expect((sw() as HTMLButtonElement).disabled).toBe(false);
  });

  it('a switch that main reverted says so with main\'s error, not "Internet play is on."', async () => {
    const reverted = { ...NET_OFF, lastError: 'Could not create the firewall rule: Access is denied.' };
    setup({ 'host:internet-get': () => NET_OFF, 'host:internet-set': () => reverted });
    await ready();
    sw().click();
    await ready();
    expect(api.called('host:internet-set')).toEqual([{ on: true }]);
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(q(root, '.notice').hidden).toBe(true);
    expect(q(root, '.status').textContent).toBe('Internet play is still off. Could not create the firewall rule: Access is denied.');
    expect(q(root, '.status').className).toContain('error-text');
    expect(q(root, '.status').textContent).not.toContain('is on.');
  });

  it('turning off that main could not apply says it is still on', async () => {
    const stuck = { ...NET_ON, lastError: 'Sunshine did not come back.' };
    setup({ 'host:internet-get': () => NET_ON, 'host:internet-set': () => stuck });
    await ready();
    buttonByText(q(root, '.notice'), 'Switch off').click();
    await ready();
    expect(q(root, '.status').textContent).toBe('Internet play is still on. Sunshine did not come back.');
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('the switch is disabled while the elevated run is going', async () => {
    let finish: (v: unknown) => void = () => undefined;
    setup({ 'host:internet-get': () => NET_OFF, 'host:internet-set': () => new Promise((r) => { finish = r; }) });
    await ready();
    sw().click();
    await flush();
    expect((sw() as HTMLButtonElement).disabled).toBe(true);
    expect(q(root, '.status').textContent).toMatch(/Approve the Windows prompt/);
    finish(NET_ON);
    await ready();
    expect((sw() as HTMLButtonElement).disabled).toBe(false);
  });

  it('host:internet-changed updates the card and shows main\'s last error', async () => {
    setup({ 'host:internet-get': () => NET_OFF });
    await ready();
    api.emit('host:internet-changed', { ...NET_ON, lastError: 'UPnP did not answer.' } as never);
    expect(q(root, '.notice').hidden).toBe(false);
    expect(q(card(), '.hint.err').textContent).toBe('UPnP did not answer.');
  });

  it('the setup step list stays hidden unless a step failed', async () => {
    setup({ 'host:internet-get': () => NET_OFF });
    await ready();
    expect(q(root, '[aria-label="Setup steps"]').hidden).toBe(true);
  });

  it('on a Mac: the card is there, with no Windows, PC or SYSTEM wording and no pair-agent hint on the switch', async () => {
    setup({
      'app:info': () => ({ role: 'host', version: '0.5.0', platform: 'darwin', arch: 'arm64', logFile: '/x.log', hostName: 'Garvs-Mac' }),
      'host:setup-status': () => ({ lastRunAt: 'now', ok: true, steps: [], install: INSTALL, isAdmin: false }),
      'host:internet-get': () => NET_ON,
    });
    await ready();
    const text = card().textContent ?? '';
    expect(text).toMatch(/this Mac/);
    expect(text).not.toMatch(/Windows|PC|SYSTEM/);
  });
});
