/* Entry: first-run choice, then the client or host screen. */
namespace LP.App {
  import h = Dom.h;

  export type Mode = 'client' | 'host';
  const KEY = 'lanplay.mode';

  export interface Store { get(): Mode | null; set(m: Mode | null): void }

  /** localStorage can throw or be empty (private windows etc): every access is guarded. */
  export function browserStore(): Store {
    return {
      get() {
        try {
          const v = window.localStorage.getItem(KEY);
          return v === 'client' || v === 'host' ? v : null;
        } catch {
          return null;
        }
      },
      set(m) {
        try {
          if (m) window.localStorage.setItem(KEY, m);
          else window.localStorage.removeItem(KEY);
        } catch {
          /* ignore */
        }
      },
    };
  }

  /** In-memory store seeded from main (Windows: the role lives in main's shared settings, not localStorage). */
  export function memoryStore(initial: Mode | null): Store {
    let v = initial;
    return { get: () => v, set: (m) => { v = m; } };
  }

  /** Windows role chooser: stores the role in main; resolves true when main is relaunching in the other role. */
  export interface RoleChooser { choose(mode: Mode): Promise<boolean> }

  /**
   * fixedRole: what this computer can be in v1 (main decides: Windows = host, macOS = client, see app:info). When set,
   * the matching screen opens directly: no "what is this computer for?" question whose wrong answer leads to a screen
   * where nothing works. Without it (tests, or app:info failed) the first-run choice is shown.
   */
  export function start(root: HTMLElement, api: T.Api, store: Store = browserStore(), fixedRole: Mode | null = null, chooser: RoleChooser | null = null): { destroy(): void } {
    let current: { destroy(): void } | null = null;

    function pick(mode: Mode): void {
      if (!chooser) return show(mode);
      Dom.setChildren(root, [h('main', { class: 'screen first' }, h('p', { class: 'lead', role: 'status' }, 'Saving your choice...'))]);
      chooser.choose(mode).then(
        (relaunching) => {
          if (relaunching) Dom.setChildren(root, [h('main', { class: 'screen first' }, h('p', { class: 'lead', role: 'status' }, 'Restarting LanPlay for this choice...'))]);
          else show(mode);
        },
        (e: unknown) => {
          firstRun();
          root.querySelector('main')?.appendChild(h('p', { class: 'error', role: 'alert' }, 'Could not save your choice: ' + String((e as Error)?.message ?? e)));
        },
      );
    }

    function show(mode: Mode | null): void {
      current?.destroy();
      current = null;
      if (!fixedRole) store.set(mode);
      const opts = fixedRole ? {} : { onSwitchMode: () => show(null), switchLabel: chooser ? 'Change role' : 'Change mode' };
      if (mode === 'client') current = Client.mount(root, api, opts);
      else if (mode === 'host') current = Host.mount(root, api, opts);
      else firstRun();
    }

    function firstRun(): void {
      const big = (title: string, sub: string, mode: Mode): HTMLButtonElement =>
        h('button', { type: 'button', class: 'big', onClick: () => pick(mode) }, h('span', { class: 'big-title' }, title), h('span', { class: 'big-sub' }, sub));
      const first = big('Play on this screen', 'This computer connects to a gaming PC and shows its games.', 'client');
      Dom.setChildren(root, [h('main', { class: 'screen first' },
        h('h1', null, 'LanPlay'),
        h('p', { class: 'lead' }, 'Play PC games on another computer in your home. What is this computer for?'),
        h('div', { class: 'bigs' }, first, big('This PC hosts games', 'This is the gaming PC. LanPlay sets it up for you.', 'host')))]);
      first.focus();
    }

    show(fixedRole ?? store.get());
    return { destroy: () => current?.destroy() };
  }

  /** Boot in the real app. Tests set window.__LANPLAY_NO_AUTOSTART__ and call start() themselves. */
  export function boot(): void {
    const w = window as unknown as { __LANPLAY_NO_AUTOSTART__?: boolean };
    const root = document.getElementById('app');
    if (w.__LANPLAY_NO_AUTOSTART__ || !root) return;
    if (!window.lanplay) {
      root.textContent = 'LanPlay could not start (no bridge to the app). Please restart it.';
      return;
    }
    const api = window.lanplay;
    root.textContent = 'Starting...';
    api.invoke('app:info').then(
      (info) => {
        const role = info.role === 'host' || info.role === 'client' ? info.role : null;
        // Windows: the user picks client or host (first run shows the chooser until main has a stored role).
        if (info.canChooseRole) {
          const chooser: RoleChooser = { choose: (m) => api.invoke('app:role-set', { role: m }).then((r) => r.relaunching) };
          return start(root, api, memoryStore(info.roleStored ? role : null), null, chooser);
        }
        return start(root, api, browserStore(), role);
      },
      () => start(root, api),
    );
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => LP.App.boot());
else LP.App.boot();
