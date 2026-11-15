// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUTTON_NAMES, CURVES, LIMITS, SHAPES, defaultLayout, sanitizeStore, type LayoutStore } from '../../src/core/controller/layout.js';
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

// ---- The stock layout of the simple design (the page must not depend on the host's current defaults) ---------------------

type Spec = [id: string, button: string, x: number, y: number, w: number, shape: string, label?: string];
const BUTTON_SPECS: Spec[] = [
  ['btn-lt', 'LT', 6.5, 8, 22, 'rect'],
  ['btn-lb', 'LB', 6.5, 23.5, 22, 'rect'],
  ['btn-rt', 'RT', 93.5, 8, 22, 'rect'],
  ['btn-rb', 'RB', 93.5, 23.5, 22, 'rect'],
  ['btn-y', 'Y', 85, 43.5, 16, 'circle'],
  ['btn-x', 'X', 76.8, 60, 16, 'circle'],
  ['btn-b', 'B', 93.2, 60, 16, 'circle'],
  ['btn-a', 'A', 85, 76.5, 16, 'circle'],
  ['btn-back', 'BACK', 38, 7, 14, 'pill', 'Back'],
  ['btn-start', 'START', 62, 7, 14, 'pill', 'Start'],
];
function planLayoutRaw(): Any {
  const buttons = BUTTON_SPECS.map(([id, button, x, y, w, shape, label]) => ({ id, type: 'button', button, x, y, w, h: shape === 'rect' ? 13 : shape === 'pill' ? 10 : 16, shape, ...(label ? { label } : {}) }));
  return {
    id: 'default',
    name: 'Xbox',
    haptics: true,
    controls: [
      ...buttons,
      { id: 'stick-left', type: 'stick', stick: 'left', x: 16, y: 64, size: 38 },
      { id: 'dpad', type: 'dpad', x: 38, y: 80, size: 26 },
      { id: 'stick-right', type: 'stick', stick: 'right', x: 62, y: 80, size: 30 },
    ],
  };
}
const planStore = (): LayoutStore => sanitizeStore({ version: 1, activeId: 'default', layouts: [planLayoutRaw()] });
const fixedPoint = (s: LayoutStore): void => expect(sanitizeStore(s)).toEqual(s);

// ---- Fakes -------------------------------------------------------------------------------------------------------------

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  times: number[] = [];
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
    this.times.push(Date.now());
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
      expect(s.length).toBeLessThanOrEqual(90); // about 70 bytes per state frame
      return JSON.parse(s) as { t: string } & Record<string, unknown>;
    });
  }
  states(): PadState[] {
    return this.sent.flatMap((s) => {
      const m = parseClientMessage(s);
      return m && m.t === 's' ? [m.pad] : [];
    });
  }
  /** Timestamps of the state frames. */
  stateTimes(): number[] {
    return this.sent.flatMap((s, i) => (parseClientMessage(s)?.t === 's' ? [this.times[i] as number] : []));
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
  puts(): LayoutStore[];
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
    if (u.pathname === '/api/default-layout') return reply(200, planLayoutRaw());
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

let FW = 874;
let FH = 402;
interface Harness {
  ws(i?: number): FakeSocket;
  ctl(id: string): HTMLElement;
  /** Centre of a control in page pixels. */
  at(id: string): { x: number; y: number };
  destroy(): void;
}

/** Fresh page: the real index.html body, the URL the host hands out, the host API, and every browser API the script touches. */
async function mount(opts: { token?: string | null; welcome?: boolean; w?: number; h?: number; search?: string } = {}): Promise<Harness> {
  FW = opts.w ?? 874;
  FH = opts.h ?? 402;
  document.body.innerHTML = BODY;
  const token = opts.token === undefined ? 'tok-123' : opts.token;
  g.happyDOM.setURL('http://192.168.1.20:47921/' + (token === null ? '' : '?t=' + encodeURIComponent(token)) + (opts.search ?? ''));
  rect(document.getElementById('field') as Element, 0, 0, FW, FH);
  const booted = T.boot() as { destroy(): void };
  const h: Harness = {
    ws: (i = FakeSocket.all.length - 1) => {
      const s = FakeSocket.all[i];
      if (!s) throw new Error('no socket #' + i);
      return s;
    },
    ctl: (id) => {
      const el = document.querySelector<HTMLElement>(`[data-cid="${id}"]`);
      if (!el) throw new Error('missing control ' + id);
      return el;
    },
    at: (id) => {
      const c = T.activeLayout(host.store).controls.find((x: { id: string }) => x.id === id) as { x: number; y: number };
      return { x: (c.x / 100) * FW, y: (c.y / 100) * FH };
    },
    destroy: () => booted.destroy(),
  };
  if (opts.welcome !== false && token !== null) {
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 2 });
  }
  await vi.advanceTimersByTimeAsync(10); // past the 1/240 s gap after the welcome frame
  return h;
}

function ptr(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', id: number, x = 0, y = 0): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
}
/** A finger tap on a chrome button: down and up at the given page point (the button rect must be stubbed to test the slop). */
function tapAt(el: Element, x = 0, y = 0, id = 90): void {
  ptr(el, 'pointerdown', id, x, y);
  ptr(el, 'pointerup', id, x, y);
}

const noticeVisible = (): boolean => !(document.getElementById('notice') as HTMLElement).hidden;
const menuEl = (): HTMLElement => document.getElementById('menu') as HTMLElement;
const doneEl = (): HTMLElement => document.getElementById('done') as HTMLElement;
const cardEl = (): HTMLElement => document.getElementById('card') as HTMLElement;
const editing = (): boolean => document.body.classList.contains('editing');
const NEUTRAL = { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };

let h: Harness;
let storage: Map<string, string>;
let vibrate: ReturnType<typeof vi.fn> | null = null;

beforeEach(() => {
  FakeSocket.all = [];
  portraitNow = false;
  mqListeners = new Set();
  visibility = 'visible';
  storage = new Map();
  vibrate = null;
  host = { store: planStore(), getStatus: 200, putFail: 0, calls: [], puts: () => host.calls.filter((c) => c.method === 'PUT').map((c) => c.body as LayoutStore) };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  installFetch();
  vi.stubGlobal('WebSocket', FakeSocket);
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
  delete (navigator as Any).vibrate;
  delete (navigator as Any).userAgent;
  document.body.innerHTML = '';
  document.body.className = '';
});

function stubVibrate(): void {
  vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
}
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** A store written by the old, complicated editor: 20 layouts, latch, turbo, floating sticks, custom curves. */
function oldStore(): LayoutStore {
  const layouts = Array.from({ length: LIMITS.layouts }, (_, i) => {
    const l = planLayoutRaw();
    l.id = 'old-' + i;
    l.name = 'Old ' + i;
    l.controls = l.controls.map((c: Any) => {
      if (c.type === 'button') return { ...c, latch: true, turbo: true, value: 90, label: c.id === 'btn-a' ? 'Jump' : c.label };
      if (c.type === 'stick') return { ...c, mode: 'floating', curve: 'aggressive', invertX: true, invertY: true, deadzone: 0.4, doubleTapClick: false, sensitivity: 2.5 };
      return { ...c, diagonals: false };
    });
    return l;
  });
  return sanitizeStore({ version: 1, activeId: 'old-1', layouts });
}

// ---- Static page checks ------------------------------------------------------------------------------------------------

