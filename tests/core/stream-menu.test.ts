import { describe, expect, it, vi } from 'vitest';
import { MENU_ACTIONS, parseMenuAction, StreamMenuController } from '../../src/core/client/stream-menu.js';
import type { StreamMenuDeps } from '../../src/core/client/stream-menu.js';
import type { Rect } from '../../src/core/client/hot-corner.js';
import type { StreamState } from '../../src/contracts.js';

const D1: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

function setup(over: Partial<StreamMenuDeps> = {}) {
  let now = 0;
  let cursor = { x: 960, y: 540 };
  const calls: string[] = [];
  const deps: StreamMenuDeps = {
    getCursor: () => cursor,
    getDisplays: () => [D1],
    now: () => now,
    openMenu: (d) => calls.push(`open:${d.width}x${d.height}`),
    closeMenu: () => calls.push('closeMenu'),
    stopStream: async (id) => {
      calls.push(`stop:${id}`);
      // the real service reports 'ended' through the state callback once Moonlight exits
      c.onStreamState({ hostId: id, state: 'ended', exitCode: 0 });
    },
    startStream: async (id) => {
      calls.push(`start:${id}`);
      c.onStreamState({ hostId: id, state: 'running' });
    },
    showMainWindow: () => calls.push('showMain'),
    sleep: async () => {
      now += 50;
    },
    ...over,
  };
  const c = new StreamMenuController(deps, { marginPx: 4, dwellMs: 500, pollMs: 50 });
  const running: StreamState = { hostId: 'h1', state: 'running' };
  return {
    c,
    calls,
    running,
    move: (x: number, y: number) => {
      cursor = { x, y };
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('parseMenuAction', () => {
  it('accepts only the known actions', () => {
    for (const a of MENU_ACTIONS) expect(parseMenuAction(a)).toBe(a);
    expect(parseMenuAction('rm -rf')).toBeNull();
    expect(parseMenuAction(undefined)).toBeNull();
    expect(parseMenuAction({ a: 1 })).toBeNull();
  });
});

describe('StreamMenuController', () => {
  it('opens the menu after the cursor rests in a corner while streaming', () => {
    const s = setup();
    s.c.onStreamState(s.running);
    s.move(1919, 0);
    s.c.tick();
    s.advance(500);
    s.c.tick();
    expect(s.calls).toEqual(['open:1920x1080']);
    s.advance(600);
    s.c.tick(); // menu is open: no second window
    expect(s.calls).toEqual(['open:1920x1080']);
  });

  it('does nothing when no stream is running', () => {
    const s = setup();
    s.move(0, 0);
    s.c.tick();
    s.advance(900);
    s.c.tick();
    expect(s.calls).toEqual([]);
  });

  it('closes the menu and forgets the host when the stream ends', () => {
    const s = setup();
    s.c.onStreamState(s.running);
    s.move(0, 0);
    s.c.tick();
    s.advance(500);
    s.c.tick();
    s.c.onStreamState({ hostId: 'h1', state: 'ended', exitCode: 0 });
    expect(s.calls).toEqual(['open:1920x1080', 'closeMenu']);
    expect(s.c.activeHostId()).toBeNull();
  });

  it('dismiss only closes the menu; the stream keeps running', async () => {
    const s = setup();
    s.c.onStreamState(s.running);
    await s.c.choose('dismiss');
    expect(s.calls).toEqual(['closeMenu']);
    expect(s.c.activeHostId()).toBe('h1');
  });

  it('close stops the stream and brings the app window back', async () => {
    const s = setup();
    s.c.onStreamState(s.running);
    await s.c.choose('close');
    expect(s.calls).toEqual(['closeMenu', 'stop:h1', 'showMain']);
  });

  it('settings stops the stream and shows the app window to change them', async () => {
    const s = setup();
    s.c.onStreamState(s.running);
    await s.c.choose('settings');
    expect(s.calls).toEqual(['closeMenu', 'stop:h1', 'showMain']);
  });

  it('reconnect stops, waits until the old stream is gone, then starts the same host again', async () => {
    const s = setup();
    s.c.onStreamState(s.running);
    await s.c.choose('reconnect');
    expect(s.calls).toEqual(['closeMenu', 'stop:h1', 'start:h1']);
    expect(s.c.activeHostId()).toBe('h1');
  });

  it('reconnect waits for a slow stop and gives up (no start) if the old stream never ends', async () => {
    const stopStream = vi.fn(async () => {});
    const startStream = vi.fn(async () => {});
    const s = setup({ stopStream, startStream });
    s.c.onStreamState(s.running);
    await s.c.choose('reconnect');
    expect(stopStream).toHaveBeenCalledOnce();
    expect(startStream).not.toHaveBeenCalled();
    expect(s.calls).toContain('showMain');
  });

  it('actions with no active stream are harmless', async () => {
    const s = setup();
    await s.c.choose('reconnect');
    await s.c.choose('close');
    expect(s.calls).toEqual(['closeMenu', 'closeMenu']);
  });

  it('menuClosed() re-arms the corner (cursor must dwell again)', () => {
    const s = setup();
    s.c.onStreamState(s.running);
    s.move(0, 0);
    s.c.tick();
    s.advance(500);
    s.c.tick();
    s.c.menuClosed();
    s.c.tick();
    expect(s.calls).toEqual(['open:1920x1080']);
    s.advance(500);
    s.c.tick();
    expect(s.calls).toEqual(['open:1920x1080', 'open:1920x1080']);
  });
});
