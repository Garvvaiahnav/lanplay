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

describe('role decided by the app (Windows = host, Mac = client)', () => {
  it('opens that screen directly: no first-run question, no Change mode, nothing stored', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    const store = memStore('host'); // even a stale stored choice does not win over the real role
    const h = LPG.App.start(root, api(), store, 'client');
    await flush();
    expect(root.querySelector('button.big')).toBeNull();
    expect(root.querySelector('.stream-btn')).toBeTruthy();
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Change mode')).toBe(false);
    expect(store.peek()).toBe('host');
    h.destroy();
    const root2 = document.body.appendChild(document.createElement('div'));
    const h2 = LPG.App.start(root2, api(), memStore(), 'host');
    await flush();
    expect(root2.textContent).toMatch(/Sunshine/);
    expect(root2.textContent).toMatch(/keeps running in the background/);
    expect([...root2.querySelectorAll('button')].some((b) => b.textContent === 'Change mode')).toBe(false);
    h2.destroy();
  });

  it('boot() asks the app for its role; if that fails it falls back to the question', async () => {
    const w = window as unknown as { __LANPLAY_NO_AUTOSTART__?: boolean; lanplay?: unknown };
    document.body.innerHTML = '<div id="app"></div>';
    w.__LANPLAY_NO_AUTOSTART__ = false;
    try {
      w.lanplay = api();
      LPG.App.boot();
      await flush();
      expect(document.getElementById('app')!.textContent).toMatch(/LanPlay host/);
      expect(document.querySelector('button.big')).toBeNull();

      document.body.innerHTML = '<div id="app"></div>';
      const broken = api();
      broken.handlers['app:info'] = () => { throw new Error('nope'); };
      w.lanplay = broken;
      window.localStorage.removeItem('lanplay.mode');
      LPG.App.boot();
      await flush();
      expect(document.querySelectorAll('button.big')).toHaveLength(2);
    } finally {
      w.__LANPLAY_NO_AUTOSTART__ = true;
      delete w.lanplay;
    }
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

describe('Windows role chooser (app:role-set)', () => {
  function winApi(info: Record<string, unknown>, relaunching: boolean) {
    const a = api();
    a.handlers['app:info'] = () => ({ role: 'host', version: '1', platform: 'win32', arch: 'x64', logFile: '', ...info });
    a.handlers['app:role-set'] = () => ({ relaunching });
    return a;
  }
  async function boot(a: ReturnType<typeof api>) {
    const w = window as unknown as { __LANPLAY_NO_AUTOSTART__?: boolean; lanplay?: unknown };
    document.body.innerHTML = '<div id="app"></div>';
    w.__LANPLAY_NO_AUTOSTART__ = false;
    w.lanplay = a;
    try {
      LPG.App.boot();
      await flush();
    } finally {
      w.__LANPLAY_NO_AUTOSTART__ = true;
      delete w.lanplay;
    }
    return document.getElementById('app')!;
  }

  it('no stored role: shows the chooser; picking the other role stores it and shows a restart message', async () => {
    const a = winApi({ canChooseRole: true, roleStored: false }, true);
    const root = await boot(a);
    expect(root.querySelectorAll('button.big')).toHaveLength(2);
    (root.querySelectorAll('button.big')[0] as HTMLButtonElement).click();
    await flush();
    expect(a.calls.find((c) => c.channel === 'app:role-set')?.req).toEqual({ role: 'client' });
    expect(root.textContent).toMatch(/Restarting LanPlay/);
  });

  it('stored role opens that screen with a Change role link back to the chooser', async () => {
    const a = winApi({ role: 'client', canChooseRole: true, roleStored: true }, false);
    const root = await boot(a);
    expect(root.querySelector('.stream-btn')).toBeTruthy();
    expect(root.textContent).toMatch(/Ctrl\+Alt\+Shift\+Q/);
    expect(root.textContent).toMatch(/Ctrl\+Alt\+Shift\+Z/);
    buttonByText(root, 'Change role').click();
    await flush();
    expect(root.querySelectorAll('button.big')).toHaveLength(2);
    (root.querySelectorAll('button.big')[0] as HTMLButtonElement).click();
    await flush();
    expect(a.calls.filter((c) => c.channel === 'app:role-set')).toHaveLength(1);
    expect(root.querySelector('.stream-btn')).toBeTruthy();
  });

  it('host screen also gets Change role on Windows', async () => {
    const a = winApi({ role: 'host', canChooseRole: true, roleStored: true }, false);
    const root = await boot(a);
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Change role')).toBe(true);
  });
});

describe('Mac: role chooser reachable from the client screen, never asked on first launch', () => {
  function macApi(info: Record<string, unknown>) {
    const a = api();
    a.handlers['app:info'] = () => ({ role: 'client', version: '1', platform: 'darwin', arch: 'arm64', logFile: '', canChooseRole: true, roleStored: true, ...info });
    a.handlers['app:role-set'] = () => ({ relaunching: true });
    return a;
  }
  async function boot(a: ReturnType<typeof api>) {
    const w = window as unknown as { __LANPLAY_NO_AUTOSTART__?: boolean; lanplay?: unknown };
    document.body.innerHTML = '<div id="app"></div>';
    w.__LANPLAY_NO_AUTOSTART__ = false;
    w.lanplay = a;
    try {
      LPG.App.boot();
      await flush();
    } finally {
      w.__LANPLAY_NO_AUTOSTART__ = true;
      delete w.lanplay;
    }
    return document.getElementById('app')!;
  }

  it('opens the client screen straight away, even if main did not mark the role as stored', async () => {
    const root = await boot(macApi({ roleStored: false }));
    expect(root.querySelector('button.big')).toBeNull();
    expect(root.querySelector('.stream-btn')).toBeTruthy();
  });

  it('Change role leads to a chooser in Mac words; choosing Host stores the role through main', async () => {
    const a = macApi({});
    const root = await boot(a);
    buttonByText(root, 'Change role').click();
    await flush();
    const titles = [...root.querySelectorAll('button.big .big-title')].map((t) => t.textContent);
    expect(titles).toEqual(['Play on this screen', 'This Mac hosts games']);
    expect(root.textContent).toContain('Play games that run on this computer from another device.');
    expect(root.textContent).not.toMatch(/gaming PC|This PC/);
    expect(root.textContent).toContain('What is this Mac for?');
    (root.querySelectorAll('button.big')[1] as HTMLButtonElement).click();
    await flush();
    expect(a.called('app:role-set')).toEqual([{ role: 'host' }]);
    expect(root.textContent).toMatch(/Restarting LanPlay/);
  });

  it('a Mac that cannot host (older than macOS 14 or Intel) gets no way into the host role', async () => {
    const root = await boot(macApi({ hostSupported: false }));
    expect(root.querySelector('.stream-btn')).toBeTruthy();
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Change role')).toBe(false);
  });

  it('the Mac host screen offers Change role back to the client', async () => {
    const root = await boot(macApi({ role: 'host' }));
    expect(root.textContent).toMatch(/Set up this Mac/);
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Change role')).toBe(true);
  });

  it('Windows chooser words are unchanged', async () => {
    const a = api();
    a.handlers['app:info'] = () => ({ role: 'client', version: '1', platform: 'win32', arch: 'x64', logFile: '', canChooseRole: true, roleStored: true });
    const root = await boot(a);
    buttonByText(root, 'Change role').click();
    await flush();
    expect([...root.querySelectorAll('button.big .big-title')].map((t) => t.textContent)).toEqual(['Play on this screen', 'This PC hosts games']);
  });
});