describe('index.html, controller.css and the emitted script', () => {
  const html = read('index.html');
  const css = read('controller.css').replace(/\/\*[\s\S]*?\*\//g, '');
  /** Declarations of the first rule whose selector list contains `selector` exactly. */
  const rule = (selector: string): string => {
    let all = '';
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if ((m[1] as string).split(',').some((s) => s.trim() === selector)) all += m[2] as string; // every rule that names it, in order
    }
    if (!all) throw new Error('no css rule for ' + selector);
    return all;
  };
  const px = (selector: string, prop: string): number => Number(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(rule(selector))?.[1]);

  it('has the CSP, the iPhone meta tags and the icon link; no inline script, style or handlers', () => {
    expect(/Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
    );
    const viewport = /name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(viewport).toMatch(/viewport-fit=cover/);
    expect(viewport).toMatch(/user-scalable=no/);
    expect(html).toMatch(/name="theme-color"/);
    expect(html).toMatch(/name="apple-mobile-web-app-capable" content="yes"/);
    expect(html).toMatch(/name="mobile-web-app-capable" content="yes"/);
    expect(html).toMatch(/name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
    expect(html).toMatch(/name="apple-mobile-web-app-title" content="LanPlay"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="apple-touch-icon\.png">/);
    expect(html).not.toMatch(/rel="manifest"/);
    expect(html).toMatch(/<link rel="stylesheet" href="controller\.css">/);
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script src="controller.js" defer>']);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+\s*=|https?:\/\//i);
  });

  it('is an empty field, one menu button, Done, the card and the two overlays; nothing else', () => {
    document.body.innerHTML = BODY;
    expect(document.getElementById('field')?.children).toHaveLength(0);
    for (const id of ['field', 'menu', 'done', 'card', 'notice', 'rotate']) expect(document.getElementById(id), id).toBeTruthy();
    for (const gone of ['strip', 'panel', 'hint', 'fullscreen', 'edit', 'layout-pick', 'undo']) expect(document.getElementById(gone), gone).toBeNull();
    expect((document.getElementById('done') as HTMLElement).hidden).toBe(true);
    expect(menuEl().getAttribute('aria-label')).toBeTruthy();
    expect(document.querySelectorAll('input[type="range"]')).toHaveLength(0);
    expect(html).not.toMatch(/guide/i);
  });

  it('css: safe-area field, touch locks, big chrome targets, Done above everything, will-change on knobs only', () => {
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(rule('.field')).toMatch(/env\(safe-area-inset-left\)/);
    expect(rule('.field')).toMatch(/env\(safe-area-inset-right\)/);
    expect(rule('.field')).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/touch-action:\s*none/);
    expect(css).toMatch(/user-select:\s*none/);
    expect(css).toMatch(/-webkit-touch-callout:\s*none/);
    expect(css).toMatch(/overscroll-behavior:\s*none/);
    expect(css).toMatch(/orientation:\s*portrait/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(px('.menu', 'width')).toBeGreaterThanOrEqual(56);
    expect(px('.menu', 'height')).toBeGreaterThanOrEqual(52);
    expect(px('.done', 'width')).toBeGreaterThanOrEqual(108);
    expect(px('.done', 'height')).toBeGreaterThanOrEqual(52);
    const z = (sel: string): number => Number([...rule(sel).matchAll(/z-index:\s*(\d+)/g)].pop()?.[1] ?? 0); // the last declaration wins
    expect(z('.done')).toBeGreaterThan(z('.card'));
    expect(z('.done')).toBeGreaterThan(z('.menu'));
    expect(z('.card')).toBeGreaterThan(z('.field'));
    expect(px('.slider-track', 'height')).toBeGreaterThanOrEqual(44);
    expect(px('.slider-thumb', 'width')).toBeGreaterThanOrEqual(44);
    expect(px('.card-btn', 'height')).toBeGreaterThanOrEqual(44);
    expect([...css.matchAll(/will-change/g)]).toHaveLength(1);
    expect(rule('.stick-knob')).toMatch(/will-change:\s*transform/);
    expect(rule('.key.is-down')).toMatch(/transition:\s*none/); // press-in is instant
  });

  it('emits a classic script: no module syntax, no top-level declarations, no late runtime APIs, no rAF loop', () => {
    expect(script).not.toMatch(/^\s*(import|export)\s/m);
    expect(script).not.toMatch(/^await /m);
    expect(script).not.toMatch(/\.(findLast|findLastIndex|toSorted|toReversed|toSpliced|with|at|replaceAll|groupBy)\(/);
    expect(script).not.toMatch(/\b(structuredClone|Object\.hasOwn|AbortSignal\.any)\b/);
    expect(script).not.toMatch(/requestAnimationFrame|cancelAnimationFrame|getCoalescedEvents|wakeLock|requestFullscreen/);
    const body = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^"use strict";\s*/, '');
    expect(body.trimStart().startsWith('(() => {')).toBe(true);
  });

  it('never logs, never stores layouts on the phone, builds no HTML from strings', () => {
    const src = read('controller.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/console\./);
    expect([...src.matchAll(/localStorage/g)]).toHaveLength(2); // the name digits only, through two wrappers
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

// ---- Pure: layout store ------------------------------------------------------------------------------------------------

describe('coerceStore', () => {
  it('accepts the stock store unchanged', () => {
    expect(T.coerceStore(planStore())).toEqual(planStore());
  });
  it('rejects what has no usable layout and repairs what is merely sloppy', () => {
    for (const bad of [null, 5, 'x', [], {}, { layouts: [] }, { layouts: [{}] }, { layouts: [{ controls: 'no' }] }]) expect(T.coerceStore(bad), JSON.stringify(bad)).toBeNull();
    const s = T.coerceStore({ activeId: 'zzz', layouts: [{ id: 'a b', controls: [{ type: 'button', button: 'A', x: 500, w: -3 }, { type: 'nope' }, 7, { type: 'button', button: 'Z' }, { type: 'dpad', id: 'dpad', size: 'big' }] }] });
    expect(s.activeId).toBe('a-b');
    expect(s.layouts[0].controls).toHaveLength(2);
    expect(s.layouts[0].controls[0]).toMatchObject({ type: 'button', button: 'A', x: 100, w: LIMITS.size.min });
    expect(s.layouts[0].controls[1]).toMatchObject({ type: 'dpad', size: 26 });
  });
  it('forces the fixed values and keeps everything the simple editor does not touch', () => {
    const s = T.coerceStore(oldStore()) as LayoutStore;
    expect(s.layouts).toHaveLength(LIMITS.layouts); // extras are kept, untouched
    expect(s.activeId).toBe('old-1');
    for (const l of s.layouts) {
      for (const c of l.controls) {
        if (c.type === 'button') expect(c).toMatchObject({ latch: false, turbo: false, value: 255 });
        if (c.type === 'stick') expect(c).toMatchObject({ mode: 'fixed', curve: 'linear', invertX: false, invertY: false, deadzone: 0.1, doubleTapClick: true, sensitivity: 2.5 });
        if (c.type === 'dpad') expect(c.diagonals).toBe(true);
      }
    }
    const a = s.layouts[0]?.controls.find((c) => c.id === 'btn-a');
    expect(a).toMatchObject({ label: 'Jump', shape: 'circle', w: 16, h: 16 }); // shape and label render as stored
    fixedPoint(s);
  });
});

describe('layout operations', () => {
  const base = (): LayoutStore => planStore();
  const ctrl = (s: LayoutStore, id: string): Any => T.activeLayout(s).controls.find((c: { id: string }) => c.id === id);

  it('every result is a fixed point of the host sanitizer', () => {
    let s = base();
    const steps: Array<(s: LayoutStore) => LayoutStore> = [
      (x) => T.moveControl(x, 'btn-a', 12.3456, 98.7654),
      (x) => T.setSize(x, 'btn-a', 17.77),
      (x) => T.setSize(x, 'stick-left', 41.234),
      (x) => T.setSize(x, 'dpad', 30.5),
      (x) => T.setOpacity(x, 'btn-b', 0.555),
      (x) => T.setSensitivity(x, 1.2345),
      (x) => T.addSlot(x, T.activeLayout(planStore())),
      (x) => T.setHaptics(x, false),
      (x) => T.setSensitivity(x, 0.5),
      (x) => T.resetLayout(x, x.activeId, T.activeLayout(planStore())),
      (x) => T.switchLayout(x, 'default'),
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
    T.setSize(s, 'btn-a', 20);
    T.setOpacity(s, 'btn-a', 0.5);
    T.setHaptics(s, false);
    T.addSlot(s, T.activeLayout(s));
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(T.moveControl(s, 'nope', 1, 1)).toBe(s);
    expect(T.moveControl(s, 'btn-a', Number.NaN, 1)).toBe(s);
    expect(T.setSize(s, 'btn-a', 16)).toBe(s);
    expect(T.setSize(s, 'nope', 16)).toBe(s);
    expect(T.setOpacity(s, 'btn-a', 0.8)).toBe(s);
    expect(T.setSensitivity(s, 1)).toBe(s);
    expect(T.setHaptics(s, true)).toBe(s);
    expect(T.switchLayout(s, 'default')).toBe(s);
    expect(T.switchLayout(s, 'missing')).toBe(s);
  });

  it('Size ranges: sticks 24-60, d-pad 18-45, buttons 8-30 (height), widened for stored values', () => {
    expect(ctrl(T.setSize(base(), 'stick-left', 5), 'stick-left').size).toBe(24);
    expect(ctrl(T.setSize(base(), 'stick-left', 500), 'stick-left').size).toBe(60);
    expect(ctrl(T.setSize(base(), 'dpad', 1), 'dpad').size).toBe(18);
    expect(ctrl(T.setSize(base(), 'dpad', 99), 'dpad').size).toBe(45);
    expect(ctrl(T.setSize(base(), 'btn-a', 1), 'btn-a').h).toBe(8);
    expect(ctrl(T.setSize(base(), 'btn-a', 99), 'btn-a').h).toBe(30);
    const big = T.setSize(base(), 'stick-left', 60); // fine
    expect(T.sizeRange(ctrl(big, 'stick-left'))).toEqual({ min: 24, max: 60 });
    const odd = { ...ctrl(base(), 'stick-left'), size: 75 };
    expect(T.sizeRange(odd)).toEqual({ min: 24, max: 75 });
    const tiny = { ...ctrl(base(), 'btn-a'), h: 5 };
    expect(T.sizeRange(tiny)).toEqual({ min: 5, max: 30 });
    expect(T.opacityRange({ ...ctrl(base(), 'btn-a'), opacity: 0.1 })).toEqual({ min: 0.1, max: 1 });
    expect(T.opacityRange(ctrl(base(), 'btn-a'))).toEqual({ min: 0.2, max: 1 });
  });

  it('buttons scale width and height together, keeping the ratio of the moment the slider was grabbed', () => {
    const lt = ctrl(base(), 'btn-lt'); // 22 x 13
    const k = lt.w / lt.h;
    let s = base();
    for (const v of [14, 15, 16, 17, 18, 20, 25, 28]) s = T.setSize(s, 'btn-lt', v, k);
    const out = ctrl(s, 'btn-lt');
    expect(out.h).toBe(28);
    expect(out.w).toBeCloseTo(28 * k, 1);
    expect(ctrl(T.setSize(base(), 'btn-a', 24), 'btn-a')).toMatchObject({ w: 24, h: 24 });
  });

  it('opacity 0.2-1 and sticks sensitivity 0.5-2 on the active layout only; haptics on every layout', () => {
    expect(ctrl(T.setOpacity(base(), 'btn-a', 0), 'btn-a').opacity).toBe(0.2);
    expect(ctrl(T.setOpacity(base(), 'btn-a', 9), 'btn-a').opacity).toBe(1);
    let s = T.addSlot(base(), planLayoutRaw()); // second layout, active
    s = T.setSensitivity(s, 1.7);
    const sticks = (l: Any) => l.controls.filter((c: { type: string }) => c.type === 'stick').map((c: { sensitivity: number }) => c.sensitivity);
    expect(sticks(s.layouts[1])).toEqual([1.7, 1.7]);
    expect(sticks(s.layouts[0])).toEqual([1, 1]);
    expect(sticks(T.setSensitivity(s, 99).layouts[1])).toEqual([2, 2]);
    expect(sticks(T.setSensitivity(s, 0).layouts[1])).toEqual([0.5, 0.5]);
    const off = T.setHaptics(s, false);
    expect(off.layouts.map((l: { haptics: boolean }) => l.haptics)).toEqual([false, false]);
  });

  it('moves inside the screen', () => {
    const s = T.moveControl(base(), 'btn-a', -50, 500, 2.17);
    const a = ctrl(s, 'btn-a');
    const [hx, hy] = T.halfExtent(a, 2.17) as [number, number];
    expect(a.x).toBeCloseTo(hx, 1);
    expect(a.y).toBeCloseTo(100 - hy, 1);
  });

  it('a new slot is a copy of the stock layout that inherits haptics and stick sensitivity; Reset keeps them', () => {
    let s = T.setHaptics(T.setSensitivity(base(), 1.6), false);
    s = T.addSlot(s, planStore().layouts[0]);
    expect(s.layouts).toHaveLength(2);
    expect(s.activeId).toBe(s.layouts[1].id);
    expect(s.layouts[1].id).not.toBe('default');
    expect(s.layouts[1].haptics).toBe(false);
    expect(T.layoutSensitivity(s.layouts[1])).toBe(1.6);
    const moved = T.moveControl(s, 'btn-a', 10, 10);
    const reset = T.resetLayout(moved, moved.activeId, planStore().layouts[0]);
    expect(ctrl(reset, 'btn-a')).toMatchObject({ x: 85, y: 76.5 });
    expect(T.layoutSensitivity(T.activeLayout(reset))).toBe(1.6);
    expect(T.activeLayout(reset).haptics).toBe(false);
    let many = base();
    while (many.layouts.length < LIMITS.layouts) many = T.addSlot(many, planStore().layouts[0]);
    expect(T.addSlot(many, planStore().layouts[0])).toBe(many);
  });
});

describe('placeCard', () => {
  const sizes = [T0(), T1()];
  function T0() {
    return { w: 280, h: 136 };
  }
  function T1() {
    return { w: 300, h: 168 };
  }
  it('never covers the selected control, for any position of any default-sized control, in both landscape sizes', () => {
    for (const field of [{ w: 874, h: 402 }, { w: 874, h: 320 }]) {
      const u = field.h / 100;
      for (const card of sizes) {
        for (const [bw, bh] of [[16, 16], [22, 13], [14, 10], [38, 38], [26, 26], [60, 60], [30, 30]] as const) {
          for (let cx = (bw * u) / 2; cx <= field.w - (bw * u) / 2; cx += 37) {
            for (let cy = (bh * u) / 2; cy <= field.h - (bh * u) / 2; cy += 29) {
              const box = { cx, cy, hw: (bw * u) / 2, hh: (bh * u) / 2 };
              for (const top of [8, 62]) {
              const p = T.placeCard(box, card, field, 8, top) as { x: number; y: number };
              const covers = Math.abs(p.x - cx) < card.w / 2 + box.hw && Math.abs(p.y - cy) < card.h / 2 + box.hh;
              expect(covers, JSON.stringify({ field, card, box, p })).toBe(false);
              expect(p.x - card.w / 2).toBeGreaterThanOrEqual(0);
              expect(p.x + card.w / 2).toBeLessThanOrEqual(field.w);
              expect(p.y - card.h / 2).toBeGreaterThanOrEqual(0);
              expect(p.y + card.h / 2).toBeLessThanOrEqual(field.h);
              expect(p.y - card.h / 2).toBeGreaterThanOrEqual(top); // never under the Done button
              }
            }
          }
        }
      }
    }
  });
  it('settings card: covers no stock control in either landscape size, stays below Done, centred horizontally', () => {
    for (const field of [{ w: 750, h: 381 }, { w: 750, h: 299 }, { w: 874, h: 402 }]) {
      const u = field.h / 100;
      const boxes = T.activeLayout(planStore()).controls.map((c: Any) => {
        const [w, hh] = T.controlBox(c) as [number, number];
        return { cx: (c.x / 100) * field.w, cy: (c.y / 100) * field.h, hw: (w * u) / 2, hh: (hh * u) / 2 };
      });
      const p = T.placeSettingsCard(boxes, T1(), field, 60) as { x: number; y: number };
      expect(p.x).toBe(field.w / 2);
      expect(p.y - 84).toBeGreaterThanOrEqual(60);
      expect(p.y + 84).toBeLessThanOrEqual(field.h);
      const hit = boxes.filter((b: Any) => Math.abs(p.x - b.cx) < 150 + b.hw && Math.abs(p.y - b.cy) < 84 + b.hh);
      if (field.h > 300) expect(hit, JSON.stringify(field)).toEqual([]);
    }
    // nothing in the way: the middle
    expect(T.placeSettingsCard([], T1(), { w: 874, h: 402 }, 60)).toEqual({ x: 437, y: 201 });
  });
  it('is centred when nothing is in the way and jumps to the opposite half otherwise', () => {
    const field = { w: 874, h: 402 };
    expect(T.placeCard({ cx: 60, cy: 60, hw: 20, hh: 20 }, T0(), field)).toEqual({ x: 437, y: 201 });
    const right = T.placeCard({ cx: 437, cy: 201, hw: 30, hh: 30 }, T0(), field);
    expect(right.x).not.toBe(437);
    const leftCtl = T.placeCard({ cx: 330, cy: 201, hw: 60, hh: 60 }, T0(), field);
    expect(leftCtl.x).toBeGreaterThan(437);
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
    expect(T.stickAxes(R * 9, 0, R, P())).toEqual({ x: 32767, y: 0 });
  });
  it('rescales after the dead zone, applies curves and sensitivity, inverts', () => {
    const dz = 0.2;
    expect(T.stickAxes(R * (dz + (1 - dz) / 2), 0, R, P({ deadzone: dz })).x).toBe(Math.round(0.5 * 32767));
    const at = (curve: string) => T.stickAxes(R / 2, 0, R, P({ deadzone: 0, curve })).x as number;
    expect([at('linear'), at('precise'), at('aggressive')]).toEqual([Math.round(0.5 * 32767), Math.round(0.25 * 32767), Math.round(Math.sqrt(0.5) * 32767)]);
    expect(T.stickAxes(R / 4, 0, R, P({ deadzone: 0, sensitivity: 2 })).x).toBe(Math.round(0.5 * 32767));
    expect(T.stickAxes(R / 2, 0, R, P({ deadzone: 0, sensitivity: 3 })).x).toBe(32767);
    expect(T.stickAxes(R, -R, R, P({ deadzone: 0, invertX: true }))).toMatchObject({ x: -23170, y: 23170 });
    expect(T.stickAxes(0, -R, R, P({ invertY: true }))).toEqual({ x: 0, y: -32767 });
  });
  it('never returns negative zero', () => {
    for (let a = 0; a < 360; a += 15) {
      const v = T.stickAxes(Math.cos((a * Math.PI) / 180) * R, Math.sin((a * Math.PI) / 180) * R, R, P({ deadzone: 0 })) as { x: number; y: number };
      expect(Object.is(v.x, -0) || Object.is(v.y, -0)).toBe(false);
    }
  });
  it('deflection is the raw pull 0..1', () => {
    expect(T.deflection(0, 0, 50)).toBe(0);
    expect(T.deflection(25, 0, 50)).toBe(0.5);
    expect(T.deflection(500, 0, 50)).toBe(1);
    expect(T.deflection(5, 5, 0)).toBe(0);
  });
});

describe('dpadMask', () => {
  const half = 75;
  const at = (deg: number, diagonals = true, r = 60): number => T.dpadMask(Math.cos((deg * Math.PI) / 180) * r, -Math.sin((deg * Math.PI) / 180) * r, half, diagonals);
  const [UP, DOWN, LEFT, RIGHT] = [BTN.DPAD_UP, BTN.DPAD_DOWN, BTN.DPAD_LEFT, BTN.DPAD_RIGHT];
  it('has a dead centre and eight directions with 60 degree cardinals', () => {
    expect(T.dpadMask(0, 0, half)).toBe(0);
    expect(T.dpadMask(5, -5, half)).toBe(0);
    expect([at(0), at(90), at(180), at(270)]).toEqual([RIGHT, UP, LEFT, DOWN]);
    expect([at(45), at(135), at(225), at(315)]).toEqual([UP | RIGHT, UP | LEFT, DOWN | LEFT, DOWN | RIGHT]);
    expect([at(25), at(-25), at(65), at(115)]).toEqual([RIGHT, RIGHT, UP, UP]);
  });
  it('without diagonals it is strictly four-way', () => {
    for (let deg = 0; deg < 360; deg += 5) expect([UP, DOWN, LEFT, RIGHT]).toContain(at(deg, false));
  });
});

describe('buildPad, samePad, timing helpers', () => {
  const z = { x: 0, y: 0 };
  it('ORs button bits, triggers are 255, nothing but the d-pad bits passes through', () => {
    const pad = T.buildPad(['A', 'LB', 'LT', 'RT', 'L3'], BTN.DPAD_LEFT, { x: -5, y: 9 }, z);
    expect(pad).toEqual({ b: BTN.A | BTN.LEFT_SHOULDER | BTN.LEFT_THUMB | BTN.DPAD_LEFT, lt: 255, rt: 255, lx: -5, ly: 9, rx: 0, ry: 0 });
    expect(pad.b & BTN.GUIDE).toBe(0);
    expect(T.buttonMask(['A', 'LT', 'nope'], 0xffff)).toBe(BTN.A | BTN.DPAD_UP | BTN.DPAD_DOWN | BTN.DPAD_LEFT | BTN.DPAD_RIGHT);
  });
  it('samePad compares every field', () => {
    const base = { b: 1, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
    expect(T.samePad(null, base)).toBe(false);
    expect(T.samePad({ ...base }, base)).toBe(true);
    for (const k of Object.keys(base)) expect(T.samePad({ ...base, [k]: 7 }, base), k).toBe(false);
  });
  it('releaseDelay is the rest of the 24 ms minimum press', () => {
    expect(T.releaseDelay(1000, 1000)).toBe(24);
    expect(T.releaseDelay(1000, 1010)).toBe(14);
    expect(T.releaseDelay(1000, 1024)).toBe(0);
    expect(T.releaseDelay(1000, 5000)).toBe(0);
  });
  it('detects a double tap within 300 ms', () => {
    expect(T.isDoubleTap(null, 1000)).toBe(false);
    expect(T.isDoubleTap(1000, 1300)).toBe(true);
    expect(T.isDoubleTap(1000, 1301)).toBe(false);
    expect(T.isDoubleTap(1000, 900)).toBe(false);
  });
});

// ---- Pure: haptic decisions --------------------------------------------------------------------------------------------

describe('haptic decisions', () => {
  it('picks the platform: vibrate -> android; iOS without it -> ios; otherwise none', () => {
    expect(T.hapticMode(IPHONE_UA, 5, true)).toBe('android');
    expect(T.hapticMode(IPHONE_UA, 5, false)).toBe('ios');
    expect(T.hapticMode('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 5, false)).toBe('ios'); // iPadOS
    expect(T.hapticMode('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 0, false)).toBe('none');
    expect(T.hapticMode('Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0', 0, false)).toBe('none');
  });

  it('Android pulse table: none under 0.15; 6/140, 10/110, 16/90, 24/80', () => {
    expect(T.androidPattern(0)).toBeNull();
    expect(T.androidPattern(0.149)).toBeNull();
    expect(T.androidPattern(0.15)).toEqual({ pulse: 6, period: 140 });
    expect(T.androidPattern(0.399)).toEqual({ pulse: 6, period: 140 });
    expect(T.androidPattern(0.4)).toEqual({ pulse: 10, period: 110 });
    expect(T.androidPattern(0.649)).toEqual({ pulse: 10, period: 110 });
    expect(T.androidPattern(0.65)).toEqual({ pulse: 16, period: 90 });
    expect(T.androidPattern(0.899)).toEqual({ pulse: 16, period: 90 });
    expect(T.androidPattern(0.9)).toEqual({ pulse: 24, period: 80 });
    expect(T.androidPattern(1)).toEqual({ pulse: 24, period: 80 });
    let prev = 0;
    for (let d = 0.15; d <= 1; d += 0.01) {
      const p = T.androidPattern(d) as { pulse: number; period: number };
      expect(p.pulse).toBeGreaterThanOrEqual(prev); // stronger the farther it is pulled
      prev = p.pulse;
    }
  });

  it('Android clock: pulse when due, wait otherwise, cancel (0) once on release', () => {
    let s = { active: false, nextAt: 0, pulse: 0 };
    let r = T.androidStickStep(s, 0.5, 1000);
    expect(r).toMatchObject({ vibrate: 10, wait: 110 });
    s = r.s;
    r = T.androidStickStep(s, 0.5, 1050);
    expect(r).toMatchObject({ vibrate: null, wait: 60 });
    r = T.androidStickStep(r.s, 0.5, 1110);
    expect(r.vibrate).toBe(10);
    // pulled harder inside a period: the stronger pulse starts at once; weaker waits
    const harder = T.androidStickStep(r.s, 0.95, 1115);
    expect(harder).toMatchObject({ vibrate: 24, wait: 80 });
    expect(T.androidStickStep(harder.s, 0.5, 1120)).toMatchObject({ vibrate: null });
    r = T.androidStickStep(r.s, 0.05, 1120);
    expect(r).toMatchObject({ vibrate: 0, wait: null });
    expect(T.androidStickStep(r.s, 0.05, 1130)).toMatchObject({ vibrate: null, wait: null });
  });

  it('iOS strength is rate: none under 0.2, 4 Hz rising to 18 Hz, never faster than every 55 ms', () => {
    expect(T.iosStickInterval(0.19)).toBeNull();
    expect(T.iosStickInterval(0.2)).toBeCloseTo(250, 5);
    expect(T.iosStickInterval(1)).toBeCloseTo(1000 / 18, 0);
    expect(T.iosStickInterval(1)).toBeGreaterThanOrEqual(55);
    let prev = Infinity;
    for (let d = 0.2; d <= 1; d += 0.05) {
      const iv = T.iosStickInterval(d) as number;
      expect(iv).toBeLessThanOrEqual(prev);
      expect(iv).toBeGreaterThanOrEqual(55);
      prev = iv;
    }
  });

  it('iOS gate: sticks wait for their interval and the global 25 ms; buttons obey only the 25 ms', () => {
    const gate = { lastAny: 1000, nextStickDue: 1100 };
    expect(T.iosStickDecision(gate, 0.1, 2000)).toEqual({ fire: false, wait: null });
    expect(T.iosStickDecision(gate, 1, 1050)).toMatchObject({ fire: false, wait: 50 });
    expect(T.iosStickDecision(gate, 1, 1100).fire).toBe(true);
    expect(T.iosStickDecision({ lastAny: 1090, nextStickDue: 1000 }, 1, 1100)).toMatchObject({ fire: false, wait: 15 });
    expect(T.buttonTickAllowed(gate, 1024)).toBe(false);
    expect(T.buttonTickAllowed(gate, 1025)).toBe(true);
  });
});

describe('createHaptics with fake sinks', () => {
  function rig(mode: 'android' | 'ios' | 'none', enabled = () => true) {
    const calls: Array<[string, number]> = [];
    const hz = T.createHaptics({
      mode,
      enabled: () => enabled(),
      vibrate: (ms: number) => calls.push(['vibrate', ms]),
      iosTick: () => calls.push(['tick', Date.now()]),
      now: () => Date.now(),
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimer: (hd: unknown) => clearTimeout(hd as ReturnType<typeof setTimeout>),
    });
    return { hz, calls };
  }

  it('Android: a press is vibrate(10)', () => {
    const { hz, calls } = rig('android');
    hz.tick();
    hz.tick();
    expect(calls).toEqual([['vibrate', 10], ['vibrate', 10]]);
  });

  it('Android stick: pulse on entering a bracket, re-issued by the clock each period, a stronger pull starts at once, cancel on release', () => {
    const { hz, calls } = rig('android');
    hz.setStick(0.1);
    expect(calls).toEqual([]);
    hz.setStick(0.5); // 10 ms / 110 ms
    expect(calls).toEqual([['vibrate', 10]]);
    hz.setStick(0.5);
    hz.setStick(0.55);
    expect(calls).toHaveLength(1); // no re-issue inside the period
    vi.advanceTimersByTime(110);
    expect(calls).toEqual([['vibrate', 10], ['vibrate', 10]]);
    hz.setStick(0.95); // a stronger pull starts at once
    expect(calls.at(-1)).toEqual(['vibrate', 24]);
    vi.advanceTimersByTime(80);
    expect(calls.at(-1)).toEqual(['vibrate', 24]);
    vi.advanceTimersByTime(80);
    expect(calls.at(-1)).toEqual(['vibrate', 24]);
    const n = calls.length;
    hz.setStick(0.05); // back inside the dead area: cancel, once
    expect(calls.slice(n)).toEqual([['vibrate', 0]]);
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(n + 1);
    hz.setStick(0);
    expect(calls).toHaveLength(n + 1);
  });

  it('Android stop() cancels a running pulse train and clears the clock', () => {
    const { hz, calls } = rig('android');
    hz.setStick(0.8);
    hz.stop();
    expect(calls.at(-1)).toEqual(['vibrate', 0]);
    const n = calls.length;
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(n);
  });

  it('haptics off: silent everywhere, including the stick ramp and its cancel', () => {
    let on = true;
    const { hz, calls } = rig('android', () => on);
    hz.setStick(0.8);
    expect(calls).toHaveLength(1);
    on = false;
    hz.tick();
    hz.setStick(0.9); // turning off mid-pull cancels the train and stays quiet afterwards
    const after = calls.length;
    vi.advanceTimersByTime(1000);
    hz.setStick(1);
    hz.tick();
    expect(calls.slice(after)).toEqual([]);
    const ios = rig('ios', () => false);
    ios.hz.tick();
    ios.hz.setStick(1);
    vi.advanceTimersByTime(500);
    expect(ios.calls).toEqual([]);
  });

  it('two sticks use the larger deflection (the page passes the max)', () => {
    const { hz, calls } = rig('android');
    hz.setStick(Math.max(0.3, 0.95));
    expect(calls).toEqual([['vibrate', 24]]);
  });

  it('iOS: a tick per press, capped at one per 25 ms', () => {
    const { hz, calls } = rig('ios');
    hz.tick();
    hz.tick();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(25);
    hz.tick();
    expect(calls).toHaveLength(2);
  });

  /** A finger streaming pointermoves at 120 Hz (iPhone 17 ProMotion) for `ms`, at deflection d. */
  function stream(hz: { setStick(d: number): void }, d: number, ms: number): void {
    for (let t = 0; t < ms; t += 8) {
      vi.advanceTimersByTime(8);
      hz.setStick(d);
    }
  }

  it('iOS stick: nothing under 0.2; 4 Hz at 0.2 rising to about 18 Hz at full, ticked only from input events', () => {
    const slow = rig('ios');
    slow.hz.setStick(0.1);
    stream(slow.hz, 0.1, 1000);
    expect(slow.calls).toEqual([]);
    slow.hz.setStick(0.2);
    expect(slow.calls).toHaveLength(1); // synchronous when due
    stream(slow.hz, 0.2, 1000);
    expect(slow.calls.length).toBeGreaterThanOrEqual(4);
    expect(slow.calls.length).toBeLessThanOrEqual(6);

    const fast = rig('ios');
    stream(fast.hz, 1, 1000);
    expect(fast.calls.length).toBeGreaterThanOrEqual(15);
    expect(fast.calls.length).toBeLessThanOrEqual(19);
    const times = fast.calls.map((c) => c[1]);
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(55);
  });

  it('iOS arms NO timer: WebKit plays the switch haptic only inside a user gesture, so a timer tick could never be felt', () => {
    const timers: number[] = [];
    const calls: string[] = [];
    const hz = T.createHaptics({
      mode: 'ios',
      enabled: () => true,
      vibrate: () => calls.push('vibrate'),
      iosTick: () => calls.push('tick'),
      now: () => Date.now(),
      setTimer: (_fn: () => void, ms: number) => timers.push(ms),
      clearTimer: () => undefined,
    });
    hz.setStick(1);
    stream(hz, 1, 500);
    hz.tick();
    expect(timers).toEqual([]);
    const n = calls.length;
    vi.advanceTimersByTime(2000); // a still finger: no events, so no ticks
    expect(calls).toHaveLength(n);
  });

  it('Android keeps ONE timer while a stick streams moves (no clear/set per pointermove)', () => {
    let sets = 0;
    const hz = T.createHaptics({
      mode: 'android',
      enabled: () => true,
      vibrate: () => undefined,
      iosTick: () => undefined,
      now: () => Date.now(),
      setTimer: (fn: () => void, ms: number) => {
        sets++;
        return setTimeout(fn, ms);
      },
      clearTimer: (hd: unknown) => clearTimeout(hd as ReturnType<typeof setTimeout>),
    });
    hz.setStick(0.5); // 10 ms every 110 ms
    stream(hz, 0.5, 1000);
    expect(sets).toBeLessThanOrEqual(11); // one per pulse period, not one per move (125)
    hz.stop();
  });

  it('iOS: moves that arrive before the next tick is due do not tick; a button tick pushes the stick back', () => {
    const { hz, calls } = rig('ios');
    hz.setStick(1);
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(3);
      hz.setStick(1); // pointermove storm
    }
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(30);
    hz.tick(); // a button press, allowed (more than 25 ms since the last tick)
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(24);
    expect(calls).toHaveLength(2); // the stick waited for the global 25 ms
  });

  it('never throws when a sink throws or when the platform has no haptics', () => {
    const bad = T.createHaptics({
      mode: 'android',
      enabled: () => true,
      vibrate: () => {
        throw new Error('blocked');
      },
      iosTick: () => {
        throw new Error('blocked');
      },
      now: () => Date.now(),
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimer: (hd: unknown) => clearTimeout(hd as ReturnType<typeof setTimeout>),
    });
    expect(() => {
      bad.tick();
      bad.setStick(1);
      vi.advanceTimersByTime(300);
      bad.stop();
    }).not.toThrow();
    const none = rig('none');
    none.hz.tick();
    none.hz.setStick(1);
    vi.advanceTimersByTime(300);
    expect(none.calls).toEqual([]);
  });
});

describe('protocol helpers', () => {
  it('backoffDelay doubles from 500 ms and caps at 5 s', () => {
    expect([0, 1, 2, 3, 4, 5, 50, 5000].map((n) => T.backoffDelay(n))).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);
    expect(T.backoffDelay(-3)).toBe(500);
  });
  it('names the device and survives the host-side sanitiser unchanged', () => {
    const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
    expect(T.deviceLabel(IPHONE_UA, 5)).toBe('iPhone');
    expect(T.deviceLabel(PIXEL, 5)).toBe('Android phone');
    for (const ua of [IPHONE_UA, PIXEL]) {
      const name = T.playerName(ua, 5, 47) as string;
      expect(name).toMatch(/^[A-Za-z ]+ \d{2}$/);
      expect(name.length).toBeLessThanOrEqual(MAX_NAME_CHARS);
      expect(sanitizePlayerName(name)).toBe(name);
    }
  });
  it('builds the socket URL and parses host messages', () => {
    expect(T.wsUrl({ protocol: 'http:', host: '192.168.1.20:47921' }, 'abc')).toBe('ws://192.168.1.20:47921/ws?t=abc');
    expect(T.wsUrl({ protocol: 'https:', host: 'pc:1' }, 'a b&c')).toBe('wss://pc:1/ws?t=a%20b%26c');
    expect(T.parseServerMessage('{"t":"welcome","slot":3}')).toEqual({ t: 'welcome', slot: 3 });
    expect(T.parseServerMessage('{"t":"full"}')).toEqual({ t: 'full' });
    expect(T.parseServerMessage('{"t":"kicked"}')).toEqual({ t: 'kicked' });
    for (const bad of ['', 'nope', '[]', '{"t":"welcome","slot":0}', '{"t":"welcome","slot":2.5}', '{"t":"x"}', 5, null, 'x'.repeat(600)]) expect(T.parseServerMessage(bad)).toBeNull();
  });
  it('has the exact notice strings', () => {
    expect(T.statusText('connecting', null)).toBe('Connecting…');
    expect(T.statusText('connected', 2)).toBe('Player 2');
    expect(T.statusText('retrying', null)).toBe('Disconnected — retrying…');
    expect(T.statusText('full', null)).toBe('All 4 player slots are taken');
    expect(T.statusText('kicked', null)).toBe('Removed from this PC');
    expect(T.statusText('notoken', null)).toBe('Open the link or QR code from the LanPlay host screen');
  });
});

// ---- Layout geometry ---------------------------------------------------------------------------------------------------

describe('the stock layout fits the safe rectangle without overlaps', () => {
  for (const [w, hgt] of [[874, 402], [874, 320]] as const) {
    it(`at ${w}x${hgt}`, () => {
      const u = hgt / 100;
      const boxes = (planStore().layouts[0]?.controls ?? []).map((c) => {
        const [bw, bh] = T.controlBox(c) as [number, number];
        return { id: c.id, l: (c.x / 100) * w - (bw * u) / 2, r: (c.x / 100) * w + (bw * u) / 2, t: (c.y / 100) * hgt - (bh * u) / 2, b: (c.y / 100) * hgt + (bh * u) / 2 };
      });
      expect(boxes).toHaveLength(13);
      for (const b of boxes) {
        expect(b.l, b.id).toBeGreaterThanOrEqual(0);
        expect(b.t, b.id).toBeGreaterThanOrEqual(0);
        expect(b.r, b.id).toBeLessThanOrEqual(w);
        expect(b.b, b.id).toBeLessThanOrEqual(hgt);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i] as (typeof boxes)[number];
          const b = boxes[j] as (typeof boxes)[number];
          expect(a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b, `${a.id} overlaps ${b.id}`).toBe(false);
        }
      }
    });
  }
});

// ---- The running page: loading -----------------------------------------------------------------------------------------

describe('without a token', () => {
  it('shows the instruction, never opens a socket and never asks the host for layouts', async () => {
    h = await mount({ token: null });
    expect(FakeSocket.all).toHaveLength(0);
    expect(host.calls).toHaveLength(0);
    expect(noticeVisible()).toBe(true);
    expect(document.getElementById('notice-text')?.textContent).toBe('Open the link or QR code from the LanPlay host screen');
    expect(menuEl().hidden).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('loading the layout', () => {
  it('GETs /api/layouts with the token and draws exactly the active layout inside the field', async () => {
    h = await mount();
    expect(host.calls[0]).toMatchObject({ method: 'GET', path: '/api/layouts', token: 'tok-123' });
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(13);
    const a = h.ctl('btn-a');
    expect(a.style.left).toBe('85%');
    expect(a.style.top).toBe('76.5%');
    expect(a.style.getPropertyValue('--w')).toBe('16');
    expect(a.dataset['button']).toBe('A');
    expect(a.getAttribute('aria-label')).toBe('A button');
    expect(h.ctl('btn-start').textContent).toBe('Start');
    expect(h.ctl('stick-left').getAttribute('aria-label')).toBe('Left stick');
    expect(document.documentElement.style.getPropertyValue('--u')).toBe((402 / 100).toFixed(4) + 'px');
    expect(menuEl().hidden).toBe(false);
    expect(doneEl().hidden).toBe(true);
  });

  it('the menu dot follows the connection: amber, green, red; the slot shows beside it', async () => {
    h = await mount({ welcome: false });
    expect(menuEl().dataset['state']).toBe('connecting');
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 3 });
    expect(menuEl().dataset['state']).toBe('connected');
    expect(document.getElementById('menu-slot')?.textContent).toBe('P3');
    expect(menuEl().getAttribute('aria-label')).toBe('Menu, Player 3');
    h.ws().drop();
    expect(menuEl().dataset['state']).toBe('retrying');
  });

  it('a failed first GET shows "Cannot load your layout" with Retry and invents nothing', async () => {
    host.getStatus = 500;
    h = await mount();
    expect(noticeVisible()).toBe(true);
    expect(document.getElementById('notice-text')?.textContent).toBe('Cannot load your layout');
    expect((document.getElementById('retry') as HTMLElement).hidden).toBe(false);
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(0);
    host.getStatus = 200;
    tapAt(document.getElementById('retry') as Element);
    await settle();
    expect(noticeVisible()).toBe(false);
    expect(document.querySelectorAll('#field [data-cid]')).toHaveLength(13);
  });

  it('treats a 200 with garbage as a failure, and a page without a layout sends only neutral state', async () => {
    host.store = { nonsense: true } as Any;
    h = await mount();
    expect(document.getElementById('notice-text')?.textContent).toBe('Cannot load your layout');
    ptr(document.getElementById('field') as Element, 'pointerdown', 1, 10, 10);
    expect(h.ws().states().every((s) => s.buttons === 0)).toBe(true);
  });
});

describe('connecting', () => {
  it('opens ws://host/ws?t=token, hello first, the neutral state right after welcome', async () => {
    h = await mount({ welcome: false });
    expect(h.ws().url).toBe(SOCKET_URL('tok-123'));
    h.ws().open();
    expect(h.ws().frames()).toEqual([{ t: 'hello', name: expect.stringMatching(/^Phone \d{2}$/) }]);
    h.ws().receive({ t: 'welcome', slot: 2 });
    expect(h.ws().states()).toEqual([NEUTRAL]);
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

// ---- Play: buttons and send timing -------------------------------------------------------------------------------------

describe('play: every control sends the right bit, from inside the handler', () => {
  beforeEach(async () => {
    h = await mount();
  });

  it('sends nothing while nothing changes; each edge is sent synchronously with the full state', () => {
    const base = h.ws().sent.length;
    vi.advanceTimersByTime(100);
    expect(h.ws().sent.length).toBe(base + 0 + h.ws().count('k')); // only keepalives
    const n = h.ws().count('s');
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(h.ws().count('s')).toBe(n + 1); // already sent when the handler returned: no frame loop
    expect(h.ws().states().at(-1)).toEqual({ ...NEUTRAL, buttons: BTN.A });
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(true);
    expect(JSON.parse(h.ws().sent.at(-1) as string)).toEqual({ t: 's', b: BTN.A, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
  });

  it('each of the ten buttons sends its own bit; digital triggers send 255', () => {
    const expected: Array<[string, Partial<PadState>]> = [
      ['btn-a', { buttons: BTN.A }],
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
      expect(h.ws().states().at(-1), id).toMatchObject({ ...NEUTRAL, ...want });
      vi.advanceTimersByTime(30);
      ptr(h.ctl(id), 'pointerup', 9);
      expect(h.ws().states().at(-1), id).toEqual(NEUTRAL);
      vi.advanceTimersByTime(30);
    }
  });

  it('a release within 24 ms of the press is deferred by the remainder: the host sees a press of at least 24 ms', () => {
    ptr(h.ctl('btn-y'), 'pointerdown', 1);
    ptr(h.ctl('btn-y'), 'pointerup', 1); // same task
    const pressed = h.ws().stateTimes().at(-1) as number;
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.Y);
    expect(h.ctl('btn-y').classList.contains('is-down')).toBe(true);
    vi.advanceTimersByTime(23);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.Y);
    vi.advanceTimersByTime(1);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    expect((h.ws().stateTimes().at(-1) as number) - pressed).toBeGreaterThanOrEqual(24);
    expect(h.ctl('btn-y').classList.contains('is-down')).toBe(false);
    // a longer press releases at once
    ptr(h.ctl('btn-y'), 'pointerdown', 2);
    vi.advanceTimersByTime(40);
    ptr(h.ctl('btn-y'), 'pointerup', 2);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
  });

  it('pressing again while a release is still deferred keeps the button down', () => {
    ptr(h.ctl('btn-y'), 'pointerdown', 1);
    ptr(h.ctl('btn-y'), 'pointerup', 1);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('btn-y'), 'pointerdown', 2);
    vi.advanceTimersByTime(100);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.Y);
    ptr(h.ctl('btn-y'), 'pointerup', 2);
    vi.advanceTimersByTime(30);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
  });

  it('two fingers on one button keep it down until both lift', () => {
    const a = h.ctl('btn-a');
    ptr(a, 'pointerdown', 1);
    ptr(a, 'pointerdown', 2);
    vi.advanceTimersByTime(50);
    ptr(a, 'pointerup', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    ptr(a, 'pointerup', 2);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    expect(a.getAttribute('aria-pressed')).toBe('false');
  });

  it('never exceeds 240 frames a second, even for button edges 1 ms apart, and ends on the true state', () => {
    for (let i = 0; i < 20; i++) {
      ptr(h.ctl(i % 2 ? 'btn-a' : 'btn-b'), 'pointerdown', 10 + i);
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(50);
    const t = h.ws().stateTimes();
    for (let i = 1; i < t.length; i++) expect((t[i] as number) - (t[i - 1] as number)).toBeGreaterThanOrEqual(4);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A | BTN.B);
  });

  it('keepalive: {"t":"k"} every 500 ms while idle, restarted by a state frame', () => {
    const ws = h.ws();
    vi.advanceTimersByTime(489); // 10 ms have passed since the welcome frame
    expect(ws.count('k')).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ws.count('k')).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(ws.count('k')).toBe(4);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    vi.advanceTimersByTime(499);
    expect(ws.count('k')).toBe(4);
    vi.advanceTimersByTime(1);
    expect(ws.count('k')).toBe(5);
  });
});

describe('play: sticks', () => {
  const last = (): PadState => h.ws().states().at(-1) as PadState;
  const R = (id: string): number => ((T.activeLayout(host.store).controls.find((c: { id: string }) => c.id === id) as { size: number }).size * (FH / 100)) / 2;

  it('the base centre is the origin; deflection maps to axes with up positive; release recentres', async () => {
    h = await mount();
    const c = h.at('stick-left');
    const r = R('stick-left');
    const el = h.ctl('stick-left');
    ptr(el, 'pointerdown', 1, c.x, c.y);
    expect(last()).toEqual(NEUTRAL);
    vi.advanceTimersByTime(10);
    ptr(el, 'pointermove', 1, c.x + r, c.y);
    expect(last()).toMatchObject({ lx: 32767, ly: 0 });
    vi.advanceTimersByTime(10);
    ptr(el, 'pointermove', 1, c.x, c.y - r);
    expect(last()).toMatchObject({ lx: 0, ly: 32767 });
    vi.advanceTimersByTime(10);
    ptr(el, 'pointermove', 1, c.x, c.y + r);
    expect(last()).toMatchObject({ ly: -32767 });
    expect((el.querySelector('.stick-knob') as HTMLElement).style.transform).toContain('translate3d');
    expect(el.classList.contains('is-active')).toBe(true);
    vi.advanceTimersByTime(10);
    ptr(el, 'pointerup', 1, c.x, c.y + r);
    expect(last()).toEqual(NEUTRAL);
    expect((el.querySelector('.stick-knob') as HTMLElement).style.transform).toBe('');
  });

  it('stick frames are at most one per 8 ms and the final position is always sent', async () => {
    h = await mount();
    const c = h.at('stick-right');
    const r = R('stick-right');
    const el = h.ctl('stick-right');
    ptr(el, 'pointerdown', 1, c.x, c.y);
    const start = h.ws().stateTimes().length;
    // a 1 ms pointermove storm for 60 ms, ending at full right
    for (let i = 1; i <= 60; i++) {
      vi.advanceTimersByTime(1);
      ptr(el, 'pointermove', 1, c.x + (r * i) / 60, c.y);
    }
    // the trailing timer sends the newest sample
    vi.advanceTimersByTime(20);
    const times = h.ws().stateTimes().slice(start);
    expect(times.length).toBeGreaterThan(3);
    expect(times.length).toBeLessThanOrEqual(8); // 60 ms / 8 ms
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(8);
    expect(last()).toMatchObject({ rx: 32767 });
  });

  it('a send from inside the handler cancels the trailing send armed before it (it used to double the stick rate)', async () => {
    // In a real browser a pointermove can run a hair before the trailing timer that is due at the same moment. The handler
    // then sends directly; the stale timer must not fire a second frame right behind it. Model the race by letting the
    // page clock (performance.now) run 7 ms ahead of the timer clock.
    h = await mount();
    const c = h.at('stick-right');
    const r = R('stick-right');
    const el = h.ctl('stick-right');
    ptr(el, 'pointerdown', 1, c.x, c.y);
    vi.advanceTimersByTime(20);
    ptr(el, 'pointermove', 1, c.x + r * 0.2, c.y); // direct send
    vi.advanceTimersByTime(1);
    ptr(el, 'pointermove', 1, c.x + r * 0.3, c.y); // arms the trailing send, due in 7 ms
    const real = performance.now.bind(performance);
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => real() + 7);
    try {
      const n = h.ws().states().length;
      ptr(el, 'pointermove', 1, c.x + r * 0.4, c.y); // the page clock says 8 ms: direct send
      ptr(el, 'pointermove', 1, c.x + r * 0.5, c.y); // newer sample inside the next gap
      expect(h.ws().states()).toHaveLength(n + 1);
      vi.advanceTimersByTime(7); // the stale timer's moment: nothing may go out (only 7 ms after the direct send)
      expect(h.ws().states()).toHaveLength(n + 1);
      vi.advanceTimersByTime(2); // 8 ms after the direct send: the newest sample
      expect(h.ws().states()).toHaveLength(n + 2);
      expect(last().rx).toBeGreaterThan(0.4 * 32767); // the 0.5 sample (after the 0.1 dead zone)
    } finally {
      spy.mockRestore();
    }
  });

  it('the very last sample is not lost when the finger lifts inside the 8 ms gap', async () => {
    h = await mount();
    const c = h.at('stick-left');
    const r = R('stick-left');
    const el = h.ctl('stick-left');
    ptr(el, 'pointerdown', 1, c.x, c.y);
    vi.advanceTimersByTime(10);
    ptr(el, 'pointermove', 1, c.x + r, c.y);
    vi.advanceTimersByTime(2);
    ptr(el, 'pointermove', 1, c.x, c.y - r);
    vi.advanceTimersByTime(1);
    ptr(el, 'pointerup', 1);
    vi.advanceTimersByTime(30);
    expect(last()).toEqual(NEUTRAL);
  });

  it('sensitivity comes from the layout; the other stick values are forced defaults', async () => {
    host.store = sanitizeStore({ version: 1, activeId: 'default', layouts: [{ ...planLayoutRaw(), controls: planLayoutRaw().controls.map((c: Any) => (c.type === 'stick' ? { ...c, sensitivity: 2, curve: 'aggressive', invertY: true, deadzone: 0.4 } : c)) }] });
    h = await mount();
    const c = h.at('stick-left');
    const r = R('stick-left');
    ptr(h.ctl('stick-left'), 'pointerdown', 1, c.x, c.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 1, c.x, c.y - r / 4); // r = 0.25: dead zone 0.1 -> m = 0.1667, linear, x2
    expect(last().ly).toBe(Math.round(Math.min(1, ((0.25 - 0.1) / 0.9) * 2) * 32767));
  });

  it('a "right" stick control writes the right axes; a second finger on the same stick is ignored; sticks are independent', async () => {
    h = await mount();
    const l = h.at('stick-left');
    const rr = h.at('stick-right');
    ptr(h.ctl('stick-left'), 'pointerdown', 1, l.x, l.y);
    ptr(h.ctl('stick-left'), 'pointerdown', 2, l.x + 10, l.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 2, l.x + R('stick-left'), l.y);
    ptr(h.ctl('stick-right'), 'pointerdown', 3, rr.x, rr.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-right'), 'pointermove', 3, rr.x, rr.y - R('stick-right'));
    expect(last()).toMatchObject({ lx: 0, ly: 0, rx: 0, ry: 32767 });
  });

  it('double tap presses L3 (left) or R3 (right) while the second touch is held; slow or long taps do not', async () => {
    h = await mount();
    for (const [id, bit] of [['stick-left', BTN.LEFT_THUMB], ['stick-right', BTN.RIGHT_THUMB]] as const) {
      const c = h.at(id);
      const el = h.ctl(id);
      ptr(el, 'pointerdown', 1, c.x, c.y);
      vi.advanceTimersByTime(80);
      ptr(el, 'pointerup', 1, c.x, c.y);
      vi.advanceTimersByTime(150);
      ptr(el, 'pointerdown', 2, c.x, c.y);
      expect(last().buttons, id).toBe(bit);
      vi.advanceTimersByTime(40);
      ptr(el, 'pointerup', 2, c.x, c.y);
      expect(last().buttons, id).toBe(0);
      vi.advanceTimersByTime(500);
      // too slow
      ptr(el, 'pointerdown', 3, c.x, c.y);
      vi.advanceTimersByTime(50);
      ptr(el, 'pointerup', 3);
      vi.advanceTimersByTime(400);
      ptr(el, 'pointerdown', 4, c.x, c.y);
      expect(last().buttons).toBe(0);
      ptr(el, 'pointerup', 4);
      // a long first touch is not a tap
      vi.advanceTimersByTime(600);
      ptr(el, 'pointerdown', 5, c.x, c.y);
      vi.advanceTimersByTime(900);
      ptr(el, 'pointerup', 5);
      vi.advanceTimersByTime(50);
      ptr(el, 'pointerdown', 6, c.x, c.y);
      expect(last().buttons).toBe(0);
      ptr(el, 'pointerup', 6);
    }
  });
});

describe('play: d-pad', () => {
  it('follows the finger between directions and lights the arms', async () => {
    h = await mount();
    const dp = h.ctl('dpad');
    const c = h.at('dpad');
    const half = (26 * FH) / 100 / 2;
    ptr(dp, 'pointerdown', 1, c.x + half * 0.9, c.y);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.DPAD_RIGHT);
    expect(dp.querySelector('.arm-right')?.classList.contains('is-down')).toBe(true);
    vi.advanceTimersByTime(10);
    ptr(dp, 'pointermove', 1, c.x + half * 0.8, c.y + half * 0.8);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.DPAD_RIGHT | BTN.DPAD_DOWN);
    vi.advanceTimersByTime(10);
    ptr(dp, 'pointerup', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    expect(dp.querySelector('.is-down')).toBeNull();
  });
});

describe('play: multi-touch', () => {
  it('handles five simultaneous touches and releases them one by one', async () => {
    h = await mount();
    const c = h.at('stick-left');
    const r = ((38 * FH) / 100) / 2;
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    ptr(h.ctl('btn-b'), 'pointerdown', 2);
    ptr(h.ctl('btn-lt'), 'pointerdown', 3);
    ptr(h.ctl('btn-rt'), 'pointerdown', 4);
    ptr(h.ctl('stick-left'), 'pointerdown', 5, c.x, c.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 5, c.x + r, c.y);
    vi.advanceTimersByTime(20); // the trailing frame carries the newest state
    expect(h.ws().states().at(-1)).toEqual({ buttons: BTN.A | BTN.B, lt: 255, rt: 255, lx: 32767, ly: 0, rx: 0, ry: 0 });
    vi.advanceTimersByTime(40);
    ptr(h.ctl('btn-b'), 'pointerup', 2);
    ptr(h.ctl('btn-lt'), 'pointerup', 3);
    vi.advanceTimersByTime(10);
    expect(h.ws().states().at(-1)).toEqual({ buttons: BTN.A, lt: 0, rt: 255, lx: 32767, ly: 0, rx: 0, ry: 0 });
  });
  it('ignores right-clicks and unknown pointers', async () => {
    h = await mount();
    h.ctl('btn-a').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 2 }));
    ptr(h.ctl('btn-a'), 'pointerup', 77);
    ptr(h.ctl('btn-a'), 'pointermove', 77);
    const n = h.ws().count('s');
    vi.advanceTimersByTime(50);
    expect(h.ws().count('s')).toBe(n);
  });
});

describe('safety release', () => {
  const holdSomething = (): void => {
    const c = h.at('stick-left');
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    ptr(h.ctl('btn-rt'), 'pointerdown', 2);
    ptr(h.ctl('stick-left'), 'pointerdown', 3, c.x, c.y);
    vi.advanceTimersByTime(30);
    ptr(h.ctl('stick-left'), 'pointermove', 3, c.x + ((38 * FH) / 100) / 2, c.y);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
  };
  const neutrals = (): number => h.ws().states().filter((s) => s.buttons === 0 && s.lt === 0 && s.rt === 0 && s.lx === 0 && s.ly === 0).length;
  beforeEach(async () => {
    h = await mount();
  });

  it('hidden, blur, pagehide and a cancelled pointer each send exactly ONE neutral state', () => {
    for (const trigger of [
      () => {
        visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
      },
      () => window.dispatchEvent(new Event('blur')),
      () => window.dispatchEvent(new Event('pagehide')),
      () => ptr(h.ctl('btn-rt'), 'pointercancel', 2),
    ]) {
      holdSomething();
      const before = neutrals();
      trigger();
      expect(neutrals(), 'neutral frames').toBe(before + 1);
      expect(h.ws().states().at(-1)).toEqual(NEUTRAL);
      expect(h.ctl('btn-a').classList.contains('is-down')).toBe(false);
      // a second trigger while nothing is held sends nothing more
      window.dispatchEvent(new Event('blur'));
      expect(neutrals()).toBe(before + 1);
      vi.advanceTimersByTime(100);
      expect(neutrals()).toBe(before + 1);
    }
  });

  it('a cancelled pointer releases every control, and later events of the others are ignored', () => {
    holdSomething();
    ptr(h.ctl('btn-rt'), 'pointercancel', 2);
    ptr(h.ctl('stick-left'), 'pointermove', 3, h.at('stick-left').x, h.at('stick-left').y - 50);
    vi.advanceTimersByTime(30);
    expect(h.ws().states().at(-1)).toEqual(NEUTRAL);
  });

  it('a press cancelled by a safety release never leaks out as a deferred release', () => {
    ptr(h.ctl('btn-b'), 'pointerdown', 1);
    window.dispatchEvent(new Event('blur'));
    const n = h.ws().count('s');
    vi.advanceTimersByTime(100);
    expect(h.ws().count('s')).toBe(n);
  });

  it('portrait: the rotate overlay exists, everything is released, input is ignored, and landscape works again', () => {
    expect(document.getElementById('rotate')).toBeTruthy();
    holdSomething();
    setPortrait(true);
    expect(h.ws().states().at(-1)).toEqual(NEUTRAL);
    ptr(h.ctl('btn-b'), 'pointerdown', 7);
    expect(h.ws().states().at(-1)).toEqual(NEUTRAL);
    setPortrait(false);
    vi.advanceTimersByTime(60);
    ptr(h.ctl('btn-b'), 'pointerdown', 8);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.B);
  });
});

describe('reconnecting', () => {
  it('closing the socket releases everything and the dot turns amber', async () => {
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    h.ws().drop();
    expect(menuEl().dataset['state']).toBe('retrying');
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
    expect(second.count('s')).toBe(0);
    second.receive({ t: 'welcome', slot: 3 });
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
  it('survives a WebSocket constructor that throws; foreground reconnects at once', async () => {
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new Error('SecurityError');
        }
      },
    );
    h = await mount({ welcome: false });
    expect(menuEl().dataset['state']).toBe('retrying');
    vi.advanceTimersByTime(60_000);
    vi.stubGlobal('WebSocket', FakeSocket);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('full and kicked are final', () => {
  it('full: message, no reconnect, no controls; Try again restarts on request', async () => {
    h = await mount({ welcome: false });
    h.ws().open();
    h.ws().receive({ t: 'full' });
    expect(noticeVisible()).toBe(true);
    expect(document.getElementById('notice-text')?.textContent).toBe('All 4 player slots are taken');
    expect(menuEl().dataset['state']).toBe('full');
    expect((document.getElementById('retry') as HTMLElement).hidden).toBe(false);
    expect(h.ws().closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(h.ws().states()).toHaveLength(0);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(1);
    tapAt(document.getElementById('retry') as Element);
    expect(FakeSocket.all).toHaveLength(2);
    expect(noticeVisible()).toBe(false);
  });
  it('kicked: message, no reconnect, no retry button, sends nothing more', async () => {
    h = await mount();
    const ws = h.ws();
    const n = ws.sent.length;
    ws.receive({ t: 'kicked' });
    expect(document.getElementById('notice-text')?.textContent).toBe('Removed from this PC');
    expect((document.getElementById('retry') as HTMLElement).hidden).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    window.dispatchEvent(new Event('blur'));
    expect(ws.sent.length).toBe(n);
  });
});

describe('browser defaults that would break a game pad', () => {
  it('cancels the context menu, selection, dragging, touch scrolling, gestures, and touchstart on the field only', async () => {
    h = await mount();
    for (const type of ['contextmenu', 'selectstart', 'dragstart', 'touchmove', 'gesturestart']) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented, type).toBe(true);
    }
    const onField = new Event('touchstart', { bubbles: true, cancelable: true });
    h.ctl('btn-a').dispatchEvent(onField);
    expect(onField.defaultPrevented).toBe(true);
    const onMenu = new Event('touchstart', { bubbles: true, cancelable: true });
    menuEl().dispatchEvent(onMenu);
    expect(onMenu.defaultPrevented).toBe(false); // chrome keeps its normal touch behaviour
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

// ---- Haptics in the page -----------------------------------------------------------------------------------------------

describe('haptics in the page (Android: navigator.vibrate)', () => {
  it('buttons and bumpers, triggers, Start/Back, d-pad direction changes and stick touch-down each tick vibrate(10)', async () => {
    stubVibrate();
    h = await mount();
    for (const id of ['btn-a', 'btn-lb', 'btn-rt', 'btn-start', 'btn-back']) {
      vibrate?.mockClear();
      ptr(h.ctl(id), 'pointerdown', 1);
      expect(vibrate, id).toHaveBeenCalledWith(10);
      vi.advanceTimersByTime(40);
      ptr(h.ctl(id), 'pointerup', 1);
      vi.advanceTimersByTime(40);
    }
    vibrate?.mockClear();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    ptr(h.ctl('btn-a'), 'pointerdown', 2); // a second finger on a held button does not buzz again
    expect(vibrate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(40);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    ptr(h.ctl('btn-a'), 'pointerup', 2);

    const dp = h.at('dpad');
    const half = (26 * FH) / 100 / 2;
    vibrate?.mockClear();
    ptr(h.ctl('dpad'), 'pointerdown', 3, dp.x + half * 0.9, dp.y);
    expect(vibrate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('dpad'), 'pointermove', 3, dp.x + half * 0.95, dp.y); // same direction: no tick
    expect(vibrate).toHaveBeenCalledTimes(1);
    ptr(h.ctl('dpad'), 'pointermove', 3, dp.x, dp.y + half * 0.9); // direction change: tick
    expect(vibrate).toHaveBeenCalledTimes(2);
    ptr(h.ctl('dpad'), 'pointerup', 3);

    vibrate?.mockClear();
    const s = h.at('stick-left');
    ptr(h.ctl('stick-left'), 'pointerdown', 4, s.x, s.y);
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it('the stick ramp follows the pulse table and is cancelled with vibrate(0) on release', async () => {
    stubVibrate();
    h = await mount();
    const s = h.at('stick-left');
    const r = ((38 * FH) / 100) / 2;
    const el = h.ctl('stick-left');
    ptr(el, 'pointerdown', 1, s.x, s.y);
    vibrate?.mockClear();
    vi.advanceTimersByTime(20);
    ptr(el, 'pointermove', 1, s.x + r * 0.5, s.y); // 0.4-0.65: 10 ms every 110 ms
    expect(vibrate).toHaveBeenLastCalledWith(10);
    vibrate?.mockClear();
    vi.advanceTimersByTime(330);
    expect(vibrate).toHaveBeenCalledTimes(3);
    vibrate?.mockClear();
    vi.advanceTimersByTime(20);
    ptr(el, 'pointermove', 1, s.x + r * 0.95, s.y); // >= 0.9: 24 ms every 80 ms
    vi.advanceTimersByTime(160);
    expect(vibrate).toHaveBeenCalledWith(24);
    vibrate?.mockClear();
    ptr(el, 'pointerup', 1);
    expect(vibrate).toHaveBeenCalledWith(0);
    vibrate?.mockClear();
    vi.advanceTimersByTime(1000);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('two sticks pulled at once use the stronger; hidden/blur/edit cancel the ramp', async () => {
    stubVibrate();
    h = await mount();
    const a = h.at('stick-left');
    const b = h.at('stick-right');
    ptr(h.ctl('stick-left'), 'pointerdown', 1, a.x, a.y);
    ptr(h.ctl('stick-right'), 'pointerdown', 2, b.x, b.y);
    vibrate?.mockClear();
    vi.advanceTimersByTime(20);
    ptr(h.ctl('stick-left'), 'pointermove', 1, a.x + ((38 * FH) / 100 / 2) * 0.3, a.y); // weak
    ptr(h.ctl('stick-right'), 'pointermove', 2, b.x + ((30 * FH) / 100 / 2) * 0.95, b.y); // strong
    expect(vibrate).toHaveBeenLastCalledWith(24); // the stronger of the two, immediately
    vibrate?.mockClear();
    window.dispatchEvent(new Event('blur'));
    expect(vibrate).toHaveBeenCalledWith(0);
    vibrate?.mockClear();
    vi.advanceTimersByTime(500);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('layout.haptics off: no vibration anywhere, including the stick ramp', async () => {
    stubVibrate();
    const s = planStore();
    host.store = T.setHaptics(s, false);
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    const c = h.at('stick-left');
    ptr(h.ctl('stick-left'), 'pointerdown', 2, c.x, c.y);
    vi.advanceTimersByTime(20);
    ptr(h.ctl('stick-left'), 'pointermove', 2, c.x + ((38 * FH) / 100) / 2, c.y);
    vi.advanceTimersByTime(500);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('never throws without navigator.vibrate (desktop)', async () => {
    h = await mount();
    expect('vibrate' in navigator).toBe(false);
    const c = h.at('stick-left');
    expect(() => {
      ptr(h.ctl('btn-a'), 'pointerdown', 1);
      ptr(h.ctl('stick-left'), 'pointerdown', 2, c.x, c.y);
      ptr(h.ctl('stick-left'), 'pointermove', 2, c.x + 60, c.y);
      vi.advanceTimersByTime(500);
    }).not.toThrow();
  });
});

describe('haptics in the page (iOS: the hidden switch)', () => {
  const iosPage = async (): Promise<HTMLLabelElement> => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
    h = await mount();
    const label = document.querySelector<HTMLLabelElement>('label.haptic-switch');
    if (!label) throw new Error('no haptic switch label');
    return label;
  };

  it('creates one hidden checkbox switch, and a tick is a click on its label', async () => {
    const label = await iosPage();
    const input = label.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('checkbox');
    expect(input.hasAttribute('switch')).toBe(true);
    expect(label.getAttribute('aria-hidden')).toBe('true');
    const click = vi.spyOn(label, 'click');
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(click).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(40);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    vi.advanceTimersByTime(40);
    ptr(h.ctl('btn-b'), 'pointerdown', 2);
    expect(click).toHaveBeenCalledTimes(2);
  });

  it('ticks no faster than every 25 ms, and a stick ticks at a rate that grows with the pull', async () => {
    const label = await iosPage();
    const click = vi.spyOn(label, 'click');
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    ptr(h.ctl('btn-b'), 'pointerdown', 2); // same instant: the global cap swallows it
    expect(click).toHaveBeenCalledTimes(1);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    ptr(h.ctl('btn-b'), 'pointerup', 2);
    vi.advanceTimersByTime(100);
    click.mockClear();
    const c = h.at('stick-left');
    const r = ((38 * FH) / 100) / 2;
    ptr(h.ctl('stick-left'), 'pointerdown', 3, c.x, c.y); // touch-down tick
    expect(click).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30);
    click.mockClear();
    // Ticks come only from input events (a 120 Hz move stream here), never from a timer: see createHaptics.
    const hold = (dx: number): void => {
      for (let t = 0; t < 1000; t += 8) {
        vi.advanceTimersByTime(8);
        ptr(h.ctl('stick-left'), 'pointermove', 3, c.x + dx + (t % 16 ? 0.2 : 0), c.y);
      }
    };
    hold(r * 0.3); // 0.3: slow
    const slow = click.mock.calls.length;
    click.mockClear();
    hold(r); // full: fast
    const fast = click.mock.calls.length;
    click.mockClear();
    vi.advanceTimersByTime(1000); // a perfectly still finger sends no events: no ticks
    expect(click).not.toHaveBeenCalled();
    expect(slow).toBeGreaterThanOrEqual(3);
    expect(fast).toBeGreaterThan(slow * 2);
    expect(fast).toBeLessThanOrEqual(19);
    ptr(h.ctl('stick-left'), 'pointerup', 3);
    click.mockClear();
    vi.advanceTimersByTime(1000);
    expect(click).not.toHaveBeenCalled();
  });

  it('a click that throws never breaks the pad', async () => {
    const label = await iosPage();
    vi.spyOn(label, 'click').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => {
      ptr(h.ctl('btn-a'), 'pointerdown', 1);
      vi.advanceTimersByTime(100);
    }).not.toThrow();
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
  });
});

describe('?diag=1', () => {
  it('shows four buttons; 1 ticks from click, 2 from pointerdown, 3 while dragging, 4 ten times from a timer', async () => {
    stubVibrate();
    h = await mount({ search: '&diag=1' });
    const b = (n: number): HTMLElement => document.getElementById('diag-' + n) as HTMLElement;
    expect([1, 2, 3, 4].map((n) => !!document.getElementById('diag-' + n))).toEqual([true, true, true, true]);
    b(1).click();
    expect(vibrate).toHaveBeenCalledTimes(1);
    vibrate?.mockClear();
    ptr(b(2), 'pointerdown', 1);
    expect(vibrate).toHaveBeenCalledTimes(1);
    vibrate?.mockClear();
    ptr(b(3), 'pointerdown', 2);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(35);
      ptr(b(3), 'pointermove', 2, i, 0);
    }
    expect(vibrate?.mock.calls.length).toBeGreaterThanOrEqual(4);
    vibrate?.mockClear();
    b(4).click();
    vi.advanceTimersByTime(1500);
    expect(vibrate).toHaveBeenCalledTimes(10);
  });
  it('is absent without the parameter', async () => {
    h = await mount();
    expect(document.getElementById('diag-1')).toBeNull();
  });
});

// ---- Menu, edit mode, Done ---------------------------------------------------------------------------------------------

describe('chrome buttons: one tap helper', () => {
  beforeEach(async () => {
    h = await mount();
    rect(menuEl(), 409, 2, 56, 52); // x 409..465, y 2..54
    rect(doneEl(), 383, 2, 108, 52);
  });

  it('one tap on the menu enters edit mode, even with 10 px of finger drift', () => {
    ptr(menuEl(), 'pointerdown', 5, 437, 28);
    ptr(menuEl(), 'pointerup', 5, 447, 33); // rolled 10 px sideways
    expect(editing()).toBe(true);
    expect(menuEl().hidden).toBe(true);
    expect(doneEl().hidden).toBe(false);
  });

  it('a release far from the button (beyond the 12 pt slop) is not a tap; a cancel is not a tap', () => {
    ptr(menuEl(), 'pointerdown', 5, 437, 28);
    ptr(menuEl(), 'pointerup', 5, 437, 28 + 26 + 13);
    expect(editing()).toBe(false);
    ptr(menuEl(), 'pointerdown', 6, 437, 28);
    ptr(menuEl(), 'pointercancel', 6, 437, 28);
    ptr(menuEl(), 'pointerup', 6, 437, 28);
    expect(editing()).toBe(false);
    ptr(menuEl(), 'pointerdown', 7, 437, 28);
    ptr(menuEl(), 'pointerup', 7, 409 - 12, 28); // exactly on the slop edge: still a tap
    expect(editing()).toBe(true);
  });

  it('a synthesised click after a touch (detail > 0) is ignored; a keyboard click (detail 0) works', async () => {
    tapAt(menuEl(), 437, 28);
    expect(editing()).toBe(true);
    menuEl().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    // Done sits where the menu was: the iOS click that follows the first tap must not hit it
    doneEl().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await settle();
    expect(editing()).toBe(true);
    expect(host.puts()).toHaveLength(0);
    doneEl().click(); // keyboard / assistive technology
    await settle();
    expect(editing()).toBe(false);
    expect(host.puts()).toHaveLength(1);
  });

  it('taps on the chrome never start a game gesture under them', () => {
    const n = h.ws().sent.length;
    tapAt(menuEl(), 437, 28);
    tapAt(doneEl(), 437, 28);
    expect(h.ws().states().every((s) => s.buttons === 0)).toBe(true);
    expect(h.ws().sent.filter((s) => s !== '{"t":"k"}').length).toBeLessThanOrEqual(n + 1);
  });

  it('the chrome is outside the field, so field handlers cannot swallow its pointer events', () => {
    const field = document.getElementById('field') as HTMLElement;
    for (const el of [menuEl(), doneEl(), cardEl(), document.getElementById('retry') as HTMLElement]) expect(field.contains(el)).toBe(false);
  });
});

describe('edit mode', () => {
  const enter = async (): Promise<void> => {
    tapAt(menuEl());
    await settle();
  };
  const slider = (label: string): HTMLElement => {
    const s = [...cardEl().querySelectorAll<HTMLElement>('.slider')].find((x) => x.querySelector('.slider-label')?.textContent === label);
    if (!s) throw new Error('no slider ' + label + ' in ' + cardEl().textContent);
    return s;
  };
  const drag = (label: string, ratio: number): void => {
    const track = slider(label).querySelector('.slider-track') as HTMLElement;
    rect(track, 100, 100, 200, 44);
    ptr(track, 'pointerdown', 70, 100 + 200 * ratio, 120);
    ptr(track, 'pointerup', 70, 100 + 200 * ratio, 120);
  };
  const valueOf = (label: string): string => slider(label).querySelector('.slider-value')?.textContent ?? '';
  const putCtl = (id: string): Any => T.activeLayout(host.puts().at(-1)).controls.find((c: { id: string }) => c.id === id);
  const selectCtl = (id: string): void => {
    const c = h.at(id);
    ptr(h.ctl(id), 'pointerdown', 20, c.x, c.y);
    ptr(h.ctl(id), 'pointerup', 20, c.x, c.y);
  };
  const cardBox = (): { l: number; r: number; t: number; b: number } => {
    const w = cardEl().classList.contains('is-settings') ? 300 : 280;
    const hh = cardEl().classList.contains('is-settings') ? 168 : 136;
    const x = parseFloat(cardEl().style.left);
    const y = parseFloat(cardEl().style.top);
    return { l: x - w / 2, r: x + w / 2, t: y - hh / 2, b: y + hh / 2 };
  };

  beforeEach(async () => {
    h = await mount();
  });

  it('sends neutral on entry and only keepalives while editing; play input is ignored', async () => {
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    await enter();
    expect(h.ws().states().at(-1)).toEqual(NEUTRAL);
    const n = h.ws().count('s');
    ptr(h.ctl('btn-b'), 'pointerdown', 2); // selects, does not press
    ptr(h.ctl('btn-b'), 'pointerup', 2);
    const k = h.ws().count('k');
    vi.advanceTimersByTime(1500);
    expect(h.ws().count('s')).toBe(n);
    expect(h.ws().count('k')).toBeGreaterThanOrEqual(k + 3);
  });

  it('with nothing selected, the settings card shows slots 1 2 3, Reset, Stick sensitivity and Haptics, centred', async () => {
    await enter();
    expect(cardEl().hidden).toBe(false);
    expect(cardEl().classList.contains('is-settings')).toBe(true);
    expect([...cardEl().querySelectorAll('.slot')].map((b) => b.textContent)).toEqual(['1', '2', '3']);
    expect([...cardEl().querySelectorAll('.slot')].map((b) => b.classList.contains('is-empty'))).toEqual([false, true, true]);
    expect(cardEl().querySelector('.reset')?.textContent).toBe('Reset');
    expect(valueOf('Stick sensitivity')).toBe('1.0');
    expect(cardEl().querySelector('.switch')?.getAttribute('aria-checked')).toBe('true');
    expect(cardEl().style.left).toBe(String(FW / 2) + 'px');
    // it sits where it covers no control, so every control can still be tapped to select it
    const b = cardBox();
    for (const c of T.activeLayout(host.store).controls) {
      const [w, hh] = T.controlBox(c) as [number, number];
      const cx = (c.x / 100) * FW;
      const cy = (c.y / 100) * FH;
      const covers = cx + (w * FH) / 200 > b.l && cx - (w * FH) / 200 < b.r && cy + (hh * FH) / 200 > b.t && cy - (hh * FH) / 200 < b.b;
      expect(covers, c.id).toBe(false);
    }
  });

  it('growing a control to the top of its Size range never slides it under its card', async () => {
    await enter();
    for (const id of ['btn-a', 'stick-right', 'dpad']) {
      // park the control just right of where a centred control card would end, then grow it to the maximum
      const c0 = h.at(id);
      const [w0] = T.controlBox(T.activeLayout(host.store).controls.find((x: { id: string }) => x.id === id)) as [number, number];
      const target = { x: FW / 2 + 140 + 8 + (w0 * FH) / 200 + 2, y: FH / 2 };
      ptr(h.ctl(id), 'pointerdown', 21, c0.x, c0.y);
      ptr(h.ctl(id), 'pointermove', 21, target.x, target.y);
      ptr(h.ctl(id), 'pointerup', 21, target.x, target.y);
      drag('Size', 1);
      const el = h.ctl(id);
      const w = (parseFloat(el.style.getPropertyValue('--w')) * FH) / 100;
      const hh = (parseFloat(el.style.getPropertyValue('--h')) * FH) / 100;
      const cx = (parseFloat(el.style.left) / 100) * FW;
      const cy = (parseFloat(el.style.top) / 100) * FH;
      const b = cardBox();
      const covers = cx + w / 2 > b.l && cx - w / 2 < b.r && cy + hh / 2 > b.t && cy - hh / 2 < b.b;
      expect(covers, id + ' ' + JSON.stringify({ cx, cy, w, hh, b })).toBe(false);
      ptr(document.getElementById('field') as Element, 'pointerdown', 35, 1, 1); // deselect
    }
  });

  it('tapping a control selects it and shows ONE card with its name and two sliders, never covering it', async () => {
    await enter();
    for (const id of ['btn-a', 'btn-lt', 'stick-left', 'stick-right', 'dpad', 'btn-back', 'btn-rb']) {
      selectCtl(id);
      expect(h.ctl(id).classList.contains('is-selected'), id).toBe(true);
      expect(document.querySelectorAll('.is-selected')).toHaveLength(1);
      expect(cardEl().hidden).toBe(false);
      expect(cardEl().classList.contains('is-settings')).toBe(false);
      expect(cardEl().querySelector('.card-title')?.textContent).toBe(h.ctl(id).getAttribute('aria-label'));
      expect([...cardEl().querySelectorAll('.slider-label')].map((e) => e.textContent)).toEqual(['Size', 'Opacity']);
      const c = h.at(id);
      const [bw, bh] = T.controlBox(T.activeLayout(host.store).controls.find((x: { id: string }) => x.id === id)) as [number, number];
      const box = { l: c.x - (bw * FH) / 200, r: c.x + (bw * FH) / 200, t: c.y - (bh * FH) / 200, b: c.y + (bh * FH) / 200 };
      const cb = cardBox();
      expect(cb.l < box.r && box.l < cb.r && cb.t < box.b && box.t < cb.b, `${id}: card covers the control`).toBe(false);
    }
    ptr(document.getElementById('field') as Element, 'pointerdown', 30, 440, 200); // empty space: back to the settings card
    expect(cardEl().classList.contains('is-settings')).toBe(true);
    expect(document.querySelector('.is-selected')).toBeNull();
  });

  it('dragging moves a control and clamps it to the field; the card returns on release', async () => {
    await enter();
    const c = h.at('btn-a');
    ptr(h.ctl('btn-a'), 'pointerdown', 1, c.x, c.y);
    expect(cardEl().hidden).toBe(true); // out of the way while dragging
    ptr(h.ctl('btn-a'), 'pointermove', 1, FW / 2, FH / 2);
    expect(h.ctl('btn-a').style.left).toBe('50%');
    expect(h.ctl('btn-a').style.top).toBe('50%');
    ptr(h.ctl('btn-a'), 'pointermove', 1, 99999, 99999);
    const half = 8; // 16 % of the height, half of it
    expect(parseFloat(h.ctl('btn-a').style.top)).toBeCloseTo(100 - half, 1);
    expect(parseFloat(h.ctl('btn-a').style.left)).toBeCloseTo(100 - (half * FH) / FW, 1);
    ptr(h.ctl('btn-a'), 'pointermove', 1, -99999, -99999);
    expect(parseFloat(h.ctl('btn-a').style.top)).toBeCloseTo(half, 1);
    expect(parseFloat(h.ctl('btn-a').style.left)).toBeCloseTo((half * FH) / FW, 1);
    ptr(h.ctl('btn-a'), 'pointermove', 1, 300, 200);
    ptr(h.ctl('btn-a'), 'pointerup', 1, 300, 200);
    expect(cardEl().hidden).toBe(false);
    expect(host.puts()).toHaveLength(0); // nothing is saved until Done
  });

  it('Size and Opacity preview live (tap on the track jumps) and respect the ranges', async () => {
    await enter();
    selectCtl('stick-left');
    expect(valueOf('Size')).toBe('38');
    drag('Size', 1);
    expect(valueOf('Size')).toBe('60');
    expect(h.ctl('stick-left').style.getPropertyValue('--w')).toBe('60');
    drag('Size', 0);
    expect(h.ctl('stick-left').style.getPropertyValue('--w')).toBe('24');
    drag('Opacity', 0);
    expect(h.ctl('stick-left').style.opacity).toBe('0.2');
    expect(valueOf('Opacity')).toBe('20%');
    drag('Opacity', 1);
    expect(h.ctl('stick-left').style.opacity).toBe('1');
    selectCtl('btn-lt'); // 22 x 13: scales together
    drag('Size', 1);
    expect(h.ctl('btn-lt').style.getPropertyValue('--h')).toBe('30');
    expect(parseFloat(h.ctl('btn-lt').style.getPropertyValue('--w'))).toBeCloseTo(30 * (22 / 13), 1);
    selectCtl('dpad');
    drag('Size', 1);
    expect(h.ctl('dpad').style.getPropertyValue('--w')).toBe('45');
    const track = slider('Size').querySelector('.slider-track') as HTMLElement;
    expect(track.getAttribute('role')).toBe('slider');
    expect(track.getAttribute('aria-valuenow')).toBe('45');
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(valueOf('Size')).toBe('44');
  });

  it('a stored size outside the range is kept and widens the slider', async () => {
    host.store = sanitizeStore({ version: 1, activeId: 'default', layouts: [{ ...planLayoutRaw(), controls: planLayoutRaw().controls.map((c: Any) => (c.id === 'stick-left' ? { ...c, size: 75 } : c)) }] });
    h.destroy();
    h = await mount();
    await enter();
    selectCtl('stick-left');
    expect(valueOf('Size')).toBe('75');
    drag('Size', 0);
    expect(h.ctl('stick-left').style.getPropertyValue('--w')).toBe('24');
  });

  it('Done: ONE PUT /api/layouts, back to play at once; the saved store is a sanitizer fixed point', async () => {
    await enter();
    selectCtl('btn-b');
    drag('Size', 1);
    drag('Opacity', 0.5);
    const c = h.at('btn-b');
    ptr(h.ctl('btn-b'), 'pointerdown', 1, c.x, c.y);
    ptr(h.ctl('btn-b'), 'pointermove', 1, 600, 150);
    ptr(h.ctl('btn-b'), 'pointerup', 1, 600, 150);
    vi.advanceTimersByTime(10_000); // no autosave
    expect(host.puts()).toHaveLength(0);
    tapAt(doneEl());
    expect(editing()).toBe(false);
    expect(doneEl().hidden).toBe(true);
    expect(menuEl().hidden).toBe(false);
    expect(cardEl().hidden).toBe(true);
    await settle();
    expect(host.puts()).toHaveLength(1);
    expect(host.calls.find((x) => x.method === 'PUT')?.token).toBe('tok-123');
    const body = host.puts()[0] as LayoutStore;
    fixedPoint(body);
    expect(putCtl('btn-b')).toMatchObject({ h: 30, opacity: 0.6 });
    expect(putCtl('btn-b').x).toBeCloseTo((600 / FW) * 100, 0);
    expect(host.store).toEqual(body);
    expect(menuEl().dataset['state']).toBe('connected');
    vi.advanceTimersByTime(20_000);
    expect(host.puts()).toHaveLength(1); // nothing more
    // plays again right away
    ptr(h.ctl('btn-b'), 'pointerdown', 2);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.B);
  });

  it('Done with no edits is still exactly one PUT; a double tap does not save twice', async () => {
    await enter();
    tapAt(doneEl());
    tapAt(doneEl()); // second tap lands on the menu (hidden Done): ignored, menu enters edit again at most
    await settle();
    expect(host.puts().length).toBe(1);
  });

  it('slots: tapping an empty slot creates it from the default layout, an existing slot switches; edits apply to the active slot', async () => {
    await enter();
    const slotBtn = (i: number): HTMLElement => cardEl().querySelectorAll<HTMLElement>('.slot')[i - 1] as HTMLElement;
    tapAt(slotBtn(3)); // empty: creates slots 2 and 3 from the default
    await settle();
    expect(host.calls.filter((x) => x.path === '/api/default-layout')).toHaveLength(1);
    const active = (): string => cardEl().querySelector('.slot[aria-pressed="true"]')?.textContent ?? '';
    expect(active()).toBe('3');
    expect([...cardEl().querySelectorAll('.slot')].map((b) => b.classList.contains('is-empty'))).toEqual([false, false, false]);
    selectCtl('btn-a');
    drag('Size', 1);
    ptr(document.getElementById('field') as Element, 'pointerdown', 31, 440, 200);
    tapAt(slotBtn(1));
    expect(active()).toBe('1');
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('16'); // slot 1 untouched
    tapAt(slotBtn(2));
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('16');
    tapAt(slotBtn(3));
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('30');
    tapAt(doneEl());
    await settle();
    const saved = host.puts()[0] as LayoutStore;
    expect(saved.layouts).toHaveLength(3);
    expect(saved.activeId).toBe(saved.layouts[2]?.id);
    expect(T.activeLayout(saved).controls.find((c: { id: string }) => c.id === 'btn-a')).toMatchObject({ h: 30 });
    expect(saved.layouts[0]?.controls.find((c) => c.id === 'btn-a')).toMatchObject({ h: 16 });
    fixedPoint(saved);
  });

  it('Reset needs two taps and restores the stock layout of the active slot', async () => {
    await enter();
    selectCtl('btn-a');
    drag('Size', 1);
    ptr(document.getElementById('field') as Element, 'pointerdown', 31, 440, 200);
    const reset = cardEl().querySelector('.reset') as HTMLElement;
    tapAt(reset);
    await settle();
    expect(reset.textContent).toBe('Tap again');
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('30'); // nothing yet
    tapAt(reset);
    await settle();
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('16');
    // the confirmation times out
    ptr(document.getElementById('field') as Element, 'pointerdown', 32, 440, 200);
    const reset2 = cardEl().querySelector('.reset') as HTMLElement;
    tapAt(reset2);
    vi.advanceTimersByTime(3500);
    expect(reset2.textContent).toBe('Reset');
  });

  it('an armed Reset does not survive a new card or leaving the editor: the first tap on a fresh Reset only arms it', async () => {
    await enter();
    selectCtl('btn-a');
    drag('Size', 1);
    const field = document.getElementById('field') as Element;
    ptr(field, 'pointerdown', 33, 440, 200);
    tapAt(cardEl().querySelector('.reset') as HTMLElement); // armed
    ptr(field, 'pointerdown', 34, 440, 200); // empty field: the settings card is rebuilt
    const fresh = cardEl().querySelector('.reset') as HTMLElement;
    expect(fresh.textContent).toBe('Reset');
    tapAt(fresh);
    await settle();
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('30'); // not reset by one tap
    expect(fresh.textContent).toBe('Tap again');
    tapAt(doneEl()); // leave while armed
    await settle();
    tapAt(menuEl());
    await settle();
    tapAt(cardEl().querySelector('.reset') as HTMLElement);
    await settle();
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('30');
  });

  it('Stick sensitivity goes to every stick of the active layout; Haptics to every layout and ticks when switched on', async () => {
    stubVibrate();
    h.destroy();
    h = await mount();
    await enter();
    tapAt(cardEl().querySelectorAll('.slot')[1] as Element); // create slot 2 (active)
    await settle();
    drag('Stick sensitivity', 1);
    expect(valueOf('Stick sensitivity')).toBe('2.0');
    drag('Stick sensitivity', 0);
    expect(valueOf('Stick sensitivity')).toBe('0.5');
    const sw = cardEl().querySelector('.switch') as HTMLElement;
    vibrate?.mockClear();
    tapAt(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(vibrate).not.toHaveBeenCalled(); // switching off is silent
    tapAt(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(vibrate).toHaveBeenCalledWith(10); // one tick when switched on
    tapAt(sw); // off again, saved with Done
    tapAt(doneEl());
    await settle();
    const saved = host.puts()[0] as LayoutStore;
    expect(saved.layouts.map((l) => l.haptics)).toEqual([false, false]);
    const sens = (i: number) => saved.layouts[i]?.controls.filter((c) => c.type === 'stick').map((c) => (c as { sensitivity: number }).sensitivity);
    expect(sens(1)).toEqual([0.5, 0.5]);
    expect(sens(0)).toEqual([1, 1]); // the other slot keeps its own
    fixedPoint(saved);
  });

  it('a failed PUT still exits, keeps the draft, turns the dot amber, retries every 5 s and on reconnect', async () => {
    host.putFail = 2;
    await enter();
    selectCtl('btn-a');
    drag('Size', 1);
    tapAt(doneEl());
    await settle();
    expect(editing()).toBe(false);
    expect(host.puts()).toHaveLength(1);
    expect(menuEl().dataset['state']).toBe('retrying'); // amber although connected
    expect(h.ctl('btn-a').style.getPropertyValue('--w')).toBe('30'); // the draft stays on screen
    await vi.advanceTimersByTimeAsync(4900);
    expect(host.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(host.puts()).toHaveLength(2); // retry after 5 s, fails again
    expect(menuEl().dataset['state']).toBe('retrying');
    // the connection drops and comes back: it tries again at once
    h.ws().drop();
    vi.advanceTimersByTime(500);
    h.ws(1).open();
    h.ws(1).receive({ t: 'welcome', slot: 2 });
    await settle();
    expect(host.puts()).toHaveLength(3);
    expect(host.store.layouts[0]?.controls.find((c) => c.id === 'btn-a')).toMatchObject({ h: 30 });
    expect(menuEl().dataset['state']).toBe('connected');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.puts()).toHaveLength(3);
  });

  it('a pending retry never PUTs a half-edited draft: not from the 5 s timer, not on reconnect while editing', async () => {
    host.putFail = 1;
    await enter();
    selectCtl('btn-a');
    drag('Size', 1);
    tapAt(doneEl());
    await settle();
    expect(host.puts()).toHaveLength(1); // failed: a retry is pending
    tapAt(menuEl()); // back into the editor before the retry
    await settle();
    expect(editing()).toBe(true);
    selectCtl('btn-b');
    drag('Size', 0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(host.puts()).toHaveLength(1); // the retry timer did not save the draft
    h.ws().drop();
    vi.advanceTimersByTime(500);
    h.ws(1).open();
    h.ws(1).receive({ t: 'welcome', slot: 2 });
    await settle();
    expect(host.puts()).toHaveLength(1); // nor did the reconnect
    tapAt(doneEl());
    await settle();
    expect(host.puts()).toHaveLength(2); // Done saves, once, with both edits
    const saved = host.store.layouts[0]?.controls ?? [];
    expect(saved.find((c) => c.id === 'btn-a')).toMatchObject({ h: 30 });
    expect(saved.find((c) => c.id === 'btn-b')).toMatchObject({ h: 8 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.puts()).toHaveLength(2);
  });

  it('the host response replaces the draft after Done (the host is the truth)', async () => {
    await enter();
    selectCtl('btn-a');
    drag('Size', 1);
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const s = sanitizeStore(JSON.parse(String(init.body)) as LayoutStore);
        (s.layouts[0]?.controls.find((c) => c.id === 'btn-a') as Any).h = 12;
        return { ok: true, status: 200, json: async () => s };
      }
      return original(url, init);
    });
    tapAt(doneEl());
    await settle();
    expect(h.ctl('btn-a').style.getPropertyValue('--h')).toBe('12');
  });
});

describe('an old store from the complicated editor', () => {
  it('loads, plays with the forced defaults, and saves cleanly with the extra layouts untouched', async () => {
    host.store = oldStore();
    h = await mount();
    // latch and turbo are off: a tap is a plain press that releases
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    vi.advanceTimersByTime(40);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('btn-lt'), 'pointerdown', 2); // value was 90: forced to 255
    expect(h.ws().states().at(-1)?.lt).toBe(255);
    vi.advanceTimersByTime(40);
    ptr(h.ctl('btn-lt'), 'pointerup', 2);
    // floating, inverted, aggressive, dead zone 0.4 and no double tap are all forced back; sensitivity 2.5 is kept
    const c = h.at('stick-left');
    const r = ((38 * FH) / 100) / 2;
    ptr(h.ctl('stick-left'), 'pointerdown', 3, c.x, c.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 3, c.x, c.y - r * 0.2); // r 0.2: m = 0.111, x 2.5 = 0.278 (linear, up positive)
    expect(h.ws().states().at(-1)?.ly).toBe(Math.round(((0.2 - 0.1) / 0.9) * 2.5 * 32767));
    ptr(h.ctl('stick-left'), 'pointerup', 3);
    // d-pad diagonals are back on
    const dp = h.at('dpad');
    const half = (26 * FH) / 100 / 2;
    vi.advanceTimersByTime(300);
    ptr(h.ctl('dpad'), 'pointerdown', 4, dp.x + half * 0.7, dp.y + half * 0.7);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.DPAD_RIGHT | BTN.DPAD_DOWN);
    ptr(h.ctl('dpad'), 'pointerup', 4);
    // a label is rendered as stored
    expect(h.ctl('btn-a').textContent).toBe('Jump');
    // Done saves cleanly
    tapAt(menuEl());
    tapAt(doneEl());
    await settle();
    const saved = host.puts()[0] as LayoutStore;
    expect(saved.layouts).toHaveLength(LIMITS.layouts);
    expect(saved.activeId).toBe('old-1');
    fixedPoint(saved);
    for (const l of saved.layouts) {
      for (const ctl of l.controls) {
        if (ctl.type === 'button') expect(ctl).toMatchObject({ latch: false, turbo: false, value: 255 });
        if (ctl.type === 'stick') expect(ctl).toMatchObject({ mode: 'fixed', curve: 'linear', invertX: false, invertY: false, deadzone: 0.1, doubleTapClick: true });
        if (ctl.type === 'dpad') expect(ctl.diagonals).toBe(true);
      }
    }
  });
});

describe('a short phone (874x320)', () => {
  it('draws the same layout in the smaller field and every control still works', async () => {
    h = await mount({ w: 874, h: 320 });
    expect(document.documentElement.style.getPropertyValue('--u')).toBe((3.2).toFixed(4) + 'px');
    const c = h.at('stick-right');
    ptr(h.ctl('stick-right'), 'pointerdown', 1, c.x, c.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-right'), 'pointermove', 1, c.x + (30 * 3.2) / 2, c.y);
    expect(h.ws().states().at(-1)?.rx).toBe(32767);
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
