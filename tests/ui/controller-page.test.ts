// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUTTON_NAMES, CURVES, LIMITS, SHAPES, defaultLayout, defaultStore, sanitizeStore, type LayoutStore } from '../../src/core/controller/layout.js';
import { BTN, MAX_NAME_CHARS, parseClientMessage, sanitizePlayerName, type PadState } from '../../src/core/controller/protocol.js';

const ROOT = join(__dirname, '..', '..');
const UI_DIR = join(ROOT, 'src', 'controller-ui');
const read = (f: string): string => readFileSync(join(UI_DIR, f), 'utf8');

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Any = any;
const g = globalThis as Any;

// ---- Loading the page script ------------------------------------------------------------------------------------------

/** Compile controller.ts exactly like `tsc -p tsconfig.json` does and return the emitted classic script. */
function compileController(): string {
  const cfg = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  const program = ts.createProgram([join(UI_DIR, 'controller.ts')], { ...parsed.options, noEmit: false, sourceMap: false, outDir: join(ROOT, '.tmp-ui-out') });
  let text = '';
  program.emit(undefined, (fileName, out) => {
    if (fileName.endsWith('controller.js')) text = out;
  });
  if (!text) throw new Error('controller.ts did not compile');
  return text;
}

let script = '';
let T: Any; // the test hook: pure functions and boot()

beforeAll(() => {
  script = compileController();
  g.__LANPLAY_TEST__ = T = {};
  (0, eval)(script);
  expect(typeof T.boot).toBe('function');
});

// ---- Fakes -------------------------------------------------------------------------------------------------------------

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(s: string): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(s);
  }
  close(): void {
    this.closed = true;
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(o: unknown): void {
    this.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Parsed frames that went out; fails if the host's own parser would reject one. */
  frames(): Array<{ t: string } & Record<string, unknown>> {
    return this.sent.map((s) => {
      expect(parseClientMessage(s), s).not.toBeNull();
      return JSON.parse(s) as { t: string } & Record<string, unknown>;
    });
  }
  states(): PadState[] {
    return this.sent.flatMap((s) => {
      const m = parseClientMessage(s);
      return m && m.t === 's' ? [m.pad] : [];
    });
  }
  count(t: string): number {
    return this.frames().filter((f) => f.t === t).length;
  }
}

/** The host's HTTP API as the page sees it. */
interface FakeHost {
  store: LayoutStore;
  getStatus: number;
  putFail: number;
  calls: Array<{ method: string; path: string; token: string | null; body?: LayoutStore }>;
  lastPut(): LayoutStore;
}
let host: FakeHost;

function installFetch(): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://192.168.1.20:47921');
    const method = init?.method ?? 'GET';
    const call: FakeHost['calls'][number] = { method, path: u.pathname, token: u.searchParams.get('t') };
    host.calls.push(call);
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (u.pathname === '/api/layouts' && method === 'GET') return host.getStatus === 200 ? reply(200, host.store) : reply(host.getStatus, 'nope');
    if (u.pathname === '/api/default-layout') return reply(200, defaultLayout());
    if (u.pathname === '/api/layouts' && method === 'PUT') {
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      call.body = JSON.parse(String(init?.body)) as LayoutStore;
      if (host.putFail > 0) {
        host.putFail--;
        return reply(500, 'boom');
      }
      host.store = sanitizeStore(call.body);
      return reply(200, host.store);
    }
    return reply(404, 'nope');
  });
}

let rafQueue: Array<(ts: number) => void> = [];
/** Run the queued animation-frame callbacks at timestamp `ts` (callbacks queued while running wait for the next frame). */
function frame(ts: number): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(ts);
}
let clock = 1000;
/** A frame far enough after the previous one to pass the 60/s throttle. */
const tick = (): void => frame((clock += 20));

let portraitNow = false;
let mqListeners = new Set<() => void>();
function setPortrait(v: boolean): void {
  portraitNow = v;
  for (const cb of [...mqListeners]) cb();
}
let visibility: 'visible' | 'hidden' = 'visible';

const BODY = /<body>([\s\S]*)<\/body>/.exec(read('index.html'))?.[1] ?? '';
const SOCKET_URL = (token: string): string => 'ws://192.168.1.20:47921/ws?t=' + encodeURIComponent(token);
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

function rect(el: Element, left: number, top: number, width: number, height: number): void {
  (el as Any).getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
}

interface Harness {
  ws(i?: number): FakeSocket;
  q<T extends HTMLElement = HTMLElement>(sel: string): T;
  ctl(id: string): HTMLElement;
  destroy(): void;
}

/** Fresh page: the real index.html body, the URL the host hands out, the host API, and every browser API the script touches. */
async function mount(opts: { token?: string | null; welcome?: boolean } = {}): Promise<Harness> {
  document.body.innerHTML = BODY;
  const token = opts.token === undefined ? 'tok-123' : opts.token;
  g.happyDOM.setURL('http://192.168.1.20:47921/' + (token === null ? '' : '?t=' + encodeURIComponent(token)));
  rect(document.getElementById('field') as Element, 0, 0, 800, 400);
  const booted = T.boot() as { destroy(): void };
  const h: Harness = {
    ws: (i = FakeSocket.all.length - 1) => {
      const s = FakeSocket.all[i];
      if (!s) throw new Error('no socket #' + i);
      return s;
    },
    q: <E extends HTMLElement>(sel: string) => {
      const el = document.querySelector<E>(sel);
      if (!el) throw new Error('missing ' + sel);
      return el;
    },
    ctl: (id) => h.q(`[data-cid="${id}"]`),
    destroy: () => booted.destroy(),
  };
  if (opts.welcome !== false && token !== null) {
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 2 });
  }
  await settle();
  return h;
}

function ptr(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerleave', id: number, x = 0, y = 0): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
}

const status = (): string => document.getElementById('status')?.textContent ?? '';
const noticeVisible = (): boolean => !(document.getElementById('notice') as HTMLElement).hidden;
const saveText = (): string => document.getElementById('panel-save')?.textContent ?? '';

let h: Harness;
let storage: Map<string, string>;

beforeEach(() => {
  FakeSocket.all = [];
  rafQueue = [];
  clock = 1000;
  portraitNow = false;
  mqListeners = new Set();
  visibility = 'visible';
  storage = new Map();
  host = { store: defaultStore(), getStatus: 200, putFail: 0, calls: [], lastPut: () => host.calls.filter((c) => c.method === 'PUT').at(-1)?.body as LayoutStore };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  installFetch();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => rafQueue.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafQueue = [];
  });
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return portraitNow;
    },
    addEventListener: (_t: string, cb: () => void) => mqListeners.add(cb),
    removeEventListener: (_t: string, cb: () => void) => mqListeners.delete(cb),
  }));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  h?.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as Any).visibilityState;
  for (const k of ['vibrate', 'wakeLock']) delete (navigator as Any)[k];
  delete (document as Any).fullscreenEnabled;
  delete (document as Any).fullscreenElement;
  delete (document.documentElement as Any).requestFullscreen;
  delete (screen as Any).orientation;
  document.body.innerHTML = '';
  document.body.className = '';
});

/** A store whose active layout has these properties patched onto one control. */
function withPatch(id: string, patch: Record<string, unknown>): LayoutStore {
  return T.patchControl(defaultStore(), id, patch) as LayoutStore;
}
const fixedPoint = (s: LayoutStore): void => expect(sanitizeStore(s)).toEqual(s);

// ---- Static page checks ------------------------------------------------------------------------------------------------

describe('index.html, controller.css and the emitted script', () => {
  const html = read('index.html');

  it('has the CSP, viewport and links the task requires, and no inline script, style or handlers', () => {
    expect(/Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
    );
    const viewport = /name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(viewport).toMatch(/viewport-fit=cover/);
    expect(viewport).toMatch(/user-scalable=no/);
    expect(html).toMatch(/name="theme-color"/);
    expect(html).toMatch(/<link rel="stylesheet" href="controller\.css">/);
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script src="controller.js" defer>']);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+\s*=|https?:\/\//i);
  });

  it('is an empty field plus the strip, the editor shell and the overlays; every shell button is named', () => {
    document.body.innerHTML = BODY;
    expect(document.getElementById('field')?.children).toHaveLength(0);
    for (const id of ['strip', 'status', 'layout-pick', 'fullscreen', 'edit', 'panel', 'done', 'undo', 'collapse', 'panel-content', 'hint', 'notice', 'retry', 'rotate']) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
    // the save-status button is hidden and empty until there is something to say
    for (const el of document.querySelectorAll('button:not([hidden])')) expect(el.getAttribute('aria-label') ?? el.textContent?.trim(), el.outerHTML).toBeTruthy();
    for (const el of document.querySelectorAll('button[hidden]')) expect(el.id === 'panel-save' || el.getAttribute('aria-label') || el.textContent?.trim(), el.outerHTML).toBeTruthy();
    expect(html).not.toMatch(/guide/i);
  });

  it('css is local only, locks touch handling and respects reduced motion', () => {
    const css = read('controller.css');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/touch-action:\s*none/);
    expect(css).toMatch(/user-select:\s*none/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/orientation:\s*portrait/);
    expect(css).toMatch(/:focus-visible/);
  });

  it('emits a classic script: no module syntax, no top-level declarations, no late runtime APIs', () => {
    expect(script).not.toMatch(/^\s*(import|export)\s/m);
    expect(script).not.toMatch(/^await /m);
    expect(script).not.toMatch(/\.(findLast|findLastIndex|toSorted|toReversed|toSpliced|with|at|replaceAll|groupBy)\(/);
    expect(script).not.toMatch(/\b(structuredClone|Object\.hasOwn|AbortSignal\.any)\b/);
    const body = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^"use strict";\s*/, '');
    expect(body.trimStart().startsWith('(() => {')).toBe(true);
  });

  it('never logs and never stores layouts on the phone', () => {
    const src = read('controller.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/console\./);
    expect([...src.matchAll(/localStorage/g)]).toHaveLength(2); // the name digits and the hint flag only, through two wrappers
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
  });
});

