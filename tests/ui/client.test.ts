// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, DEFAULTS, fakeApi, flush, HOST_A, HOST_B, loadRenderer, q, type FakeApi, type LP } from './helpers.js';

let LPG: LP;
beforeAll(() => {
  LPG = loadRenderer();
});

const CHIP_M4 = { model: 'Apple M4', generation: 4, av1HardwareDecode: true };
let root: HTMLElement;
let api: FakeApi;
let handle: { destroy(): void };

function setup(over: Record<string, (r: unknown) => unknown> = {}, hosts: unknown[] = [HOST_A]): void {
  api = fakeApi({
    'client:settings-get': () => ({ ...DEFAULTS }),
    'client:settings-set': (s) => s,
    'client:system-info': () => ({ chip: CHIP_M4, moonlightPath: '/x', moonlightVersion: '6.2.0' }),
    'client:discover-start': () => hosts,
    'client:discover-stop': () => undefined,
    'client:pair': (r) => ({ ok: true, hostId: (r as { hostId: string }).hostId, alreadyPaired: false, durationMs: 5 }),
    'client:stream-start': (r) => ({ hostId: (r as { hostId: string }).hostId, state: 'running' }),
    'client:stream-stop': () => undefined,
    ...over,
  });
  root = document.createElement('div');
  document.body.appendChild(root);
  handle = LPG.Client.mount(root, api, { onSwitchMode: () => undefined });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  handle?.destroy();
  vi.useRealTimers();
});

const ready = async (): Promise<void> => {
  await flush();
  await vi.advanceTimersByTimeAsync(0);
};
const status = (): string => q(root, '.status').textContent ?? '';
const radio = (label: string): HTMLButtonElement => buttonByText(root, label);

