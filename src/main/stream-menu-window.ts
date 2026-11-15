// Electron glue for the in-stream menu: one small always-on-top window above the stream. Logic lives in core/client/stream-menu.ts.
import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import { SECURITY } from '../contracts.js';
import type { Rect } from '../core/client/hot-corner.js';
import { parseMenuAction } from '../core/client/stream-menu.js';
import type { MenuAction } from '../core/client/stream-menu.js';

const WIDTH = 380;
const HEIGHT = 330;

export interface StreamMenuWindowOptions {
  rendererDir: string;
  preload: string;
  onChoose(action: MenuAction): void;
  /** The window went away on its own (clicked elsewhere, Esc) or after close(). */
  onClosed(): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface StreamMenuWindow {
  open(display: Rect): void;
  close(): void;
}

export function createStreamMenuWindow(o: StreamMenuWindowOptions): StreamMenuWindow {
  let win: BrowserWindow | null = null;

  // Only the menu window itself may send an action; the main window and everything else is ignored.
  ipcMain.on('stream-menu:choose', (event, raw: unknown) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      o.warn('stream-menu:choose from an unexpected sender');
      return;
    }
    const action = parseMenuAction(raw);
    if (!action) {
      o.warn('stream-menu:choose with an unknown action');
      return;
    }
    o.onChoose(action);
  });

  return {
    open(display) {
      if (win && !win.isDestroyed()) return;
      const w = new BrowserWindow({
        x: Math.round(display.x + (display.width - WIDTH) / 2),
        y: Math.round(display.y + (display.height - HEIGHT) / 2),
        width: WIDTH,
        height: HEIGHT,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#1a1f28',
        title: 'LanPlay menu',
        webPreferences: { ...SECURITY.webPreferences, preload: o.preload },
      });
      win = w;
      // Above a borderless/fullscreen Moonlight window (Windows: topmost "screen-saver" level; macOS: also over full-screen spaces).
      w.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform === 'darwin') w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      let focused = false;
      w.once('ready-to-show', () => {
        w.show();
        w.focus();
      });
      w.on('focus', () => {
        focused = true;
      });
      // Clicking back into the stream (or anywhere else) is "keep playing". Ignore the blur of a window that never got focus.
      w.on('blur', () => {
        if (focused && !w.isDestroyed()) w.close();
      });
      w.on('closed', () => {
        if (win === w) win = null;
        o.onClosed();
      });
      void w.loadFile(path.join(o.rendererDir, 'stream-menu.html'));
    },
    close() {
      if (win && !win.isDestroyed()) win.close();
    },
  };
}