// ---- Mirrors of the host schema ----------------------------------------------------------------------------------------

describe('mirror of layout.ts and protocol.ts', () => {
  it('has the same limits, names, curves and shapes', () => {
    expect(T.LIMITS).toEqual(LIMITS);
    expect(T.BUTTON_NAMES).toEqual([...BUTTON_NAMES]);
    expect(T.CURVES).toEqual([...CURVES]);
    expect(T.SHAPES).toEqual([...SHAPES]);
  });
  it('has the XUSB bits and leaves the Guide bit alone', () => {
    expect(T.BTN).toEqual({
      UP: BTN.DPAD_UP,
      DOWN: BTN.DPAD_DOWN,
      LEFT: BTN.DPAD_LEFT,
      RIGHT: BTN.DPAD_RIGHT,
      START: BTN.START,
      BACK: BTN.BACK,
      L3: BTN.LEFT_THUMB,
      R3: BTN.RIGHT_THUMB,
      LB: BTN.LEFT_SHOULDER,
      RB: BTN.RIGHT_SHOULDER,
      A: BTN.A,
      B: BTN.B,
      X: BTN.X,
      Y: BTN.Y,
    });
    expect(Object.values(T.BTN as Record<string, number>).includes(BTN.GUIDE)).toBe(false);
  });
});

// ---- Pure: layout store operations -------------------------------------------------------------------------------------

describe('coerceStore', () => {
  it('accepts the host default unchanged', () => {
    expect(T.coerceStore(defaultStore())).toEqual(defaultStore());
  });
  it('rejects what has no usable layout and repairs what is merely sloppy', () => {
    for (const bad of [null, 5, 'x', [], {}, { layouts: [] }, { layouts: [{}] }, { layouts: [{ controls: 'no' }] }]) expect(T.coerceStore(bad), JSON.stringify(bad)).toBeNull();
    const s = T.coerceStore({ activeId: 'zzz', layouts: [{ id: 'a b', controls: [{ type: 'button', button: 'A', x: 500, w: -3 }, { type: 'nope' }, 7, { type: 'button', button: 'Z' }, { type: 'dpad', id: 'dpad', size: 'big' }] }] });
    expect(s.activeId).toBe('a-b');
    expect(s.layouts[0].name).toBe('Layout 1');
    expect(s.layouts[0].controls).toHaveLength(2);
    expect(s.layouts[0].controls[0]).toMatchObject({ type: 'button', button: 'A', x: 100, w: LIMITS.size.min });
    expect(s.layouts[0].controls[1]).toMatchObject({ type: 'dpad', size: 26 });
  });
});

describe('layout operations', () => {
  const base = (): LayoutStore => defaultStore();
  const ctrl = (s: LayoutStore, id: string): Any => T.activeLayout(s).controls.find((c: { id: string }) => c.id === id);

  it('every result is a fixed point of the host sanitizer', () => {
    let s = base();
    const steps: Array<(s: LayoutStore) => LayoutStore> = [
      (x) => T.newBlankLayout(x),
      (x) => T.addControl(x, 'stick').store,
      (x) => T.addControl(x, 'dpad').store,
      (x) => T.addControl(x, 'START').store,
      (x) => T.addControl(x, 'LT').store,
      (x) => T.duplicateLayout(x, x.activeId),
      (x) => T.renameLayout(x, x.activeId, '  My layout  '),
      (x) => T.newLayoutFrom(x, defaultLayout()),
      (x) => T.moveControl(x, 'btn-a', 12.3456, 98.7654),
      (x) => T.resizeControl(x, 'btn-a', { w: 33.333, h: 9.999 }),
      (x) => T.patchControl(x, 'stick-left', { deadzone: 0.123456, sensitivity: 2.34567, curve: 'precise', mode: 'floating', opacity: 0.555 }),
      (x) => T.patchControl(x, 'btn-lt', { value: 100.6, label: 'Fire!', turbo: true }),
      (x) => T.setHaptics(x, x.activeId, false),
      (x) => T.duplicateControl(x, 'btn-a').store,
      (x) => T.deleteControl(x, 'btn-b'),
      (x) => T.resetLayout(x, x.activeId, defaultLayout()),
    ];
    for (const step of steps) {
      s = step(s);
      fixedPoint(s);
    }
  });

  it('is immutable and returns the same store for no-ops', () => {
    const s = base();
    const snapshot = JSON.stringify(s);
    T.moveControl(s, 'btn-a', 1, 1);
    T.patchControl(s, 'btn-a', { w: 20 });
    T.deleteControl(s, 'btn-a');
    T.newBlankLayout(s);
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(T.moveControl(s, 'nope', 1, 1)).toBe(s);
    expect(T.patchControl(s, 'btn-a', { w: 14 })).toBe(s);
    expect(T.patchControl(s, 'btn-a', { bogus: 1, w: 'wide' })).toBe(s);
    expect(T.deleteControl(s, 'nope')).toBe(s);
    expect(T.renameLayout(s, s.activeId, '   ')).toBe(s);
    expect(T.switchLayout(s, s.activeId)).toBe(s);
    expect(T.switchLayout(s, 'missing')).toBe(s);
  });

  it('adds any button, stick or d-pad with unique ids, and respects the control limit', () => {
    let s = base();
    for (const name of LIMITS.controls ? BUTTON_NAMES : []) {
      const r = T.addControl(s, name);
      expect(r.id).toMatch(/^btn-/);
      s = r.store;
    }
    const ids = T.activeLayout(s).controls.map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ctrl(s, 'btn-a-2')).toMatchObject({ type: 'button', button: 'A' });
    const stick = T.addControl(base(), 'stick');
    expect(ctrl(stick.store, stick.id)).toMatchObject({ type: 'stick', stick: 'right' }); // a left one exists already
    s = base();
    while (T.activeLayout(s).controls.length < LIMITS.controls) s = T.addControl(s, 'A').store;
    expect(T.canAddControl(s)).toBe(false);
    const full = T.addControl(s, 'B');
    expect(full.id).toBeNull();
    expect(full.store).toBe(s);
    expect(T.duplicateControl(s, 'btn-a').id).toBeNull();
  });

  it('moves and resizes inside the screen', () => {
    const s = T.moveControl(base(), 'btn-a', -50, 500, 2);
    const a = ctrl(s, 'btn-a');
    const [hx, hy] = T.halfExtent(a, 2) as [number, number];
    expect(a.x).toBeCloseTo(hx, 1);
    expect(a.y).toBeCloseTo(100 - hy, 1);
    const big = ctrl(T.resizeControl(base(), 'btn-a', { w: 5000, h: 1 }), 'btn-a');
    expect(big.w).toBe(LIMITS.size.max);
    expect(big.h).toBe(LIMITS.size.min);
    expect(big.x).toBeGreaterThan(0);
    expect(ctrl(T.resizeControl(base(), 'stick-left', { size: 1000 }), 'stick-left').size).toBe(LIMITS.size.max);
    expect(T.moveControl(base(), 'btn-a', Number.NaN, 5)).toStrictEqual(base());
  });

  it('turns a resize-handle position into dimensions', () => {
    const a = ctrl(base(), 'btn-a');
    expect(T.sizeFromHandle(a, 20, 10)).toEqual({ w: 20, h: 20 }); // circles stay round
    expect(T.sizeFromHandle(ctrl(base(), 'btn-lt'), 20, 10)).toEqual({ w: 20, h: 10 });
    expect(T.sizeFromHandle(ctrl(base(), 'dpad'), 20, 30)).toEqual({ size: 30 });
    const floating = ctrl(withPatch('stick-left', { mode: 'floating' }), 'stick-left');
    expect(T.sizeFromHandle(floating, 60, 30)).toEqual({ size: 60 / T.FLOATING_ZONE });
  });

  it('duplicates and deletes controls', () => {
    const r = T.duplicateControl(base(), 'btn-a');
    expect(r.id).toBe('btn-a-2');
    expect(ctrl(r.store, 'btn-a-2')).toMatchObject({ button: 'A', x: ctrl(r.store, 'btn-a').x + 4 });
    expect(T.activeLayout(T.deleteControl(r.store, 'btn-a-2')).controls).toHaveLength(T.activeLayout(base()).controls.length);
  });

  it('validates and clamps every property', () => {
    const s = T.patchControl(base(), 'stick-left', { size: 0, deadzone: 9, sensitivity: 0, curve: 'x', mode: 'floating', invertX: true, invertY: 'yes', doubleTapClick: false, opacity: 5 });
    expect(ctrl(s, 'stick-left')).toMatchObject({ size: LIMITS.size.min, deadzone: LIMITS.deadzone.max, sensitivity: LIMITS.sensitivity.min, curve: 'linear', mode: 'floating', invertX: true, invertY: false, doubleTapClick: false, opacity: 1 });
    const b = ctrl(T.patchControl(base(), 'btn-lt', { value: 9999, shape: 'pill', latch: true, label: ' way too long label ' }), 'btn-lt');
    expect(b).toMatchObject({ value: 255, shape: 'pill', latch: true, label: 'way to' });
    expect(ctrl(T.patchControl(base(), 'btn-lt', { value: -4 }), 'btn-lt').value).toBe(1);
    expect(ctrl(T.patchControl(base(), 'dpad', { diagonals: false }), 'dpad').diagonals).toBe(false);
  });

  it('renames the label with the button while the label is still the default', () => {
    expect(ctrl(T.patchControl(base(), 'btn-a', { button: 'B' }), 'btn-a')).toMatchObject({ button: 'B', label: 'B' });
    expect(ctrl(T.patchControl(base(), 'btn-start', { button: 'BACK' }), 'btn-start').label).toBe('Back');
    const custom = T.patchControl(T.patchControl(base(), 'btn-a', { label: 'Jump' }), 'btn-a', { button: 'X' });
    expect(ctrl(custom, 'btn-a').label).toBe('Jump');
  });

  it('manages presets: new, new from default, duplicate, rename, delete (never the last), switch, cycle, reset', () => {
    let s = base();
    s = T.newBlankLayout(s);
    expect(s.layouts).toHaveLength(2);
    expect(s.activeId).toBe(s.layouts[1]?.id);
    expect(T.activeLayout(s).controls).toHaveLength(0);
    s = T.newLayoutFrom(s, defaultLayout());
    expect(s.layouts.map((l: { name: string }) => l.name)).toEqual(['Xbox', 'Layout 2', 'Xbox 2']);
    expect(T.activeLayout(s).controls).toHaveLength(13);
    s = T.renameLayout(s, s.activeId, 'x'.repeat(100));
    expect(T.activeLayout(s).name).toHaveLength(LIMITS.nameChars);
    s = T.duplicateLayout(s, s.activeId);
    expect(s.layouts).toHaveLength(4);
    expect(new Set(s.layouts.map((l: { id: string }) => l.id)).size).toBe(4);
    const first = s.layouts[0]?.id;
    expect(T.switchLayout(s, first).activeId).toBe(first);
    expect(T.cycleLayout(T.switchLayout(s, first), -1).activeId).toBe(s.layouts[3]?.id);
    expect(T.cycleLayout(T.switchLayout(s, first), 1).activeId).toBe(s.layouts[1]?.id);
    const gone = T.deleteLayout(s, s.activeId);
    expect(gone.layouts).toHaveLength(3);
    expect(gone.layouts.some((l: { id: string }) => l.id === gone.activeId)).toBe(true);
    let one = s;
    while (one.layouts.length > 1) one = T.deleteLayout(one, one.layouts[0]?.id);
    expect(T.deleteLayout(one, one.activeId)).toBe(one);
    const edited = T.deleteControl(base(), 'btn-a');
    const reset = T.resetLayout(edited, edited.activeId, defaultLayout());
    expect(T.activeLayout(reset).controls).toHaveLength(13);
    expect(T.activeLayout(reset).id).toBe('default');
    fixedPoint(s);
  });

  it('respects the layout limit and the name length', () => {
    let s = base();
    while (s.layouts.length < LIMITS.layouts) s = T.newBlankLayout(s);
    expect(T.newBlankLayout(s)).toBe(s);
    expect(T.duplicateLayout(s, s.activeId)).toBe(s);
    expect(T.newLayoutFrom(s, defaultLayout())).toBe(s);
    fixedPoint(s);
  });
});

