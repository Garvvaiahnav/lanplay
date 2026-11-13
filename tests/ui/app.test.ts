// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, fakeApi, flush, loadRenderer, q, buttonByText, type LP } from './helpers.js';

let LPG: LP;
beforeAll(() => {
  LPG = loadRenderer();
});

const api = () =>
  fakeApi({
    'client:settings-get': () => ({ ...DEFAULTS }),
    'client:settings-set': (s) => s,
    'client:system-info': () => ({ chip: { model: 'Apple M4', generation: 4, av1HardwareDecode: true }, moonlightPath: null, moonlightVersion: null }),
    'client:discover-start': () => [],
    'client:discover-stop': () => undefined,
    'app:info': () => ({ role: 'host', version: '1', platform: 'win32', arch: 'x64', logFile: '' }),
    'host:setup-status': () => ({ lastRunAt: null, ok: false, steps: [], install: null, isAdmin: false }),
    'host:agent-state': () => ({ listening: true, port: 47920, autoApprove: true, pending: [] }),
    'host:devices-list': () => [],
  });

function memStore(initial: 'client' | 'host' | null = null) {
  let v = initial;
  return { get: () => v, set: (m: 'client' | 'host' | null) => { v = m; }, peek: () => v };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('first run', () => {
  it('offers exactly two big buttons, focuses the first', () => {
    const root = document.body.appendChild(document.createElement('div'));
    LPG.App.start(root, api(), memStore());
    const bigs = [...root.querySelectorAll('button.big')];
    expect(bigs.map((b) => q(b as HTMLElement, '.big-title').textContent)).toEqual(['Play on this screen', 'This PC hosts games']);
    expect(document.activeElement).toBe(bigs[0]);
  });

  it('"Play on this screen" opens the client screen and remembers the choice', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const store = memStore();
    const h = LPG.App.start(root, api(), store);
    (root.querySelector('button.big') as HTMLButtonElement).click();
    await flush();
    expect(store.peek()).toBe('client');
    expect(root.querySelector('.stream-btn')).toBeTruthy();
    h.destroy();
  });

  it('"This PC hosts games" opens the host screen; Change mode goes back', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const store = memStore();
    const h = LPG.App.start(root, api(), store);
    buttonByText(root, 'This PC hosts gamesThis is the gaming PC. LanPlay sets it up for you.').click();
    await flush();
    expect(store.peek()).toBe('host');
    expect(root.textContent).toMatch(/Sunshine/);
    buttonByText(root, 'Change mode').click();
    expect(store.peek()).toBeNull();
    expect(root.querySelectorAll('button.big')).toHaveLength(2);
    h.destroy();
  });

  it('a remembered mode skips the first-run screen', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const h = LPG.App.start(root, api(), memStore('client'));
    await flush();
    expect(root.querySelector('button.big')).toBeNull();
    expect(root.querySelector('.stream-btn')).toBeTruthy();
    h.destroy();
  });
});

describe('storage safety', () => {
  it('browserStore survives a throwing localStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const s = LPG.App.browserStore();
    expect(s.get()).toBeNull();
    expect(() => s.set('client')).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });
  it('browserStore round-trips and ignores garbage values', () => {
    const s = LPG.App.browserStore();
    s.set('host');
    expect(s.get()).toBe('host');
    window.localStorage.setItem('lanplay.mode', 'evil');
    expect(s.get()).toBeNull();
  });
});
