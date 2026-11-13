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

  /**
   * fixedRole: what this computer can be in v1 (main decides: Windows = host, macOS = client, see app:info). When set,
   * the matching screen opens directly: no "what is this computer for?" question whose wrong answer leads to a screen
   * where nothing works. Without it (tests, or app:info failed) the first-run choice is shown.
   */
  export function start(root: HTMLElement, api: T.Api, store: Store = browserStore(), fixedRole: Mode | null = null): { destroy(): void } {
    let current: { destroy(): void } | null = null;

    function show(mode: Mode | null): void {
      current?.destroy();
      current = null;
      if (!fixedRole) store.set(mode);
      const opts = fixedRole ? {} : { onSwitchMode: () => show(null) };
      if (mode === 'client') current = Client.mount(root, api, opts);
      else if (mode === 'host') current = Host.mount(root, api, opts);
      else firstRun();
    }

    function firstRun(): void {
      const big = (title: string, sub: string, mode: Mode): HTMLButtonElement =>
        h('button', { type: 'button', class: 'big', onClick: () => show(mode) }, h('span', { class: 'big-title' }, title), h('span', { class: 'big-sub' }, sub));
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
      (info) => start(root, api, browserStore(), info.role === 'host' || info.role === 'client' ? info.role : null),
      () => start(root, api),
    );
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => LP.App.boot());
else LP.App.boot();