describe('undo history', () => {
  it('records one step per gesture, keeps 20, and walks back', () => {
    let hist = T.emptyHistory();
    const stores = Array.from({ length: 30 }, (_, i) => ({ version: 1, activeId: 'a', layouts: [{ id: 'a', name: String(i), haptics: true, controls: [] }] }));
    for (let i = 1; i < 30; i++) hist = T.recordEdit(hist, stores[i - 1], null);
    expect(hist.past).toHaveLength(T.UNDO_STEPS);
    // a drag: many edits, one step
    let h2 = T.emptyHistory();
    h2 = T.recordEdit(h2, stores[0], 'move:a');
    h2 = T.recordEdit(h2, stores[1], 'move:a');
    h2 = T.recordEdit(h2, stores[2], 'move:a');
    expect(h2.past).toEqual([stores[0]]);
    h2 = T.endGesture(h2);
    h2 = T.recordEdit(h2, stores[3], 'move:a');
    expect(h2.past).toEqual([stores[0], stores[3]]);
    const u = T.undo(h2);
    expect(u.store).toBe(stores[3]);
    expect(T.undo(u.history).store).toBe(stores[0]);
    expect(T.undo(T.undo(u.history).history)).toBeNull();
  });
});

// ---- Pure: pad maths ---------------------------------------------------------------------------------------------------

describe('stickAxes', () => {
  const R = 50;
  const P = (o: Record<string, unknown> = {}) => ({ deadzone: 0.1, sensitivity: 1, curve: 'linear', invertX: false, invertY: false, ...o });

  it('is neutral inside the dead zone and for degenerate input', () => {
    expect(T.stickAxes(0, 0, R, P())).toEqual({ x: 0, y: 0 });
    expect(T.stickAxes(R * 0.09, 0, R, P())).toEqual({ x: 0, y: 0 });
    expect(T.stickAxes(10, 10, 0, P())).toEqual({ x: 0, y: 0 });
    expect(T.stickAxes(Number.NaN, 5, R, P())).toEqual({ x: 0, y: 0 });
  });

  it('reaches +-32767 and sends a screen-up drag as positive y', () => {
    expect(T.stickAxes(R, 0, R, P())).toEqual({ x: 32767, y: 0 });
    expect(T.stickAxes(-R, 0, R, P())).toEqual({ x: -32767, y: 0 });
    expect(T.stickAxes(0, -R, R, P())).toEqual({ x: 0, y: 32767 });
    expect(T.stickAxes(0, R, R, P())).toEqual({ x: 0, y: -32767 });
    expect(T.stickAxes(R * 9, 0, R, P())).toEqual({ x: 32767, y: 0 }); // r is capped at 1
  });

  it('rescales after the dead zone: m = (r - dz) / (1 - dz)', () => {
    const dz = 0.2;
    const half = T.stickAxes(R * (dz + (1 - dz) / 2), 0, R, P({ deadzone: dz }));
    expect(half.x).toBe(Math.round(0.5 * 32767));
    expect(T.stickAxes(R * (dz - 0.01), 0, R, P({ deadzone: dz })).x).toBe(0);
    expect(T.stickAxes(R * (dz + 0.01), 0, R, P({ deadzone: dz })).x).toBeGreaterThan(0);
  });

  it('applies the response curves to m', () => {
    const at = (curve: string) => T.stickAxes(R / 2, 0, R, P({ deadzone: 0, curve })).x as number;
    expect(at('linear')).toBe(Math.round(0.5 * 32767));
    expect(at('precise')).toBe(Math.round(0.25 * 32767));
    expect(at('aggressive')).toBe(Math.round(Math.sqrt(0.5) * 32767));
  });

  it('scales by sensitivity and caps m at 1', () => {
    expect(T.stickAxes(R / 4, 0, R, P({ deadzone: 0, sensitivity: 2 })).x).toBe(Math.round(0.5 * 32767));
    expect(T.stickAxes(R / 2, 0, R, P({ deadzone: 0, sensitivity: 3 })).x).toBe(32767);
    expect(T.stickAxes(R / 2, 0, R, P({ deadzone: 0, sensitivity: 0.5 })).x).toBe(Math.round(0.25 * 32767));
  });

  it('inverts x and y independently (y: up is positive before inversion)', () => {
    expect(T.stickAxes(R, -R, R, P({ deadzone: 0, invertX: true }))).toMatchObject({ x: -23170, y: 23170 });
    expect(T.stickAxes(0, -R, R, P({ invertY: true }))).toEqual({ x: 0, y: -32767 });
    expect(T.stickAxes(0, R, R, P({ invertY: true }))).toEqual({ x: 0, y: 32767 });
  });

  it('never returns negative zero and stays inside the wire range', () => {
    for (let a = 0; a < 360; a += 15) {
      const v = T.stickAxes(Math.cos((a * Math.PI) / 180) * R, Math.sin((a * Math.PI) / 180) * R, R, P({ deadzone: 0 })) as { x: number; y: number };
      expect(Object.is(v.x, -0) || Object.is(v.y, -0)).toBe(false);
      expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(32767 + 1);
    }
  });
});

describe('dpadMask', () => {
  const half = 75;
  const at = (deg: number, diagonals = true, r = 60): number => T.dpadMask(Math.cos((deg * Math.PI) / 180) * r, -Math.sin((deg * Math.PI) / 180) * r, half, diagonals);
  const [UP, DOWN, LEFT, RIGHT] = [BTN.DPAD_UP, BTN.DPAD_DOWN, BTN.DPAD_LEFT, BTN.DPAD_RIGHT];
  it('has a dead centre and eight directions', () => {
    expect(T.dpadMask(0, 0, half)).toBe(0);
    expect(T.dpadMask(5, -5, half)).toBe(0);
    expect([at(0), at(90), at(180), at(270)]).toEqual([RIGHT, UP, LEFT, DOWN]);
    expect([at(45), at(135), at(225), at(315)]).toEqual([UP | RIGHT, UP | LEFT, DOWN | LEFT, DOWN | RIGHT]);
  });
  it('gives cardinals 60 degrees and diagonals 30', () => {
    expect([at(25), at(-25), at(65), at(115)]).toEqual([RIGHT, RIGHT, UP, UP]);
    expect([at(35), at(55)]).toEqual([UP | RIGHT, UP | RIGHT]);
  });
  it('without diagonals it is strictly four-way', () => {
    for (let deg = 0; deg < 360; deg += 5) {
      const m = at(deg, false);
      expect([UP, DOWN, LEFT, RIGHT]).toContain(m);
    }
    expect(at(40, false)).toBe(RIGHT);
    expect(at(50, false)).toBe(UP);
    expect(at(225, false)).toBe(LEFT);
  });
  it('never reports opposite directions together and keeps the direction far outside', () => {
    for (let deg = 0; deg < 360; deg += 3) {
      const m = at(deg, true, 500);
      expect((m & UP && m & DOWN) || (m & LEFT && m & RIGHT)).toBeFalsy();
      expect(m).not.toBe(0);
    }
  });
});