describe('client screen states', () => {
  it('shows searching, then no-host after the timeout, with the manual IP box still there', async () => {
    setup({}, []);
    await ready();
    expect(status()).toMatch(/Looking for your PC/);
    expect(buttonByText(root, 'Stream').disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(6100);
    expect(status()).toMatch(/No PC found/);
    expect(q(root, '#manual-ip')).toBeTruthy();
  });

  it('lists hosts with a status dot and words, selects the paired one', async () => {
    setup({}, [HOST_B, HOST_A]);
    await ready();
    const rows = [...root.querySelectorAll('.host')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.dot.warn')).toBeTruthy();
    expect(rows[0]?.textContent).toMatch(/Needs pairing/);
    expect(rows[1]?.querySelector('.dot.ok')).toBeTruthy();
    expect(rows[1]?.textContent).toMatch(/Ready/);
    expect(q<HTMLInputElement>(root, '#host-uid-a').checked).toBe(true);
    expect(status()).toMatch(/Ready to play on GAMING-PC/);
  });

  it('hosts pushed by events appear', async () => {
    setup({}, []);
    await ready();
    api.emit('client:hosts-updated', [HOST_A as never]);
    expect(root.querySelectorAll('.host')).toHaveLength(1);
    expect(status()).toMatch(/Ready to play/);
  });
});

describe('settings controls', () => {
  it('picking a preset updates every control and saves once (debounced)', async () => {
    setup();
    await ready();
    radio('Lowest latency').click();
    expect(radio('1080p').getAttribute('aria-checked')).toBe('true');
    expect(radio('120').getAttribute('aria-checked')).toBe('true');
    expect(q<HTMLInputElement>(root, '#bitrate').value).toBe('50');
    expect(root.textContent).toMatch(/1080p at 120 fps, no V-Sync/);
    expect(api.called('client:settings-set')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    const saved = api.called('client:settings-set') as Array<Record<string, unknown>>;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ presetId: 'lowest-latency', resolution: '1080p', fps: 120, bitrateMbps: 50 });
  });

  it('any manual change switches the preset to Custom', async () => {
    setup();
    await ready();
    radio('4K').click();
    expect(radio('Custom').getAttribute('aria-checked')).toBe('true');
    expect(radio('Balanced').getAttribute('aria-checked')).toBe('false');
  });

  it('bitrate slider: 20..150, advanced switch allows up to 500 and turning it off clamps', async () => {
    setup();
    await ready();
    const range = q<HTMLInputElement>(root, '#bitrate');
    expect([range.min, range.max, range.step]).toEqual(['20', '150', '5']);
    const adv = q<HTMLInputElement>(root, '#adv');
    adv.checked = true;
    adv.dispatchEvent(new Event('change'));
    expect(range.max).toBe('500');
    range.value = '300';
    range.dispatchEvent(new Event('input'));
    expect(q(root, 'output').textContent).toBe('300 Mbps');
    adv.checked = false;
    adv.dispatchEvent(new Event('change'));
    expect(range.max).toBe('150');
    expect(range.value).toBe('150');
  });

  it('codec hint warns about AV1 only when the Mac cannot decode it', async () => {
    setup({ 'client:system-info': () => ({ chip: { model: 'Apple M1', generation: 1, av1HardwareDecode: false }, moonlightPath: null, moonlightVersion: null }) });
    await ready();
    radio('AV1').click();
    expect(root.textContent).toMatch(/no AV1 hardware decoder/);
    radio('Auto').click();
    expect(root.textContent).toMatch(/Auto picks HEVC/);
  });

  it('segmented controls work from the keyboard (arrow keys)', async () => {
    setup();
    await ready();
    const sixty = radio('60');
    expect(radio('120').tabIndex).toBe(0);
    expect(sixty.tabIndex).toBe(-1);
    radio('120').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(sixty.getAttribute('aria-checked')).toBe('true');
    expect(radio('Custom').getAttribute('aria-checked')).toBe('true');
  });

  it('save failure is shown, not swallowed', async () => {
    setup({ 'client:settings-set': () => { throw new Error('disk full'); } });
    await ready();
    radio('4K').click();
    await vi.advanceTimersByTimeAsync(300);
    expect(q(root, '.error').textContent).toMatch(/disk full/);
  });
});

describe('manual host', () => {
  it('rejects junk locally without calling main', async () => {
    setup({}, []);
    await ready();
    q<HTMLInputElement>(root, '#manual-ip').value = 'http://evil';
    buttonByText(root, 'Add').click();
    expect(api.called('client:add-manual-host')).toHaveLength(0);
    expect(root.textContent).toMatch(/does not look like an IP/);
  });

  it('adds a host, selects it and clears the box; Enter works too', async () => {
    setup({ 'client:add-manual-host': (r) => ({ ...HOST_B, preferredAddress: (r as { address: string }).address }) }, []);
    await ready();
    const input = q<HTMLInputElement>(root, '#manual-ip');
    input.value = '192.168.1.30';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(api.called('client:add-manual-host')).toEqual([{ address: '192.168.1.30' }]);
    expect(root.querySelectorAll('.host')).toHaveLength(1);
    expect(input.value).toBe('');
  });

  it('shows the reason when the host cannot be reached', async () => {
    setup({ 'client:add-manual-host': () => { throw new Error('timed out'); } }, []);
    await ready();
    q<HTMLInputElement>(root, '#manual-ip').value = '10.0.0.9';
    buttonByText(root, 'Add').click();
    await flush();
    expect(root.textContent).toMatch(/Could not reach 10.0.0.9: timed out/);
  });
});

describe('stream button', () => {
  it('paired host: streams with the current settings, shows streaming + Stop', async () => {
    setup();
    await ready();
    expect(buttonByText(root, 'Stream').disabled).toBe(false);
    buttonByText(root, 'Stream').click();
    await flush();
    expect(api.called('client:pair')).toHaveLength(0);
    expect(api.called('client:stream-start')).toEqual([{ hostId: 'uid-a', settings: expect.objectContaining({ resolution: '1440p', fps: 120, bitrateMbps: 80, codec: 'auto' }) }]);
    expect(status()).toMatch(/Streaming from GAMING-PC/);
    expect(radio('4K').disabled).toBe(true);
    buttonByText(root, 'Stop streaming').click();
    await flush();
    expect(api.called('client:stream-stop')).toEqual([{ hostId: 'uid-a' }]);
    api.emit('client:stream-state', { hostId: 'uid-a', state: 'ended', exitCode: 0 });
    expect(status()).toMatch(/Ready to play/);
    expect(radio('4K').disabled).toBe(false);
  });

  it('unpaired host: pairs first (with progress), then streams', async () => {
    let finish: (v: unknown) => void = () => undefined;
    setup({ 'client:pair': () => new Promise((r) => { finish = r; }) }, [HOST_B]);
    await ready();
    expect(buttonByText(root, 'Pair and stream')).toBeTruthy();
    buttonByText(root, 'Pair and stream').click();
    await flush();
    expect(status()).toMatch(/Checking the PC/);
    api.emit('client:pair-progress', { hostId: HOST_B.id, phase: 'waiting-approval', message: 'x' });
    expect(status()).toMatch(/Waiting for someone to approve/);
    expect(buttonByText(root, 'Pairing...').disabled).toBe(true);
    finish({ ok: true, hostId: HOST_B.id, alreadyPaired: false, durationMs: 1 });
    await flush(12);
    expect(api.called('client:stream-start')).toHaveLength(1);
    expect(status()).toMatch(/Streaming/);
  });

  it('pairing failure: friendly error, no stream, can retry', async () => {
    setup({ 'client:pair': () => ({ ok: false, hostId: 'x', code: 'agent-unreachable', message: 'ECONNREFUSED', retryable: true, durationMs: 1 }) }, [HOST_B]);
    await ready();
    buttonByText(root, 'Pair and stream').click();
    await flush(12);
    expect(q(root, '.error').textContent).toMatch(/Could not reach LanPlay on the PC/);
    expect(q(root, '.error').textContent).not.toMatch(/ECONNREFUSED/);
    expect(api.called('client:stream-start')).toHaveLength(0);
    expect(status()).toMatch(/Something went wrong/);
    expect(buttonByText(root, 'Pair and stream').disabled).toBe(false);
  });

  it('a failed stream start shows the message', async () => {
    setup({ 'client:stream-start': (r) => ({ hostId: (r as { hostId: string }).hostId, state: 'failed', message: 'Moonlight exited with code 3' }) });
    await ready();
    buttonByText(root, 'Stream').click();
    await flush(12);
    expect(q(root, '.error').textContent).toMatch(/exited with code 3/);
    expect(q(root, '.error').hasAttribute('hidden')).toBe(false);
  });

  it('a thrown IPC error becomes a visible error', async () => {
    setup({ 'client:stream-start': () => { throw new Error('bridge down'); } });
    await ready();
    buttonByText(root, 'Stream').click();
    await flush(12);
    expect(q(root, '.error').textContent).toMatch(/bridge down/);
  });

  it('stream button is the primary big control and keyboard focusable', async () => {
    setup();
    await ready();
    const b = buttonByText(root, 'Stream');
    expect(b.className).toContain('stream-btn');
    expect(b.tabIndex).toBe(0);
  });
});

describe('cleanup', () => {
  it('destroy stops discovery and unsubscribes events', async () => {
    setup();
    await ready();
    handle.destroy();
    expect(api.called('client:discover-stop').length).toBeGreaterThan(0);
    expect(root.childNodes).toHaveLength(0);
    api.emit('client:hosts-updated', [HOST_B as never]);
    expect(root.childNodes).toHaveLength(0);
  });
});
