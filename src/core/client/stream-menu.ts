// Exit/settings/reconnect menu logic while streaming (pure, no Electron: main injects the cursor, displays and windows).
import type { StreamState } from '../../contracts.js';
import { DEFAULT_HOT_CORNER, HotCornerTracker } from './hot-corner.js';
import type { HotCornerConfig, Point, Rect } from './hot-corner.js';

/** dismiss = "keep playing"; close = disconnect; settings = disconnect and show the app to change them; reconnect = restart the stream. */
export const MENU_ACTIONS = ['close', 'settings', 'reconnect', 'dismiss'] as const;
export type MenuAction = (typeof MENU_ACTIONS)[number];

/** The menu window is untrusted input: anything that is not exactly a known action is rejected. */
export function parseMenuAction(v: unknown): MenuAction | null {
  return typeof v === 'string' && (MENU_ACTIONS as readonly string[]).includes(v) ? (v as MenuAction) : null;
}

export interface StreamMenuDeps {
  getCursor(): Point;
  getDisplays(): readonly Rect[];
  now(): number;
  /** Show the menu on this display (centered). */
  openMenu(display: Rect): void;
  closeMenu(): void;
  /** Stop Moonlight for this host (resolves when asked to stop; the state callback reports 'ended'). */
  stopStream(hostId: string): Promise<void>;
  /** Start a stream to this host with the saved settings (reports state through onStreamState). */
  startStream(hostId: string): Promise<unknown>;
  showMainWindow(): void;
  sleep(ms: number): Promise<void>;
}

export interface StreamMenuConfig extends HotCornerConfig {
  /** Poll interval for the cursor and for waiting on a stopping stream. */
  pollMs: number;
  /** Reconnect gives up if the old stream has not ended after this long. */
  stopWaitMs: number;
}

export const DEFAULT_STREAM_MENU: StreamMenuConfig = Object.freeze({ ...DEFAULT_HOT_CORNER, pollMs: 60, stopWaitMs: 5000 });

export class StreamMenuController {
  private active: string | null = null;
  private menuOpen = false;
  private readonly tracker: HotCornerTracker;
  private readonly cfg: StreamMenuConfig;

  constructor(
    private readonly d: StreamMenuDeps,
    cfg: Partial<StreamMenuConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_STREAM_MENU, ...cfg };
    this.tracker = new HotCornerTracker(this.cfg);
  }

  get pollMs(): number {
    return this.cfg.pollMs;
  }

  activeHostId(): string | null {
    return this.active;
  }

  /** Feed every stream state change here. */
  onStreamState(st: StreamState): void {
    if (st.state === 'starting' || st.state === 'running') {
      this.active = st.hostId;
      return;
    }
    if (this.active === st.hostId) this.active = null;
    this.tracker.reset();
    if (this.menuOpen) {
      this.menuOpen = false;
      this.d.closeMenu();
    }
  }

  /** Call every pollMs. Cheap and idle unless a stream is running and the menu is closed. */
  tick(): void {
    if (this.active === null || this.menuOpen) return;
    const hit = this.tracker.update(this.d.getCursor(), this.d.getDisplays(), this.d.now());
    if (!hit) return;
    this.menuOpen = true;
    this.d.openMenu(hit.display);
  }

  /** The menu window closed by itself (lost focus, Esc): the corner must be re-entered to open it again. */
  menuClosed(): void {
    this.menuOpen = false;
    this.tracker.reset();
  }

  async choose(action: MenuAction): Promise<void> {
    const hostId = this.active;
    this.menuOpen = false;
    this.tracker.reset();
    this.d.closeMenu();
    if (action === 'dismiss' || hostId === null) return;
    await this.d.stopStream(hostId);
    if (action === 'close' || action === 'settings') {
      this.d.showMainWindow();
      return;
    }
    // reconnect: the old Moonlight must be gone before a new one can start (startStream refuses a second stream per host).
    const deadline = this.d.now() + this.cfg.stopWaitMs;
    while (this.active !== null && this.d.now() < deadline) await this.d.sleep(this.cfg.pollMs);
    if (this.active !== null) {
      this.d.showMainWindow();
      return;
    }
    await this.d.startStream(hostId);
  }
}