describe('buildPad, samePad, latching, double tap', () => {
  const z = { x: 0, y: 0 };
  it('ORs button bits and sends the configured trigger value (largest wins)', () => {
    const pad = T.buildPad(
      [{ button: 'A', value: 255 }, { button: 'LB', value: 255 }, { button: 'LT', value: 100 }, { button: 'LT', value: 180 }, { button: 'RT', value: 7 }, { button: 'L3', value: 255 }],
      BTN.DPAD_LEFT,
      { x: -5, y: 9 },
      z,
    );
    expect(pad).toEqual({ b: BTN.A | BTN.LEFT_SHOULDER | BTN.LEFT_THUMB | BTN.DPAD_LEFT, lt: 180, rt: 7, lx: -5, ly: 9, rx: 0, ry: 0 });
    expect(pad.b & BTN.GUIDE).toBe(0);
    expect(T.buttonMask(['A', 'LT', 'nope'], 0xffff)).toBe(BTN.A | BTN.DPAD_UP | BTN.DPAD_DOWN | BTN.DPAD_LEFT | BTN.DPAD_RIGHT);
  });
  it('compares every field', () => {
    const base = { b: 1, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
    expect(T.samePad(null, base)).toBe(false);
    expect(T.samePad({ ...base }, base)).toBe(true);
    for (const k of Object.keys(base)) expect(T.samePad({ ...base, [k]: 7 }, base), k).toBe(false);
  });
  it('latches presses that were already released', () => {
    const down = T.buildPad([{ button: 'A', value: 255 }, { button: 'RT', value: 200 }], 0, z, z);
    const up = T.buildPad([], 0, z, z);
    expect(T.coversPress(down, down)).toBe(true);
    expect(T.coversPress(up, down)).toBe(false);
    expect(T.coversPress(down, up)).toBe(true);
    expect(T.mergePress(T.buildPad([{ button: 'B', value: 255 }, { button: 'LT', value: 90 }], 0, z, z), down)).toMatchObject({ b: BTN.A | BTN.B, lt: 90, rt: 200 });
  });
  it('detects a double tap within 300 ms', () => {
    expect(T.isDoubleTap(null, 1000)).toBe(false);
    expect(T.isDoubleTap(1000, 1300)).toBe(true);
    expect(T.isDoubleTap(1000, 1301)).toBe(false);
    expect(T.isDoubleTap(1000, 900)).toBe(false);
  });
});

describe('protocol helpers', () => {
  it('backoffDelay doubles from 500 ms and caps at 5 s', () => {
    expect([0, 1, 2, 3, 4, 5, 50, 5000].map((n) => T.backoffDelay(n))).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);
    expect(T.backoffDelay(-3)).toBe(500);
  });
  it('names the device and survives the host-side sanitiser unchanged', () => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
    const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15';
    const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
    expect(T.deviceLabel(IPHONE, 5)).toBe('iPhone');
    expect(T.deviceLabel(MAC, 5)).toBe('iPad');
    expect(T.deviceLabel(MAC, 0)).toBe('Phone');
    expect(T.deviceLabel(PIXEL, 5)).toBe('Android phone');
    for (const ua of [IPHONE, MAC, PIXEL]) {
      const name = T.playerName(ua, 5, 47) as string;
      expect(name).toMatch(/^[A-Za-z ]+ \d{2}$/);
      expect(name.length).toBeLessThanOrEqual(MAX_NAME_CHARS);
      expect(sanitizePlayerName(name)).toBe(name);
    }
    expect(T.playerName(IPHONE, 5, 3)).toBe('iPhone 10');
  });
  it('builds the socket URL and parses host messages', () => {
    expect(T.wsUrl({ protocol: 'http:', host: '192.168.1.20:47921' }, 'abc')).toBe('ws://192.168.1.20:47921/ws?t=abc');
    expect(T.wsUrl({ protocol: 'https:', host: 'pc:1' }, 'a b&c')).toBe('wss://pc:1/ws?t=a%20b%26c');
    expect(T.parseServerMessage('{"t":"welcome","slot":3}')).toEqual({ t: 'welcome', slot: 3 });
    expect(T.parseServerMessage('{"t":"full"}')).toEqual({ t: 'full' });
    expect(T.parseServerMessage('{"t":"kicked"}')).toEqual({ t: 'kicked' });
    for (const bad of ['', 'nope', '[]', '{"t":"welcome","slot":0}', '{"t":"welcome","slot":2.5}', '{"t":"x"}', 5, null, 'x'.repeat(600)]) expect(T.parseServerMessage(bad)).toBeNull();
  });
  it('has the exact status and error strings', () => {
    expect(T.statusText('connecting', null)).toBe('Connecting…');
    expect(T.statusText('connected', 2)).toBe('Player 2');
    expect(T.statusText('retrying', null)).toBe('Disconnected — retrying…');
    expect(T.statusText('full', null)).toBe('All 4 player slots are taken');
    expect(T.statusText('kicked', null)).toBe('Removed from this PC');
    expect(T.statusText('notoken', null)).toBe('Open the link or QR code from the LanPlay host screen');
    for (const s of [0, 401, 403, 413, 429, 500]) expect(T.httpMessage(s).length).toBeGreaterThan(5);
  });
});

// ---- The running page: loading and play --------------------------------------------------------------------------------

describe('without a token', () => {
  it('shows the instruction, never opens a socket and never asks the host for layouts', async () => {
    h = await mount({ token: null });
    expect(FakeSocket.all).toHaveLength(0);
    expect(host.calls).toHaveLength(0);
    expect(status()).toBe('Open the link or QR code from the LanPlay host screen');
    expect(noticeVisible()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('loading the layout', () => {
  it('GETs /api/layouts with the token and draws exactly the active layout', async () => {
    h = await mount();
    expect(host.calls[0]).toMatchObject({ method: 'GET', path: '/api/layouts', token: 'tok-123' });
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(13);
    const a = h.ctl('btn-a');
    expect(a.style.left).toBe('85%');
    expect(a.style.top).toBe('76%');
    expect(a.style.getPropertyValue('--w')).toBe('14');
    expect(a.dataset['button']).toBe('A');
    expect(a.getAttribute('aria-label')).toBe('A button');
    expect(h.ctl('btn-start').textContent).toBe('Start');
    expect(h.ctl('stick-left').getAttribute('aria-label')).toBe('Left stick');
    expect(document.getElementById('layout-pick')?.hidden).toBe(true); // one layout: nothing to switch
  });

  it('draws the host-chosen active layout, not the first one', async () => {
    host.store = T.newBlankLayout(defaultStore()); // two layouts, the empty one active
    expect(host.store.layouts).toHaveLength(2);
    h = await mount();
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(0);
    expect(host.store.activeId).not.toBe('default');
  });

  it('a failed first GET shows "Cannot load your layout" with Retry and invents nothing', async () => {
    host.getStatus = 500;
    h = await mount();
    expect(noticeVisible()).toBe(true);
    expect(document.getElementById('notice-text')?.textContent).toBe('Cannot load your layout');
    expect((document.getElementById('retry') as HTMLElement).hidden).toBe(false);
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(0);
    expect((document.getElementById('edit') as HTMLElement).hidden).toBe(true);
    host.getStatus = 200;
    (document.getElementById('retry') as HTMLElement).click();
    await settle();
    expect(noticeVisible()).toBe(false);
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(13);
  });

  it('treats a 200 with garbage as a failure', async () => {
    host.store = { nonsense: true } as Any;
    h = await mount();
    expect(document.getElementById('notice-text')?.textContent).toBe('Cannot load your layout');
  });

  it('a page without a layout sends only neutral state', async () => {
    host.getStatus = 403;
    h = await mount();
    ptr(document.getElementById('field') as Element, 'pointerdown', 1, 10, 10);
    tick();
    expect(h.ws().states().every((s) => s.buttons === 0)).toBe(true);
  });
});

describe('connecting', () => {
  it('opens ws://host/ws?t=token, shows Connecting…, hello first, Player N after welcome', async () => {
    h = await mount({ welcome: false });
    expect(h.ws().url).toBe(SOCKET_URL('tok-123'));
    expect(status()).toBe('Connecting…');
    h.ws().open();
    expect(h.ws().frames()).toEqual([{ t: 'hello', name: expect.stringMatching(/^Phone \d{2}$/) }]);
    h.ws().receive({ t: 'welcome', slot: 2 });
    expect(status()).toBe('Player 2');
    expect(h.ws().states()).toEqual([{ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 }]);
  });
  it('keeps the same two-digit number across loads and works without storage', async () => {
    h = await mount();
    const first = h.ws().frames()[0]?.['name'];
    h.destroy();
    FakeSocket.all = [];
    h = await mount();
    expect(h.ws().frames()[0]?.['name']).toBe(first);
    h.destroy();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    FakeSocket.all = [];
    h = await mount();
    expect(h.ws().frames()[0]?.['name']).toMatch(/^Phone \d{2}$/);
  });
});

describe('play: buttons, triggers, sending on change', () => {
  beforeEach(async () => {
    h = await mount();
  });

  it('sends nothing while nothing changes and one full-state frame per change', async () => {
    const base = h.ws().sent.length;
    tick();
    tick();
    expect(h.ws().sent.length).toBe(base);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    tick();
    expect(h.ws().states().at(-1)).toEqual({ buttons: BTN.A, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(true);
    tick();
    expect(h.ws().sent.length).toBe(base + 1);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    expect(h.ws().sent.length).toBe(base + 2);
    expect(JSON.parse(h.ws().sent.at(-1) as string)).toEqual({ t: 's', b: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
  });

  it('each control sends its own bit; digital triggers send 255', () => {
    const expected: Array<[string, Partial<PadState>]> = [
      ['btn-b', { buttons: BTN.B }],
      ['btn-x', { buttons: BTN.X }],
      ['btn-y', { buttons: BTN.Y }],
      ['btn-lb', { buttons: BTN.LEFT_SHOULDER }],
      ['btn-rb', { buttons: BTN.RIGHT_SHOULDER }],
      ['btn-start', { buttons: BTN.START }],
      ['btn-back', { buttons: BTN.BACK }],
      ['btn-lt', { lt: 255 }],
      ['btn-rt', { rt: 255 }],
    ];
    for (const [id, want] of expected) {
      ptr(h.ctl(id), 'pointerdown', 9);
      tick();
      expect(h.ws().states().at(-1), id).toMatchObject({ buttons: 0, lt: 0, rt: 0, ...want });
      ptr(h.ctl(id), 'pointerup', 9);
      tick();
      tick();
    }
  });

  it('never sends faster than 60 frames a second on a 120 Hz display', () => {
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    frame(5000);
    const after = h.ws().sent.length;
    ptr(h.ctl('btn-b'), 'pointerdown', 2);
    frame(5008.3);
    expect(h.ws().sent.length).toBe(after);
    frame(5016.6);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A | BTN.B);
  });

  it('a press released within the same frame still reaches the host for one frame', () => {
    const base = h.ws().sent.length;
    ptr(h.ctl('btn-y'), 'pointerdown', 1);
    ptr(h.ctl('btn-y'), 'pointerup', 1);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.Y);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    expect(h.ws().sent.length).toBe(base + 2);
  });

  it('two fingers on one button keep it down until both lift', () => {
    const a = h.ctl('btn-a');
    ptr(a, 'pointerdown', 1);
    ptr(a, 'pointerdown', 2);
    tick();
    ptr(a, 'pointerup', 1);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    ptr(a, 'pointerup', 2);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    expect(a.getAttribute('aria-pressed')).toBe('false');
  });

  it('keepalive: {"t":"k"} every 500 ms while idle, restarted by a state frame', () => {
    const ws = h.ws();
    vi.advanceTimersByTime(499);
    expect(ws.count('k')).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ws.count('k')).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(ws.count('k')).toBe(4);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    tick();
    vi.advanceTimersByTime(499);
    expect(ws.count('k')).toBe(4);
    vi.advanceTimersByTime(1);
    expect(ws.count('k')).toBe(5);
  });
});

describe('play: layout-driven button behaviour', () => {
  it('LT/RT send the layout value', async () => {
    host.store = T.patchControl(withPatch('btn-lt', { value: 128 }), 'btn-rt', { value: 1 });
    h = await mount();
    ptr(h.ctl('btn-lt'), 'pointerdown', 1);
    ptr(h.ctl('btn-rt'), 'pointerdown', 2);
    tick();
    expect(h.ws().states().at(-1)).toMatchObject({ lt: 128, rt: 1 });
  });

  it('latch: tap to hold, tap again to release', async () => {
    host.store = withPatch('btn-a', { latch: true });
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    tick();
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(true);
    ptr(h.ctl('btn-a'), 'pointerdown', 2);
    ptr(h.ctl('btn-a'), 'pointerup', 2);
    tick();
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
  });

  it('turbo: 50 ms on, 50 ms off while held, stops on release', async () => {
    host.store = withPatch('btn-a', { turbo: true });
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(50);
      tick();
      tick();
      seen.push(h.ws().states().at(-1)?.buttons as number);
    }
    expect(seen).toEqual([0, BTN.A, 0, BTN.A]);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    vi.advanceTimersByTime(500);
    tick();
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    const n = h.ws().count('s');
    vi.advanceTimersByTime(1000);
    tick();
    expect(h.ws().count('s')).toBe(n); // the timer is gone
  });

  it('haptics: 8 ms on button down when the layout and the browser allow it', async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(vibrate).toHaveBeenCalledWith(8);
    ptr(h.ctl('btn-a'), 'pointerdown', 2);
    expect(vibrate).toHaveBeenCalledTimes(1);
    h.destroy();
    vibrate.mockClear();
    host.store = T.setHaptics(defaultStore(), 'default', false);
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('works where navigator.vibrate does not exist (iOS)', async () => {
    h = await mount();
    expect('vibrate' in navigator).toBe(false);
    expect(() => ptr(h.ctl('btn-a'), 'pointerdown', 1)).not.toThrow();
  });
});

describe('play: sticks', () => {
  const stickRects = (id: string, left = 0, top = 0, size = 156, baseSize = 100): void => {
    rect(h.ctl(id), left, top, size, size);
    rect(h.ctl(id).querySelector('.stick-base') as Element, left, top, baseSize, baseSize);
  };
  const last = (): PadState => h.ws().states().at(-1) as PadState;

  it('fixed stick: the base centre is the origin; deflection maps to axes with up positive', async () => {
    h = await mount();
    stickRects('stick-left'); // zone 156, base 100 => radius 50, centre (78, 78)
    const el = h.ctl('stick-left');
    ptr(el, 'pointerdown', 1, 78, 78);
    tick();
    expect(last()).toMatchObject({ lx: 0, ly: 0 });
    ptr(el, 'pointermove', 1, 128, 78);
    tick();
    expect(last()).toMatchObject({ lx: 32767, ly: 0, rx: 0, ry: 0 });
    ptr(el, 'pointermove', 1, 78, 28);
    tick();
    expect(last()).toMatchObject({ lx: 0, ly: 32767 });
    ptr(el, 'pointermove', 1, 78, 128);
    tick();
    expect(last()).toMatchObject({ ly: -32767 });
    ptr(el, 'pointerup', 1, 78, 128);
    tick();
    expect(last()).toEqual({ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
  });

  it('uses the stick settings of the layout (dead zone, curve, inversion, sensitivity)', async () => {
    host.store = withPatch('stick-left', { deadzone: 0, curve: 'precise', invertY: true, sensitivity: 2 });
    h = await mount();
    stickRects('stick-left');
    ptr(h.ctl('stick-left'), 'pointerdown', 1, 78, 78);
    ptr(h.ctl('stick-left'), 'pointermove', 1, 78 + 25, 78 - 25); // r = 0.707, m = 0.5, *2 = 1 (precise first: 0.5)
    tick();
    const m = Math.min(1, 0.5 * 2);
    expect(last().lx).toBe(Math.round((25 / Math.hypot(25, 25)) * m * 32767));
    expect(last().ly).toBe(-Math.round((25 / Math.hypot(25, 25)) * m * 32767)); // invertY: screen-up now sends negative
  });

  it('a "right" stick control writes the right axes, whichever control it is', async () => {
    host.store = withPatch('stick-left', { stick: 'right' });
    h = await mount();
    stickRects('stick-left');
    ptr(h.ctl('stick-left'), 'pointerdown', 1, 78, 78);
    ptr(h.ctl('stick-left'), 'pointermove', 1, 128, 78);
    tick();
    expect(last()).toMatchObject({ lx: 0, rx: 32767 });
  });

  it('floating stick: the base appears under the first touch, kept inside the area', async () => {
    host.store = withPatch('stick-left', { mode: 'floating' });
    h = await mount();
    expect(h.ctl('stick-left').classList.contains('is-floating')).toBe(true);
    stickRects('stick-left', 0, 0, 150, 100); // radius 50
    const el = h.ctl('stick-left');
    ptr(el, 'pointerdown', 1, 5, 5); // corner: origin pushed to (50, 50)
    const base = el.querySelector('.stick-base') as HTMLElement;
    expect(base.style.getPropertyValue('--ox')).toBe('50.0px');
    expect(base.style.getPropertyValue('--oy')).toBe('50.0px');
    tick();
    expect(last().lx).toBeLessThan(0);
    ptr(el, 'pointerup', 1);
    expect(base.style.getPropertyValue('--ox')).toBe('');
  });

  it('a second finger on the same stick is ignored; the two sticks are independent', async () => {
    h = await mount();
    stickRects('stick-left');
    stickRects('stick-right', 400, 200);
    ptr(h.ctl('stick-left'), 'pointerdown', 1, 78, 78);
    ptr(h.ctl('stick-left'), 'pointerdown', 2, 100, 100);
    ptr(h.ctl('stick-left'), 'pointermove', 2, 128, 78);
    ptr(h.ctl('stick-right'), 'pointerdown', 3, 478, 278);
    ptr(h.ctl('stick-right'), 'pointermove', 3, 478, 228);
    tick();
    expect(last()).toMatchObject({ lx: 0, ly: 0, rx: 0, ry: 32767 });
  });

  it('double tap presses L3 (left) or R3 (right) while the second touch is held', async () => {
    h = await mount();
    for (const [id, bit, y] of [['stick-left', BTN.LEFT_THUMB, 78], ['stick-right', BTN.RIGHT_THUMB, 278]] as const) {
      stickRects(id, id === 'stick-left' ? 0 : 400, id === 'stick-left' ? 0 : 200);
      const x = id === 'stick-left' ? 78 : 478;
      const el = h.ctl(id);
      ptr(el, 'pointerdown', 1, x, y);
      vi.advanceTimersByTime(80);
      ptr(el, 'pointerup', 1, x, y);
      vi.advanceTimersByTime(150);
      ptr(el, 'pointerdown', 2, x, y);
      tick();
      expect(last().buttons, id).toBe(bit);
      ptr(el, 'pointerup', 2, x, y);
      tick();
      expect(last().buttons, id).toBe(0);
    }
  });

  it('too slow a second tap, or a long first touch, is no double tap; a triple tap does not chain', async () => {
    h = await mount();
    stickRects('stick-left');
    const el = h.ctl('stick-left');
    ptr(el, 'pointerdown', 1, 78, 78);
    vi.advanceTimersByTime(50);
    ptr(el, 'pointerup', 1);
    vi.advanceTimersByTime(400);
    ptr(el, 'pointerdown', 2, 78, 78);
    tick();
    expect(last().buttons).toBe(0);
    ptr(el, 'pointerup', 2);
    vi.advanceTimersByTime(600); // first touch held long: not a tap
    ptr(el, 'pointerdown', 3, 78, 78);
    vi.advanceTimersByTime(900);
    ptr(el, 'pointerup', 3);
    vi.advanceTimersByTime(50);
    ptr(el, 'pointerdown', 4, 78, 78);
    tick();
    expect(last().buttons).toBe(0);
    ptr(el, 'pointerup', 4);
    // tap, tap (click), tap: the third is not a double tap with the second
    vi.advanceTimersByTime(500);
    for (const id of [5, 6]) {
      ptr(el, 'pointerdown', id, 78, 78);
      vi.advanceTimersByTime(40);
      ptr(el, 'pointerup', id);
      vi.advanceTimersByTime(40);
    }
    tick(); // the click of the second tap was latched for one frame
    tick();
    ptr(el, 'pointerdown', 7, 78, 78);
    tick();
    expect(last().buttons).toBe(0);
  });

  it('doubleTapClick off: no click', async () => {
    host.store = withPatch('stick-left', { doubleTapClick: false });
    h = await mount();
    stickRects('stick-left');
    const el = h.ctl('stick-left');
    ptr(el, 'pointerdown', 1, 78, 78);
    ptr(el, 'pointerup', 1);
    vi.advanceTimersByTime(100);
    ptr(el, 'pointerdown', 2, 78, 78);
    tick();
    expect(last().buttons).toBe(0);
  });
});

describe('play: d-pad', () => {
  it('follows the finger between directions and lights the arms; diagonals can be switched off', async () => {
    h = await mount();
    const dp = h.ctl('dpad');
    rect(dp, 100, 100, 150, 150); // centre (175, 175)
    ptr(dp, 'pointerdown', 1, 245, 175);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.DPAD_RIGHT);
    expect(dp.querySelector('.arm-right')?.classList.contains('is-down')).toBe(true);
    ptr(dp, 'pointermove', 1, 235, 235);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.DPAD_RIGHT | BTN.DPAD_DOWN);
    ptr(dp, 'pointerup', 1);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    expect(dp.querySelector('.is-down')).toBeNull();

    h.destroy();
    host.store = withPatch('dpad', { diagonals: false });
    h = await mount();
    const dp2 = h.ctl('dpad');
    rect(dp2, 100, 100, 150, 150);
    ptr(dp2, 'pointerdown', 1, 235, 235);
    tick();
    expect([BTN.DPAD_RIGHT, BTN.DPAD_DOWN]).toContain(h.ws().states().at(-1)?.buttons);
  });
});

describe('play: multi-touch', () => {
  it('handles five simultaneous touches and releases them one by one', async () => {
    h = await mount();
    rect(h.ctl('stick-left'), 0, 0, 156, 156);
    rect(h.ctl('stick-left').querySelector('.stick-base') as Element, 0, 0, 100, 100);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    ptr(h.ctl('btn-b'), 'pointerdown', 2);
    ptr(h.ctl('btn-lt'), 'pointerdown', 3);
    ptr(h.ctl('btn-rt'), 'pointerdown', 4);
    ptr(h.ctl('stick-left'), 'pointerdown', 5, 78, 78);
    ptr(h.ctl('stick-left'), 'pointermove', 5, 128, 78);
    tick();
    expect(h.ws().states().at(-1)).toEqual({ buttons: BTN.A | BTN.B, lt: 255, rt: 255, lx: 32767, ly: 0, rx: 0, ry: 0 });
    ptr(h.ctl('btn-b'), 'pointerup', 2);
    ptr(h.ctl('btn-lt'), 'pointerup', 3);
    tick();
    expect(h.ws().states().at(-1)).toEqual({ buttons: BTN.A, lt: 0, rt: 255, lx: 32767, ly: 0, rx: 0, ry: 0 });
  });
  it('ignores right-clicks and unknown pointers', async () => {
    h = await mount();
    h.ctl('btn-a').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 2 }));
    ptr(h.ctl('btn-a'), 'pointerup', 77);
    ptr(h.ctl('btn-a'), 'pointermove', 77);
    const n = h.ws().sent.length;
    tick();
    expect(h.ws().sent.length).toBe(n);
  });
});

describe('safety release', () => {
  const neutral = { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
  const holdSomething = (): void => {
    rect(h.ctl('stick-left'), 0, 0, 156, 156);
    rect(h.ctl('stick-left').querySelector('.stick-base') as Element, 0, 0, 100, 100);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    ptr(h.ctl('btn-rt'), 'pointerdown', 2);
    ptr(h.ctl('stick-left'), 'pointerdown', 3, 78, 78);
    ptr(h.ctl('stick-left'), 'pointermove', 3, 128, 78);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
  };
  beforeEach(async () => {
    h = await mount();
  });

  it('page hidden: releases all and sends one neutral state immediately (no frame needed)', () => {
    holdSomething();
    const n = h.ws().count('s');
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.ws().count('s')).toBe(n + 1);
    expect(h.ws().states().at(-1)).toEqual(neutral);
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(false);
    tick();
    expect(h.ws().count('s')).toBe(n + 1);
  });
  it('window blur and pagehide', () => {
    holdSomething();
    window.dispatchEvent(new Event('blur'));
    expect(h.ws().states().at(-1)).toEqual(neutral);
    holdSomething();
    window.dispatchEvent(new Event('pagehide'));
    expect(h.ws().states().at(-1)).toEqual(neutral);
  });
  it('a cancelled pointer releases every control, not just its own', () => {
    holdSomething();
    ptr(h.ctl('btn-rt'), 'pointercancel', 2);
    expect(h.ws().states().at(-1)).toEqual(neutral);
    ptr(h.ctl('stick-left'), 'pointermove', 3, 78, 28);
    tick();
    expect(h.ws().states().at(-1)).toEqual(neutral);
  });
  it('releases latched buttons too, and sends no second neutral when nothing was held', async () => {
    h.destroy();
    host.store = withPatch('btn-a', { latch: true });
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    tick();
    window.dispatchEvent(new Event('blur'));
    expect(h.ws().states().at(-1)).toEqual(neutral);
    const n = h.ws().count('s');
    window.dispatchEvent(new Event('blur'));
    expect(h.ws().count('s')).toBe(n);
  });
  it('a press cancelled by a safety release never leaks out as a ghost frame', () => {
    ptr(h.ctl('btn-b'), 'pointerdown', 1);
    window.dispatchEvent(new Event('blur'));
    const n = h.ws().count('s');
    tick();
    expect(h.ws().count('s')).toBe(n);
    expect(h.ws().states().every((s) => s.buttons === 0)).toBe(true);
  });
  it('portrait: releases everything, ignores input, and works again in landscape', () => {
    holdSomething();
    setPortrait(true);
    expect(h.ws().states().at(-1)).toEqual(neutral);
    ptr(h.ctl('btn-b'), 'pointerdown', 7);
    tick();
    expect(h.ws().states().at(-1)).toEqual(neutral);
    setPortrait(false);
    ptr(h.ctl('btn-b'), 'pointerdown', 8);
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.B);
  });
});

describe('reconnecting', () => {
  it('closing the socket releases everything and shows Disconnected — retrying…', async () => {
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    tick();
    h.ws().drop();
    expect(status()).toBe('Disconnected — retrying…');
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(false);
  });
  it('reconnects after 500 ms, re-sends hello, then the current state after welcome', async () => {
    h = await mount();
    const name = h.ws(0).frames()[0]?.['name'];
    h.ws(0).drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    const second = h.ws(1);
    second.open();
    expect(second.frames()).toEqual([{ t: 'hello', name }]);
    ptr(h.ctl('btn-x'), 'pointerdown', 1);
    tick();
    expect(second.count('s')).toBe(0);
    second.receive({ t: 'welcome', slot: 3 });
    expect(status()).toBe('Player 3');
    expect(second.frames().map((f) => f.t)).toEqual(['hello', 's']);
    expect(second.states()[0]?.buttons).toBe(BTN.X);
  });
  it('backs off 500, 1000, 2000, 4000, 5000 ms and resets after a welcome', async () => {
    h = await mount();
    h.ws(0).drop();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.all.length;
      let waited = 0;
      while (FakeSocket.all.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
        if (waited > 10_000) throw new Error('no reconnect');
      }
      waits.push(waited);
      h.ws().drop();
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    vi.advanceTimersByTime(5000);
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 1 });
    h.ws().drop();
    const n = FakeSocket.all.length;
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(n + 1);
  });
  it('survives a WebSocket constructor that throws', async () => {
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new Error('SecurityError');
        }
      },
    );
    h = await mount({ welcome: false });
    expect(status()).toBe('Disconnected — retrying…');
    vi.advanceTimersByTime(60_000);
    expect(status()).toBe('Disconnected — retrying…');
  });
  it('coming back to the foreground reconnects at once', async () => {
    h = await mount();
    h.ws(0).drop();
    vi.advanceTimersByTime(500);
    h.ws(1).drop();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(3);
  });
});

describe('full and kicked are final', () => {
  it('full: message, no reconnect, no controls; Try again restarts on request', async () => {
    h = await mount({ welcome: false });
    h.ws().open();
    h.ws().receive({ t: 'full' });
    await settle();
    expect(status()).toBe('All 4 player slots are taken');
    expect(noticeVisible()).toBe(true);
    expect((document.getElementById('retry') as HTMLElement).hidden).toBe(false);
    expect(h.ws().closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    tick();
    expect(h.ws().states()).toHaveLength(0);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(1);
    (document.getElementById('retry') as HTMLElement).click();
    expect(FakeSocket.all).toHaveLength(2);
    expect(status()).toBe('Connecting…');
  });
  it('kicked: message, no reconnect, no retry button, sends nothing more', async () => {
    h = await mount();
    const ws = h.ws();
    const n = ws.sent.length;
    ws.receive({ t: 'kicked' });
    expect(status()).toBe('Removed from this PC');
    expect((document.getElementById('retry') as HTMLElement).hidden).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    window.dispatchEvent(new Event('blur'));
    expect(ws.sent.length).toBe(n);
  });
});

describe('full screen, wake lock, browser defaults', () => {
  it('hides the full-screen button without the API, and requests full screen then the landscape lock', async () => {
    h = await mount();
    expect((document.getElementById('fullscreen') as HTMLElement).hidden).toBe(true);
    h.destroy();
    const order: string[] = [];
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    (document.documentElement as Any).requestFullscreen = () => {
      order.push('fullscreen');
      return Promise.resolve();
    };
    Object.defineProperty(screen, 'orientation', {
      configurable: true,
      value: { lock: (o: string) => (order.push('lock:' + o), Promise.reject(new Error('NotSupportedError'))) },
    });
    h = await mount();
    (document.getElementById('fullscreen') as HTMLElement).click();
    await settle();
    expect(order).toEqual(['fullscreen', 'lock:landscape']);
  });
  it('requests a wake lock when available; otherwise shows the hint once, dismissible', async () => {
    const request = vi.fn(() => Promise.resolve({ release: () => Promise.resolve(), released: false }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    h = await mount();
    expect(request).toHaveBeenCalledWith('screen');
    expect((document.getElementById('hint') as HTMLElement).hidden).toBe(true);
    h.destroy();
    delete (navigator as Any).wakeLock;
    h = await mount();
    const hint = document.getElementById('hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('Set your screen timeout to Never while playing');
    (document.getElementById('hint-close') as HTMLElement).click();
    expect(hint.hidden).toBe(true);
    h.destroy();
    h = await mount();
    expect((document.getElementById('hint') as HTMLElement).hidden).toBe(true);
  });
  it('cancels the context menu, selection, dragging and touch scrolling', async () => {
    h = await mount();
    for (const type of ['contextmenu', 'selectstart', 'dragstart', 'touchmove', 'gesturestart']) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented, type).toBe(true);
    }
  });
  it('destroy() removes the page listeners and closes the socket', async () => {
    h = await mount();
    const ws = h.ws();
    h.destroy();
    expect(ws.closed).toBe(true);
    const e = new Event('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

// ---- Presets in play mode ----------------------------------------------------------------------------------------------

describe('switching presets while playing', () => {
  it('shows a picker when there are several, switches the drawn controls, releases input and saves the choice', async () => {
    host.store = T.switchLayout(T.newBlankLayout(defaultStore()), 'default');
    h = await mount();
    const pick = h.q<HTMLSelectElement>('#layout-pick');
    expect(pick.hidden).toBe(false);
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Xbox', 'Layout 2']);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    tick();
    const blankId = (host.store.layouts[1] as { id: string }).id;
    pick.value = blankId;
    pick.dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(0);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(host.lastPut().activeId).toBe(blankId);
  });
});

// ---- Edit mode ---------------------------------------------------------------------------------------------------------

describe('edit mode', () => {
  const longPressEdit = async (ms = 650): Promise<void> => {
    ptr(document.getElementById('edit') as Element, 'pointerdown', 50);
    await vi.advanceTimersByTimeAsync(ms);
    ptr(document.getElementById('edit') as Element, 'pointerup', 50);
  };
  const editing = (): boolean => document.body.classList.contains('editing');
  const row = (label: string): HTMLElement => {
    const r = [...document.querySelectorAll<HTMLElement>('#panel-content .row')].find((x) => x.querySelector('.row-label')?.textContent === label);
    if (!r) throw new Error('no row ' + label + ' in ' + document.getElementById('panel-content')?.textContent);
    return r;
  };
  const slide = (label: string, value: number): void => {
    const input = row(label).querySelector('input') as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
  };
  const tabTo = (name: string): void => (document.querySelector(`.tab[data-tab="${name}"]`) as HTMLElement).click();
  const button = (text: string): HTMLButtonElement => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('#panel-content button')].find((x) => x.textContent === text);
    if (!b) throw new Error('no button ' + text);
    return b;
  };
  const control = (id: string): Any => T.activeLayout(host.lastPut()).controls.find((c: { id: string }) => c.id === id);
  // The field is 800 x 400 in these tests, so 1% of the width is 8 px and 1% of the height is 4 px.

  beforeEach(async () => {
    h = await mount();
  });

  it('needs a deliberate 600 ms press on Edit', async () => {
    await longPressEdit(500);
    expect(editing()).toBe(false);
    ptr(document.getElementById('edit') as Element, 'pointerdown', 50);
    await vi.advanceTimersByTimeAsync(300);
    ptr(document.getElementById('edit') as Element, 'pointerleave', 50);
    await vi.advanceTimersByTimeAsync(600);
    expect(editing()).toBe(false);
    await longPressEdit(650);
    expect(editing()).toBe(true);
    expect((document.getElementById('panel') as HTMLElement).hidden).toBe(false);
    (document.getElementById('done') as HTMLElement).click();
    expect(editing()).toBe(false);
    // keyboard users activate with a click that has no pointer behind it
    (document.getElementById('edit') as HTMLElement).click();
    expect(editing()).toBe(true);
  });

  it('sends neutral on entry and only keepalives while editing; play input is ignored', async () => {
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    tick();
    await longPressEdit();
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    const n = h.ws().count('s');
    ptr(h.ctl('btn-b'), 'pointerdown', 2); // selects instead of pressing
    ptr(h.ctl('btn-b'), 'pointerup', 2);
    tick();
    tick();
    const k = h.ws().count('k');
    vi.advanceTimersByTime(1500);
    expect(h.ws().count('s')).toBe(n);
    expect(h.ws().count('k')).toBeGreaterThanOrEqual(k + 3);
  });

  it('selecting shows an outline, a resize handle and the control panel on the far side', async () => {
    await longPressEdit();
    expect(document.getElementById('panel')?.classList.contains('collapsed')).toBe(true);
    ptr(h.ctl('btn-a'), 'pointerdown', 1, 680, 304);
    ptr(h.ctl('btn-a'), 'pointerup', 1, 680, 304);
    expect(h.ctl('btn-a').classList.contains('is-selected')).toBe(true);
    expect(h.ctl('btn-a').querySelector('.resize-handle')).toBeTruthy();
    expect(document.getElementById('panel')?.classList.contains('collapsed')).toBe(false);
    expect(document.getElementById('panel')?.classList.contains('panel-left')).toBe(true); // A is on the right
    expect(row('Button')).toBeTruthy();
    ptr(h.ctl('stick-left'), 'pointerdown', 2, 120, 260);
    ptr(h.ctl('stick-left'), 'pointerup', 2, 120, 260);
    expect(h.ctl('btn-a').classList.contains('is-selected')).toBe(false);
    expect(h.ctl('btn-a').querySelector('.resize-handle')).toBeNull();
    expect(document.getElementById('panel')?.classList.contains('panel-left')).toBe(false);
    ptr(document.getElementById('field') as Element, 'pointerdown', 3, 400, 10); // empty space deselects
    expect(document.querySelector('.is-selected')).toBeNull();
  });

  it('drags a control with a finger, clamped to the screen, and autosaves 1.5 s later', async () => {
    await longPressEdit();
    ptr(h.ctl('btn-a'), 'pointerdown', 1, 680, 304); // A is centred at (85%, 76%) = (680, 304)
    ptr(h.ctl('btn-a'), 'pointermove', 1, 400, 200);
    expect(h.ctl('btn-a').style.left).toBe('50%');
    expect(h.ctl('btn-a').style.top).toBe('50%');
    ptr(h.ctl('btn-a'), 'pointermove', 1, 5000, 5000);
    const a = h.ctl('btn-a');
    expect(parseFloat(a.style.left)).toBeLessThanOrEqual(100);
    expect(parseFloat(a.style.left)).toBeGreaterThan(90);
    ptr(a, 'pointermove', 1, 400, 200);
    ptr(a, 'pointerup', 1, 400, 200);
    expect(saveText()).toBe('Saving…');
    await vi.advanceTimersByTimeAsync(1400);
    expect(host.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(host.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(control('btn-a')).toMatchObject({ x: 50, y: 50 });
    expect(host.calls.find((c) => c.method === 'PUT')?.token).toBe('tok-123');
    expect(saveText()).toBe('Saved on the host PC');
    expect(host.store).toEqual(host.lastPut());
  });

  it('resizes with the corner handle', async () => {
    await longPressEdit();
    ptr(h.ctl('btn-a'), 'pointerdown', 1, 680, 304);
    ptr(h.ctl('btn-a'), 'pointerup', 1, 680, 304);
    const handle = h.ctl('btn-a').querySelector('.resize-handle') as HTMLElement;
    ptr(handle, 'pointerdown', 2, 700, 324);
    ptr(handle, 'pointermove', 2, 720, 344); // 40 px from the centre = 20% of the height each way
    ptr(handle, 'pointerup', 2, 720, 344);
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('20');
    expect(h.ctl('btn-a').style.getPropertyValue('--h')).toBe('20');
    ptr(handle, 'pointerdown', 3, 700, 324);
    ptr(handle, 'pointermove', 3, 5000, 5000);
    ptr(handle, 'pointerup', 3, 5000, 5000);
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe(String(LIMITS.size.max));
  });

  it('property sliders preview live and clamp; the panel shows the right rows per control type', async () => {
    await longPressEdit();
    ptr(h.ctl('btn-lt'), 'pointerdown', 1, 72, 40);
    ptr(h.ctl('btn-lt'), 'pointerup', 1, 72, 40);
    slide('Width', 30);
    expect(h.ctl('btn-lt').style.getPropertyValue('--w')).toBe('30');
    slide('Opacity', 0.5);
    expect(h.ctl('btn-lt').style.opacity).toBe('0.5');
    slide('Trigger value', 100);
    for (const l of ['Button', 'Width', 'Height', 'Shape', 'Label', 'Latch (tap on, tap off)', 'Turbo (rapid fire)', 'Trigger value', 'Opacity']) expect(row(l)).toBeTruthy();
    ptr(h.ctl('btn-a'), 'pointerdown', 2, 680, 304);
    ptr(h.ctl('btn-a'), 'pointerup', 2, 680, 304);
    expect(() => row('Trigger value')).toThrow(); // only LT and RT have a value
    ptr(h.ctl('stick-left'), 'pointerdown', 3, 120, 260);
    ptr(h.ctl('stick-left'), 'pointerup', 3, 120, 260);
    for (const l of ['Size', 'Stick', 'Mode', 'Dead zone', 'Sensitivity', 'Curve', 'Invert X', 'Invert Y', 'Double-tap = stick click', 'Opacity']) expect(row(l)).toBeTruthy();
    slide('Dead zone', 0.3);
    ptr(h.ctl('dpad'), 'pointerdown', 4, 300, 330);
    ptr(h.ctl('dpad'), 'pointerup', 4, 300, 330);
    for (const l of ['Size', 'Diagonals', 'Opacity']) expect(row(l)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1600);
    expect(control('btn-lt')).toMatchObject({ w: 30, opacity: 0.5, value: 100 });
    expect(control('stick-left').deadzone).toBe(0.3);
  });

  it('select, checkbox and text properties apply; changing the button name rebuilds the panel', async () => {
    await longPressEdit();
    ptr(h.ctl('btn-a'), 'pointerdown', 1, 680, 304);
    ptr(h.ctl('btn-a'), 'pointerup', 1, 680, 304);
    const sel = row('Button').querySelector('select') as HTMLSelectElement;
    sel.value = 'LT';
    sel.dispatchEvent(new Event('change'));
    expect(h.ctl('btn-a').dataset['button']).toBe('LT');
    expect(h.ctl('btn-a').textContent).toBe('LT');
    expect(row('Trigger value')).toBeTruthy();
    const text = row('Label').querySelector('input') as HTMLInputElement;
    text.value = 'Zap';
    text.dispatchEvent(new Event('change'));
    expect(h.ctl('btn-a').textContent).toBe('Zap');
    const latch = row('Latch (tap on, tap off)').querySelector('input') as HTMLInputElement;
    latch.checked = true;
    latch.dispatchEvent(new Event('change'));
    expect(h.ctl('btn-a').classList.contains('is-latch')).toBe(true);
    await vi.advanceTimersByTimeAsync(1600);
    expect(control('btn-a')).toMatchObject({ button: 'LT', label: 'Zap', latch: true });
  });

  it('adds controls (any button, stick, d-pad), duplicates and deletes them, respecting the limit', async () => {
    await longPressEdit();
    const count = (): number => document.querySelectorAll('#field [data-cid]').length;
    tabTo('add');
    const pick = document.querySelector('#panel-content select') as HTMLSelectElement;
    pick.value = 'Y';
    pick.dispatchEvent(new Event('change'));
    button('Add button').click();
    expect(count()).toBe(14);
    expect(document.querySelector('.is-selected')?.getAttribute('data-cid')).toBe('btn-y-2');
    expect(row('Button')).toBeTruthy(); // the new control's properties are shown
    tabTo('add');
    button('Add stick').click();
    tabTo('add');
    button('Add d-pad').click();
    expect(count()).toBe(16);
    expect(document.querySelector('.ctl-stick[data-cid="stick-right-2"]')).toBeTruthy();
    // the new d-pad is selected: duplicate it, delete the copy
    button('Duplicate').click();
    expect(count()).toBe(17);
    button('Delete').click();
    expect(count()).toBe(16);
    while (count() < LIMITS.controls) {
      tabTo('add');
      button('Add button').click();
    }
    tabTo('add');
    expect(button('Add button').disabled).toBe(true);
    expect(document.getElementById('panel-msg')?.textContent).toContain(String(LIMITS.controls));
    const ids = [...document.querySelectorAll('#field [data-cid]')].map((e) => e.getAttribute('data-cid'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('undo steps back one gesture at a time', async () => {
    await longPressEdit();
    const undoBtn = document.getElementById('undo') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    ptr(h.ctl('btn-a'), 'pointerdown', 1, 680, 304);
    ptr(h.ctl('btn-a'), 'pointermove', 1, 600, 250);
    ptr(h.ctl('btn-a'), 'pointermove', 1, 500, 200);
    ptr(h.ctl('btn-a'), 'pointerup', 1, 500, 200);
    expect(undoBtn.disabled).toBe(false);
    expect(h.ctl('btn-a').style.left).not.toBe('85%');
    undoBtn.click();
    expect(h.ctl('btn-a').style.left).toBe('85%');
    expect(h.ctl('btn-a').style.top).toBe('76%');
    expect(undoBtn.disabled).toBe(true);
  });

  it('Done saves at once and returns to play', async () => {
    await longPressEdit();
    ptr(h.ctl('btn-b'), 'pointerdown', 1, 744, 244);
    ptr(h.ctl('btn-b'), 'pointermove', 1, 400, 200);
    ptr(h.ctl('btn-b'), 'pointerup', 1, 400, 200);
    (document.getElementById('done') as HTMLElement).click();
    await settle();
    expect(editing()).toBe(false);
    expect(host.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(control('btn-b').x).toBe(50);
    expect(document.querySelector('.resize-handle')).toBeNull();
    ptr(h.ctl('btn-b'), 'pointerdown', 2); // plays again
    tick();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.B);
  });

  it('a failed save shows "Not saved, retry", keeps the draft, and Retry saves it', async () => {
    host.putFail = 1;
    await longPressEdit();
    ptr(h.ctl('btn-b'), 'pointerdown', 1, 744, 244);
    ptr(h.ctl('btn-b'), 'pointermove', 1, 400, 200);
    ptr(h.ctl('btn-b'), 'pointerup', 1, 400, 200);
    await vi.advanceTimersByTimeAsync(1600);
    expect(saveText()).toBe('Not saved, retry');
    expect((document.getElementById('panel-save') as HTMLButtonElement).disabled).toBe(false);
    expect(h.ctl('btn-b').style.left).toBe('50%'); // the draft stays on screen
    (document.getElementById('panel-save') as HTMLElement).click();
    await settle();
    expect(saveText()).toBe('Saved on the host PC');
    expect(host.store.layouts[0]?.controls.find((c) => c.id === 'btn-b')).toMatchObject({ x: 50 });
  });

  it('the host response is the truth: a sanitized store replaces the draft', async () => {
    await longPressEdit();
    ptr(h.ctl('btn-a'), 'pointerdown', 1, 680, 304);
    ptr(h.ctl('btn-a'), 'pointerup', 1, 680, 304);
    // make the fake host "sanitize" differently from the page
    const real = host.store;
    host.store = real;
    slide('Width', 20);
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as LayoutStore;
        const clamped = sanitizeStore(body);
        (clamped.layouts[0]?.controls.find((c) => c.id === 'btn-a') as Any).w = 33;
        return { ok: true, status: 200, json: async () => clamped };
      }
      return originalFetch(url, init);
    });
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('33');
  });

  it('a new edit while a save is in flight is not overwritten by the older response', async () => {
    await longPressEdit();
    ptr(h.ctl('btn-a'), 'pointerdown', 1, 680, 304);
    ptr(h.ctl('btn-a'), 'pointerup', 1, 680, 304);
    slide('Width', 20);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') await gate;
      return originalFetch(url, init);
    });
    await vi.advanceTimersByTimeAsync(1600); // first PUT starts and waits
    slide('Width', 25);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('25');
    await vi.advanceTimersByTimeAsync(1600);
    expect(control('btn-a').w).toBe(25);
  });

  it('presets: new blank, new from default, duplicate, rename, switch, delete (never the last), reset, haptics', async () => {
    await longPressEdit();
    tabTo('layout');
    expect((button('Delete layout') as HTMLButtonElement).disabled).toBe(true); // the only layout
    button('New (blank)').click();
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(0);
    expect(document.querySelector('#panel-content select')).toBeTruthy();
    const name = document.querySelector('#panel-content .row-text') as HTMLInputElement;
    expect(name.value).toBe('Layout 2');
    name.value = 'Racing';
    name.dispatchEvent(new Event('change'));
    tabTo('add');
    button('Add d-pad').click();
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(1);
    tabTo('layout');
    button('New from default').click();
    await settle();
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(13);
    expect((document.querySelector('#panel-content .row-text') as HTMLInputElement).value).toBe('Xbox 2');
    button('Duplicate').click();
    expect((document.querySelector('#panel-content .row-text') as HTMLInputElement).value).toBe('Xbox 2 copy');
    const sel = document.querySelector('#panel-content select') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Xbox', 'Racing', 'Xbox 2', 'Xbox 2 copy']);
    sel.value = 'layout'; // the blank one, renamed Racing, now holds one d-pad
    sel.dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(1);
    const haptics = document.querySelector('#panel-content .row-check input') as HTMLInputElement;
    haptics.checked = false;
    haptics.dispatchEvent(new Event('change'));
    button('Reset to default').click();
    await settle();
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(13);
    const del = button('Delete layout');
    del.click();
    expect(del.textContent).toBe('Tap again to delete'); // two steps
    del.click();
    expect(document.querySelector('#panel-content .row-text')).toBeTruthy();
    (document.getElementById('done') as HTMLElement).click();
    await settle();
    const saved = host.store;
    expect(saved.layouts.map((l) => l.name)).toEqual(['Xbox', 'Xbox 2', 'Xbox 2 copy']);
    expect(saved.layouts.some((l) => l.id === saved.activeId)).toBe(true);
    expect((document.getElementById('layout-pick') as HTMLElement).hidden).toBe(false);
  });

  it('reports a failed default-layout request instead of inventing one', async () => {
    await longPressEdit();
    tabTo('layout');
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => (String(url).includes('default-layout') ? { ok: false, status: 500, json: async () => ({}) } : originalFetch(url, init)));
    button('New from default').click();
    await settle();
    expect(document.getElementById('panel-msg')?.textContent).toBe('Cannot load the default layout');
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(13);
  });

  it('the panel can be collapsed to its header and brought back', async () => {
    await longPressEdit();
    ptr(h.ctl('btn-a'), 'pointerdown', 1, 680, 304);
    ptr(h.ctl('btn-a'), 'pointerup', 1, 680, 304);
    const collapse = document.getElementById('collapse') as HTMLElement;
    collapse.click();
    expect((document.getElementById('panel-body') as HTMLElement).hidden).toBe(true);
    expect(collapse.textContent).toBe('Panel');
    expect(collapse.getAttribute('aria-expanded')).toBe('false');
    collapse.click();
    expect((document.getElementById('panel-body') as HTMLElement).hidden).toBe(false);
  });
});

// Keep this last: it starts a page the way a browser does and has no handle to tear it down.
describe('a normal page (no test hook)', () => {
  it('exposes nothing, adds no globals, and starts by itself', () => {
    delete g.__LANPLAY_TEST__;
    delete (window as Any).__LANPLAY_TEST__;
    const before = Object.getOwnPropertyNames(globalThis).sort();
    document.body.innerHTML = BODY;
    g.happyDOM.setURL('http://192.168.1.20:47921/?t=tok-123');
    (0, eval)(script);
    expect(g.__LANPLAY_TEST__).toBeUndefined();
    expect(Object.getOwnPropertyNames(globalThis).sort()).toEqual(before);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]?.url).toBe(SOCKET_URL('tok-123'));
  });
});
