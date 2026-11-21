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
  /** Echo every {"t":"p","n":N} back like the host does; a test that wants a dead link sets this to false. */
  static echo = true;
  readyState = 0;
  sent: string[] = [];
  /** The link probes, kept apart from `sent` so frame counts stay about pad traffic. */
  pings: number[] = [];
  times: number[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(s: string): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    const probe = /^\{"t":"p","n":(\d+)\}$/.exec(s);
    if (probe) {
      const n = Number(probe[1]);
      this.pings.push(n);
      if (FakeSocket.echo) setTimeout(() => this.readyState === 1 && this.receive({ t: 'p', n }), 0);
      return;
    }
    this.sent.push(s);
    this.times.push(Date.now());
  }
  close(): void {
    this.closed = true;
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onclose?.({ code: 1005, reason: '' });
    }
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(o: unknown): void {
    this.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) });
  }
  drop(reason = '', code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
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
  calls: Array<{ method: string; path: string; token: string | null; id: string | null; body?: LayoutStore }>;
  puts(): LayoutStore[];
}
let host: FakeHost;

function installFetch(): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://192.168.1.20:47921');
    const method = init?.method ?? 'GET';
    const call: FakeHost['calls'][number] = { method, path: u.pathname, token: u.searchParams.get('t'), id: u.searchParams.get('id') };
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
let standaloneNow = false;
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
  FakeSocket.echo = true;
  portraitNow = false;
  mqListeners = new Set();
  visibility = 'visible';
  storage = new Map();
  vibrate = null;
  host = { store: planStore(), getStatus: 200, putFail: 0, calls: [], puts: () => host.calls.filter((c) => c.method === 'PUT').map((c) => c.body as LayoutStore) };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  installFetch();
  vi.stubGlobal('WebSocket', FakeSocket);
  standaloneNow = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('display-mode') ? query.includes('standalone') && standaloneNow : portraitNow;
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
  delete (navigator as Any).standalone;
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
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; manifest-src 'self'; media-src 'self'",
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
    expect(html).toMatch(/<link rel="manifest" href="manifest\.webmanifest">/);
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
    expect(script).not.toMatch(/requestAnimationFrame|cancelAnimationFrame|getCoalescedEvents/);
    const body = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^"use strict";\s*/, '');
    expect(body.trimStart().startsWith('(() => {')).toBe(true);
  });

  it('css follows the cleanup rules: no gradient, blur, shadow or animation; 3 radii, 4 type sizes, 2 weights, 5 spacing steps', () => {
    expect(css).not.toMatch(/gradient|backdrop-filter|filter:\s*blur|box-shadow|text-shadow|@keyframes|animation/);
    const decls = [...css.matchAll(/(?:^|[;{}\s])([a-z-]+)\s*:\s*([^;{}]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()] as const);
    const bad: string[] = [];
    const px = (v: string): number[] => [...v.replace(/(?:max|min|calc|env|var)\([^)]*\)/g, '').matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    for (const [prop, v] of decls) {
      if (prop === 'border-radius') for (const t of v.split(/\s+/)) if (!['0', '6px', '8px', '999px', '50%', 'inherit'].includes(t)) bad.push(prop + ': ' + v);
      if (prop === 'font-size' && /^\d/.test(v) && ![13, 15, 17, 22].includes(Number.parseFloat(v))) bad.push(prop + ': ' + v);
      if (prop === 'font-weight' && ![400, 600].includes(Number(v))) bad.push(prop + ': ' + v);
      if (/^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(prop)) for (const n of px(v)) if (![0, 4, 8, 12, 16, 24].includes(Math.abs(n))) bad.push(prop + ': ' + v);
    }
    expect(bad).toEqual([]);
    expect(decls.filter(([p]) => p === 'font-size').length).toBeGreaterThan(5); // the scan did read the file
  });

  it('has no emoji or symbol glyphs in the markup, and no animation on the rotate overlay', () => {
    expect(html).not.toMatch(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u25CF]/u);
    expect(rule('.phone-icon')).not.toMatch(/animation/);
    expect(rule('.phone-icon')).toMatch(/rotate\(90deg\)/); // drawn sideways, not turning
  });

  it('manifest: fullscreen, 192 and 512 icons that exist, and NO start_url (the saved URL keeps ?t=)', () => {
    const m = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
    expect(m).not.toHaveProperty('start_url');
    expect(m['display']).toBe('fullscreen');
    const icons = m['icons'] as Array<{ src: string; sizes: string }>;
    for (const size of ['192x192', '512x512']) expect(icons.some((i) => i.sizes === size)).toBe(true);
    for (const i of icons) expect(() => readFileSync(join(UI_DIR, i.src))).not.toThrow();
    const png = (f: string): [number, number] => {
      const b = readFileSync(join(UI_DIR, f));
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    expect(png('icon-192.png')).toEqual([192, 192]);
    expect(png('icon-512.png')).toEqual([512, 512]);
  });

  it('wake.mp4 is a real mp4, and the build copies every page file', () => {
    expect(readFileSync(join(UI_DIR, 'wake.mp4')).subarray(4, 8).toString('latin1')).toBe('ftyp');
    const copy = readFileSync(join(ROOT, 'src', 'renderer', 'copy-static.mjs'), 'utf8');
    for (const f of ['index.html', 'controller.css', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'wake.mp4', 'manifest.webmanifest']) expect(copy, f).toContain("'" + f + "'");
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
  it('keeps every stored value: nothing is forced back to a default, and the store stays a sanitizer fixed point', () => {
    const s = T.coerceStore(oldStore()) as LayoutStore;
    expect(s).toEqual(oldStore());
    expect(s.layouts).toHaveLength(LIMITS.layouts);
    expect(s.activeId).toBe('old-1');
    const c = (id: string) => s.layouts[0]?.controls.find((x) => x.id === id);
    expect(c('btn-lt')).toMatchObject({ latch: true, turbo: true, value: 90 });
    expect(c('stick-left')).toMatchObject({ mode: 'floating', curve: 'aggressive', invertX: true, invertY: true, deadzone: 0.4, doubleTapClick: false, sensitivity: 2.5 });
    expect(c('dpad')).toMatchObject({ diagonals: false });
    expect(c('btn-a')).toMatchObject({ label: 'Jump', shape: 'circle', w: 16, h: 16 });
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

describe('control operations behind the More panel', () => {
  const ctl = (st: LayoutStore, id: string): Any => T.activeLayout(st).controls.find((c: { id: string }) => c.id === id);

  it('setProps writes validated values (clamped, unknown keys ignored) and every result is a sanitizer fixed point', () => {
    let st = T.setProps(planStore(), 'btn-a', { latch: true, shape: 'pill', w: 3, label: 'Jumping!', bogus: 1 });
    expect(ctl(st, 'btn-a')).toMatchObject({ latch: true, shape: 'pill', w: LIMITS.size.min, label: 'Jumpin' });
    expect(ctl(st, 'btn-a').bogus).toBeUndefined();
    fixedPoint(st);
    st = T.setProps(st, 'stick-left', { deadzone: 0.9, sensitivity: 9, curve: 'nope', invertX: true, mode: 'floating', stick: 'right', doubleTapClick: false });
    expect(ctl(st, 'stick-left')).toMatchObject({ deadzone: 0.5, sensitivity: 3, curve: 'linear', invertX: true, mode: 'floating', stick: 'right', doubleTapClick: false });
    st = T.setProps(st, 'dpad', { diagonals: false });
    expect(ctl(st, 'dpad').diagonals).toBe(false);
    st = T.setProps(st, 'btn-lt', { value: 1000 });
    expect(ctl(st, 'btn-lt').value).toBe(255);
    fixedPoint(st);
  });

  it('is a no-op (the same store) for nothing to change, an unknown control or a wrong kind of property', () => {
    const st = planStore();
    expect(T.setProps(st, 'btn-a', { latch: false })).toBe(st);
    expect(T.setProps(st, 'nope', { latch: true })).toBe(st);
    expect(T.setProps(st, 'dpad', { latch: true, label: 'x' })).toBe(st);
    expect(T.setProps(st, 'btn-a', { shape: 'blob' })).toBe(st);
  });

  it('a new mapping renames the button, unless the player gave it a label of their own', () => {
    let st = T.setProps(planStore(), 'btn-a', { button: 'B' });
    expect(ctl(st, 'btn-a')).toMatchObject({ button: 'B', label: 'B' });
    st = T.setProps(T.setProps(planStore(), 'btn-a', { label: 'Jump' }), 'btn-a', { button: 'X' });
    expect(ctl(st, 'btn-a')).toMatchObject({ button: 'X', label: 'Jump' });
    st = T.setProps(planStore(), 'btn-start', { button: 'BACK' });
    expect(ctl(st, 'btn-start')).toMatchObject({ button: 'BACK', label: 'Back' });
    st = T.setProps(planStore(), 'btn-a', { button: 'Y', label: 'Fire' });
    expect(ctl(st, 'btn-a').label).toBe('Fire');
    st = T.setProps(T.setProps(planStore(), 'btn-a', { label: 'Jump' }), 'btn-a', { label: '' });
    expect(ctl(st, 'btn-a').label).toBe('A'); // an empty label is the button's own name
    fixedPoint(st);
  });

  it('a circle is always round: choosing it squares the button to its height', () => {
    const st = T.setProps(planStore(), 'btn-lt', { shape: 'circle' });
    expect(ctl(st, 'btn-lt')).toMatchObject({ shape: 'circle', w: 13, h: 13 });
    const pill = T.setProps(planStore(), 'btn-a', { shape: 'pill' });
    expect(ctl(pill, 'btn-a')).toMatchObject({ shape: 'pill', w: 16, h: 16 });
  });

  it('a wider control is pulled back on screen', () => {
    const st = T.setProps(planStore(), 'btn-rt', { w: 40 }, 2);
    expect(ctl(st, 'btn-rt').x).toBeLessThanOrEqual(100 - 40 / 2 / 2);
  });

  it('Mode is one of Hold / Toggle / Rapid fire, and the stored flags map onto it', () => {
    expect(T.modePatch('hold')).toEqual({ latch: false, turbo: false });
    expect(T.modePatch('toggle')).toEqual({ latch: true, turbo: false });
    expect(T.modePatch('rapid')).toEqual({ latch: false, turbo: true });
    expect(T.buttonMode({ latch: false, turbo: false })).toBe('hold');
    expect(T.buttonMode({ latch: true, turbo: false })).toBe('toggle');
    expect(T.buttonMode({ latch: false, turbo: true })).toBe('rapid');
    expect(T.buttonMode({ latch: true, turbo: true })).toBe('toggle'); // both stored: the toggle shows, picking any one normalises
  });

  it('addControl puts a new control in the middle: the first free button, the free side of a stick; null when the layout is full', () => {
    const base = planStore();
    const b = T.addControl(base, 'button');
    expect(ctl(b.store, b.id)).toMatchObject({ type: 'button', x: 50, y: 50, button: 'L3' }); // the ten stock buttons are taken; L3 is the first free name
    expect(T.activeLayout(b.store).controls).toHaveLength(14);
    const s = T.addControl(T.setProps(base, 'stick-right', { stick: 'left' }), 'stick');
    expect(ctl(s.store, s.id)).toMatchObject({ type: 'stick', stick: 'right', x: 50, y: 50 }); // the left one is taken
    const d = T.addControl(base, 'dpad');
    expect(ctl(d.store, d.id)).toMatchObject({ type: 'dpad', size: 26, diagonals: true });
    expect(new Set(T.activeLayout(d.store).controls.map((c: Any) => c.id)).size).toBe(14); // unique ids
    for (const r of [b, s, d]) fixedPoint(r.store);
    let full = base;
    for (let i = T.activeLayout(base).controls.length; i < LIMITS.controls; i++) full = T.addControl(full, 'dpad').store;
    expect(T.activeLayout(full).controls).toHaveLength(LIMITS.controls);
    expect(T.addControl(full, 'button')).toBeNull();
    expect(T.duplicateControl(full, 'dpad')).toBeNull();
    fixedPoint(full);
  });

  it('duplicateControl copies a control a little aside under a new id; deleteControl removes it', () => {
    const base = planStore();
    const r = T.duplicateControl(base, 'btn-a');
    expect(r.id).not.toBe('btn-a');
    expect(ctl(r.store, r.id)).toMatchObject({ ...ctl(base, 'btn-a'), id: r.id, x: 89, y: 82.5 });
    fixedPoint(r.store);
    const again = T.duplicateControl(r.store, 'btn-a');
    expect(new Set(T.activeLayout(again.store).controls.map((c: Any) => c.id)).size).toBe(15);
    expect(T.duplicateControl(base, 'nope')).toBeNull();
    const gone = T.deleteControl(r.store, r.id);
    expect(T.activeLayout(gone).controls).toHaveLength(13);
    expect(T.deleteControl(base, 'nope')).toBe(base);
    expect(T.deleteControl(base, 'btn-a')).not.toBe(base);
  });

  it('the Width / Height range keeps a stored value, a wrapped choice row is a label plus lines of chips, a floating stick has a bigger touch area', () => {
    expect(T.dimRange(20)).toEqual({ min: 8, max: 40 });
    expect(T.dimRange(5)).toEqual({ min: 5, max: 40 });
    expect(T.dimRange(60)).toEqual({ min: 8, max: 60 });
    expect(T.gridHeight(12)).toBe(24 + 2 * 44 + 4);
    expect(T.gridHeight(6)).toBe(24 + 44);
    const stick = ctl(planStore(), 'stick-left');
    expect(T.controlBox(stick)).toEqual([38, 38]);
    expect(T.controlBox({ ...stick, mode: 'floating' })).toEqual([38 * T.FLOATING_ZONE, 38 * T.FLOATING_ZONE]);
  });

  it('cardHeight is the padding plus the rows, never taller than the room (the card scrolls then)', () => {
    expect(T.cardHeight([44, 44, 44], 1000)).toBe(T.CARD_PAD + 132);
    expect(T.cardHeight([44, 44, 44, 44, 44, 44, 44, 44], 300)).toBe(300);
    expect(T.cardHeight([44], -50)).toBe(44);
  });

  it('floatingCentre follows the finger but keeps the whole base inside the touch area', () => {
    expect(T.floatingCentre(110, 100, 60, 40)).toBe(110);
    expect(T.floatingCentre(500, 100, 60, 40)).toBe(120);
    expect(T.floatingCentre(-500, 100, 60, 40)).toBe(80);
    expect(T.floatingCentre(500, 100, 30, 40)).toBe(100); // a base bigger than its area stays put
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

  it('knows iOS devices, including an iPad that says it is a Mac', () => {
    expect(T.isIosDevice(IPHONE_UA, 5)).toBe(true);
    expect(T.isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5)).toBe(true);
    expect(T.isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0)).toBe(false);
    expect(T.isIosDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 5)).toBe(false);
  });

  it('Add to Home Screen: the steps on iOS, the install prompt where Chrome gave one, nothing when installed or elsewhere', () => {
    expect(T.homeScreenMode(IPHONE_UA, 5, false, false)).toBe('sheet');
    expect(T.homeScreenMode(IPHONE_UA, 5, true, false)).toBeNull(); // already opened from the home screen
    expect(T.homeScreenMode('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 5, false, true)).toBe('prompt');
    expect(T.homeScreenMode('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 5, true, true)).toBeNull();
    expect(T.homeScreenMode('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 5, false, false)).toBe('steps'); // no install prompt on a LAN address: text steps
    expect(T.homeScreenMode('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 5, true, false)).toBeNull();
    expect(T.homeScreenMode('Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0', 0, false, false)).toBeNull();
  });

  it('describes when a switch click arrived relative to the touch', () => {
    expect(T.describeSwitchClick(1000, 1004)).toBe('click 4 ms after touch (on press)');
    expect(T.describeSwitchClick(1000, 1087)).toBe('click 87 ms after touch (on release)');
    expect(T.describeSwitchClick(null, 1087)).toBe('click, touch time unknown');
    expect(T.describeSwitchClick(2000, 1087)).toBe('click, touch time unknown');
  });
});

describe('createHaptics with fake sinks', () => {
  function rig(mode: 'android' | 'ios' | 'none', enabled = () => true) {
    const calls: Array<[string, number]> = [];
    const hz = T.createHaptics({
      mode,
      enabled: () => enabled(),
      vibrate: (ms: number) => calls.push(['vibrate', ms]),
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

  /** A finger streaming pointermoves at 120 Hz (iPhone 17 ProMotion) for `ms`, at deflection d. */
  function stream(hz: { setStick(d: number): void }, d: number, ms: number): void {
    for (let t = 0; t < ms; t += 8) {
      vi.advanceTimersByTime(8);
      hz.setStick(d);
    }
  }

  it('iOS: nothing is made from script (no tick, no stick ramp, no timer): the ticks are real touches on the overlays', () => {
    const timers: number[] = [];
    const calls: string[] = [];
    const hz = T.createHaptics({
      mode: 'ios',
      enabled: () => true,
      vibrate: () => calls.push('vibrate'),
      now: () => Date.now(),
      setTimer: (_fn: () => void, ms: number) => timers.push(ms),
      clearTimer: () => undefined,
    });
    hz.tick();
    hz.setStick(1);
    stream(hz, 1, 500);
    hz.stop();
    expect(calls).toEqual([]);
    expect(timers).toEqual([]);
  });

  it('Android keeps ONE timer while a stick streams moves (no clear/set per pointermove)', () => {
    let sets = 0;
    const hz = T.createHaptics({
      mode: 'android',
      enabled: () => true,
      vibrate: () => undefined,
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

  it('never throws when a sink throws or when the platform has no haptics', () => {
    const bad = T.createHaptics({
      mode: 'android',
      enabled: () => true,
      vibrate: () => {
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
    expect(T.statusText('connecting', null)).toBe('Connecting...');
    expect(T.statusText('connected', 2)).toBe('Player 2');
    expect(T.statusText('retrying', null)).toBe('Disconnected — retrying...');
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
    expect(h.ws().frames()).toEqual([{ t: 'hello', name: expect.stringMatching(/^Phone \d{2}$/), id: expect.stringMatching(/^[A-Za-z0-9_-]{16,32}$/) }]);
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

  it('dead zone, curve, sensitivity and inversion come from the layout', async () => {
    host.store = sanitizeStore({ version: 1, activeId: 'default', layouts: [{ ...planLayoutRaw(), controls: planLayoutRaw().controls.map((c: Any) => (c.type === 'stick' ? { ...c, sensitivity: 2, curve: 'aggressive', invertY: true, deadzone: 0.4 } : c)) }] });
    h = await mount();
    const c = h.at('stick-left');
    const r = R('stick-left');
    ptr(h.ctl('stick-left'), 'pointerdown', 1, c.x, c.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 1, c.x, c.y - r / 4); // r = 0.25 is inside the 0.4 dead zone
    expect(last().ly).toBe(0);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 1, c.x, c.y - r * 0.7); // m = 0.5, sqrt = 0.7071, x2 -> full, up inverted to negative
    expect(last().ly).toBe(-32767);
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

/** The stock store with some properties of some controls changed (through the host's own sanitizer). */
function customStore(patches: Record<string, Record<string, unknown>>): LayoutStore {
  const raw = planLayoutRaw();
  raw.controls = raw.controls.map((c: { id: string }) => (patches[c.id] ? { ...c, ...patches[c.id] } : c));
  return sanitizeStore({ version: 1, activeId: 'default', layouts: [raw] });
}

describe('play: the More options really change how a control plays', () => {
  const last = (): PadState => h.ws().states().at(-1) as PadState;
  const stateCount = (): number => h.ws().states().length;

  it('Toggle: one tap holds the button, the next tap lets go; lifting the finger changes nothing', async () => {
    host.store = customStore({ 'btn-a': { latch: true } });
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(last().buttons).toBe(BTN.A);
    expect(h.ctl('btn-a').getAttribute('aria-pressed')).toBe('true');
    vi.advanceTimersByTime(100);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    vi.advanceTimersByTime(300);
    expect(last().buttons).toBe(BTN.A);
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(true);
    ptr(h.ctl('btn-a'), 'pointerdown', 2);
    expect(last().buttons).toBe(0);
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(false);
    ptr(h.ctl('btn-a'), 'pointerup', 2);
    vi.advanceTimersByTime(300);
    expect(last().buttons).toBe(0);
  });

  it('a held toggle is let go by every safety release (a switched-on button must never be stuck)', async () => {
    host.store = customStore({ 'btn-a': { latch: true } });
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(last().buttons).toBe(BTN.A);
    window.dispatchEvent(new Event('blur'));
    expect(last().buttons).toBe(0);
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(false);
    vi.advanceTimersByTime(300);
    ptr(h.ctl('btn-a'), 'pointerdown', 2); // a fresh tap switches it on again, it does not toggle "off"
    expect(last().buttons).toBe(BTN.A);
  });

  it('Rapid fire: the button blinks 50 ms on, 50 ms off while held, and the blinking stops with the finger', async () => {
    host.store = customStore({ 'btn-x': { turbo: true } });
    h = await mount();
    ptr(h.ctl('btn-x'), 'pointerdown', 1);
    expect(last().buttons).toBe(BTN.X);
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(50);
      seen.push(last().buttons);
    }
    expect(seen).toEqual([0, BTN.X, 0, BTN.X, 0, BTN.X]);
    expect(h.ctl('btn-x').classList.contains('is-down')).toBe(true); // it stays lit: only the output blinks
    ptr(h.ctl('btn-x'), 'pointerup', 1);
    vi.advanceTimersByTime(5); // the frame may wait out the 1/240 s gap behind the blink that was just sent
    expect(last().buttons).toBe(0);
    const n = stateCount();
    vi.advanceTimersByTime(1000);
    expect(stateCount()).toBe(n); // no timer left running
    ptr(h.ctl('btn-x'), 'pointerdown', 2); // and the next press starts on, not mid-blink
    expect(last().buttons).toBe(BTN.X);
  });

  it('a plain button does not blink, and rapid fire on one button leaves the others alone', async () => {
    host.store = customStore({ 'btn-x': { turbo: true } });
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    ptr(h.ctl('btn-x'), 'pointerdown', 2);
    vi.advanceTimersByTime(50);
    expect(last().buttons).toBe(BTN.A);
    vi.advanceTimersByTime(50);
    expect(last().buttons).toBe(BTN.A | BTN.X);
  });

  it('Trigger strength: LT and RT send the stored value instead of 255; the stronger of two LT buttons wins', async () => {
    host.store = customStore({ 'btn-lt': { value: 128 }, 'btn-rt': { value: 1 }, 'btn-lb': { button: 'LT', value: 200 } });
    h = await mount();
    ptr(h.ctl('btn-lt'), 'pointerdown', 1);
    expect(last().lt).toBe(128);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('btn-lb'), 'pointerdown', 2);
    expect(last().lt).toBe(200);
    ptr(h.ctl('btn-rt'), 'pointerdown', 3);
    vi.advanceTimersByTime(10);
    expect(last().rt).toBe(1);
  });

  it('Floating stick: the base appears under the finger (kept inside the touch area) and the stick is measured from there', async () => {
    host.store = customStore({ 'stick-left': { mode: 'floating' } });
    h = await mount();
    const el = h.ctl('stick-left');
    expect(el.classList.contains('is-floating')).toBe(true);
    expect(el.style.getPropertyValue('--w')).toBe(String(38 * T.FLOATING_ZONE)); // the touch area is bigger than the base
    const c = h.at('stick-left');
    const r = ((38 * FH) / 100) / 2;
    ptr(el, 'pointerdown', 1, c.x + 20, c.y - 10); // the first touch is the middle: nothing is pulled
    expect(last()).toMatchObject({ lx: 0, ly: 0 });
    const base = el.querySelector('.stick-base') as HTMLElement;
    expect(base.style.transform).toBe('translate3d(20.0px,-10.0px,0)');
    vi.advanceTimersByTime(10);
    ptr(el, 'pointermove', 1, c.x + 20 + r, c.y - 10);
    expect(last().lx).toBe(32767);
    ptr(el, 'pointerup', 1);
    expect(base.style.transform).toBe(''); // the base goes back to the middle of its area
    vi.advanceTimersByTime(300);
    // a touch at the very edge of the area: the base stops inside it, so the same finger is already pulling
    const slack = r * T.FLOATING_ZONE - r;
    ptr(el, 'pointerdown', 2, c.x + slack + r / 2, c.y);
    expect(base.style.transform).toBe('translate3d(' + slack.toFixed(1) + 'px,0.0px,0)');
    expect(last().lx).toBeGreaterThan(0);
    expect(last().lx).toBeLessThan(32767);
  });

  it('a fixed stick is unchanged: measured from the middle of the control', async () => {
    h = await mount();
    const el = h.ctl('stick-left');
    expect(el.classList.contains('is-floating')).toBe(false);
    const c = h.at('stick-left');
    ptr(el, 'pointerdown', 1, c.x + 30, c.y);
    expect(last().lx).toBeGreaterThan(0);
    expect((el.querySelector('.stick-base') as HTMLElement).style.transform).toBe('');
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
    expect(second.frames()).toEqual([{ t: 'hello', name, id: h.ws(0).frames()[0]?.['id'] }]); // the same phone id
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

describe('replaced by another tab of the same phone is final', () => {
  it('close reason "replaced": no reconnect, one-line notice, Reconnect button; Reconnect starts a new socket', async () => {
    h = await mount();
    const ws = h.ws();
    const n = ws.sent.length;
    ws.drop('replaced', 1000);
    expect(noticeVisible()).toBe(true);
    expect(document.getElementById('notice-text')?.textContent).toBe('Open in another tab');
    const btn = document.getElementById('retry') as HTMLElement;
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe('Reconnect');
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(ws.sent.length).toBe(n);
    vi.advanceTimersByTime(120_000);
    window.dispatchEvent(new Event('online'));
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(1);
    tapAt(btn);
    expect(FakeSocket.all).toHaveLength(2);
    expect(noticeVisible()).toBe(false);
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.receive({ t: 'welcome', slot: 1 });
    expect(noticeVisible()).toBe(false);
  });
  it('any other close (network, idle) still retries', async () => {
    h = await mount();
    h.ws().drop('', 1006);
    expect(noticeVisible()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all.length).toBeGreaterThan(1);
    h.ws().drop('idle', 1001);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all.length).toBeGreaterThan(2);
  });
  it('a stale socket closing with "replaced" after the page already moved on is ignored', async () => {
    h = await mount();
    const old = h.ws();
    old.drop('', 1006); // the page drops it and reconnects
    vi.advanceTimersByTime(10_000);
    const next = FakeSocket.all[FakeSocket.all.length - 1]!;
    expect(next).not.toBe(old);
    old.onclose?.({ code: 1000, reason: 'replaced' });
    expect(noticeVisible()).toBe(false);
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

describe('haptics in the page (iOS: a real touch on a switch laid over the control)', () => {
  const iosPage = async (opts: Parameters<typeof mount>[0] = {}): Promise<void> => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
    h = await mount(opts);
  };
  const overlayOf = (id: string): HTMLInputElement | undefined => [...h.ctl(id).children].find((c) => c.classList.contains('haptic-switch')) as HTMLInputElement | undefined;
  const overlays = (): HTMLInputElement[] => [...document.querySelectorAll<HTMLInputElement>('input.haptic-switch')];

  it('every button and the d-pad carry one transparent checkbox switch as a child; sticks and the page body carry none', async () => {
    await iosPage();
    const ids = BUTTON_SPECS.map(([id]) => id).concat('dpad');
    for (const id of ids) {
      const sw = overlayOf(id);
      expect(sw, id).toBeTruthy();
      expect(sw?.type).toBe('checkbox');
      expect(sw?.hasAttribute('switch')).toBe(true);
      expect(sw?.getAttribute('tabindex')).toBe('-1');
      expect(sw?.getAttribute('aria-hidden')).toBe('true');
      expect([...h.ctl(id).children].filter((c) => c.classList.contains('haptic-switch'))).toHaveLength(1);
    }
    expect(overlays()).toHaveLength(ids.length);
    expect(overlayOf('stick-left')).toBeUndefined();
    expect(overlayOf('stick-right')).toBeUndefined();
    expect(document.querySelector('label.haptic-switch')).toBeNull(); // the old hidden label is gone
    expect(h.ctl('btn-a').textContent).toBe('A'); // the label text is still the label
  });

  it('there are none on Android, on a desktop, or with haptics off in the layout', async () => {
    stubVibrate();
    h = await mount();
    expect(overlays()).toHaveLength(0);
    h.destroy();
    delete (navigator as Any).vibrate;
    vibrate = null;
    h = await mount();
    expect(overlays()).toHaveLength(0); // jsdom-like user agent: no platform haptics
    h.destroy();
    host.store = T.setHaptics(planStore(), false);
    await iosPage();
    expect(overlays()).toHaveLength(0);
  });

  it('a touch that lands on the switch still plays the control: the press is sent, the control is lit, the switch is not captured away', async () => {
    await iosPage();
    const sw = overlayOf('btn-a') as HTMLInputElement;
    const capture = vi.fn();
    (h.ctl('btn-a') as Any).setPointerCapture = capture;
    ptr(sw, 'pointerdown', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(true);
    expect(capture).not.toHaveBeenCalled(); // capturing it to the control would aim the browser's click away from the switch
    vi.advanceTimersByTime(40);
    ptr(sw, 'pointerup', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    ptr(h.ctl('btn-b'), 'pointerdown', 2); // a touch on the control itself (not the switch) is captured as before
    expect((h.ctl('btn-b') as Any).setPointerCapture).toBeTypeOf('function');
    const cap2 = vi.fn();
    (h.ctl('btn-x') as Any).setPointerCapture = cap2;
    ptr(h.ctl('btn-x'), 'pointerdown', 3);
    expect(cap2).toHaveBeenCalledWith(3);
  });

  it('the d-pad keeps working through its switch: the finger slides between directions', async () => {
    await iosPage();
    const dp = h.at('dpad');
    const half = (26 * FH) / 100 / 2;
    const sw = overlayOf('dpad') as HTMLInputElement;
    ptr(sw, 'pointerdown', 1, dp.x + half * 0.7, dp.y);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.DPAD_RIGHT);
    vi.advanceTimersByTime(10); // past the 1/240 s send gap
    ptr(sw, 'pointermove', 1, dp.x, dp.y - half * 0.7);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.DPAD_UP);
    vi.advanceTimersByTime(10);
    ptr(sw, 'pointerup', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
  });

  it('never cancels touchstart or touchmove on a switch (that would stop the click and so the tick); everything else is still cancelled', async () => {
    await iosPage();
    for (const type of ['touchstart', 'touchmove']) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      (overlayOf('btn-a') as HTMLInputElement).dispatchEvent(e);
      expect(e.defaultPrevented, type + ' on the switch').toBe(false);
    }
    const onControl = new Event('touchstart', { bubbles: true, cancelable: true });
    h.ctl('stick-left').dispatchEvent(onControl);
    expect(onControl.defaultPrevented).toBe(true);
    const move = new Event('touchmove', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 4, pointerType: 'touch' });
    (overlayOf('btn-a') as HTMLInputElement).dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(false); // the pointer handlers are passive and never cancel
  });

  it('a click on a switch is its own business: it stays off the control, and the switch is switched off again before the next touch', async () => {
    await iosPage();
    const sw = overlayOf('btn-a') as HTMLInputElement;
    const seen = vi.fn();
    h.ctl('btn-a').addEventListener('click', seen);
    document.body.addEventListener('click', seen);
    ptr(sw, 'pointerdown', 1);
    sw.click(); // the browser's own click: the switch turns on
    expect(sw.checked).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    ptr(sw, 'pointerup', 1);
    ptr(sw, 'pointerdown', 2);
    expect(sw.checked).toBe(false); // so its state never matters
  });

  it('nothing is ticked from script any more: no click on any input or label, whatever is pressed', async () => {
    await iosPage();
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    const c = h.at('stick-left');
    ptr(h.ctl('stick-left'), 'pointerdown', 2, c.x, c.y);
    ptr(h.ctl('stick-left'), 'pointermove', 2, c.x + 60, c.y);
    vi.advanceTimersByTime(1000);
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('the overlays are gone while editing and back after Done; switching haptics off removes them', async () => {
    await iosPage();
    tapAt(menuEl());
    await settle();
    expect(overlays()).toHaveLength(0); // a touch in the editor selects and drags, it must not tick
    tapAt(cardEl().querySelector('.switch') as Element); // haptics off
    tapAt(doneEl());
    await settle();
    expect(overlays()).toHaveLength(0);
    tapAt(menuEl());
    await settle();
    tapAt(cardEl().querySelector('.switch') as Element); // haptics on again
    tapAt(doneEl());
    await settle();
    expect(overlays()).toHaveLength(11);
  });

  it('a cancelled touch on a switch releases only that control: the stick under the other thumb keeps playing', async () => {
    // The touch on a switch is not cancelled at touchstart, so iOS may still claim it for a native gesture (pointercancel).
    await iosPage();
    const c = h.at('stick-left');
    ptr(h.ctl('stick-left'), 'pointerdown', 1, c.x, c.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 1, c.x, c.y - 200);
    vi.advanceTimersByTime(10);
    const sw = overlayOf('btn-a') as HTMLInputElement;
    ptr(sw, 'pointerdown', 2);
    expect(h.ws().states().at(-1)).toMatchObject({ buttons: BTN.A, ly: 32767 });
    vi.advanceTimersByTime(40);
    ptr(sw, 'pointercancel', 2);
    expect(h.ws().states().at(-1)).toMatchObject({ buttons: 0, ly: 32767 });
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 1, c.x + 200, c.y);
    expect(h.ws().states().at(-1)).toMatchObject({ buttons: 0, lx: 32767, ly: 0 });
    ptr(h.ctl('btn-b'), 'pointercancel', 1); // a cancel anywhere else still releases everything
    expect(h.ws().states().at(-1)).toMatchObject(NEUTRAL);
  });

  it('a button re-labelled in the editor keeps its overlay', async () => {
    await iosPage();
    tapAt(menuEl());
    await settle();
    const c = h.at('btn-a');
    ptr(h.ctl('btn-a'), 'pointerdown', 20, c.x, c.y);
    ptr(h.ctl('btn-a'), 'pointerup', 20, c.x, c.y);
    tapAt(cardEl().querySelector('.more') as Element);
    const input = cardEl().querySelector('.card-input') as HTMLInputElement;
    input.value = 'Jump';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    tapAt(doneEl());
    await settle();
    expect(h.ctl('btn-a').textContent).toBe('Jump');
    expect(overlayOf('btn-a')).toBeTruthy();
  });
});

describe('?diag=1', () => {
  it('Android: the switch test and four vibrate buttons; 1 from click, 2 from pointerdown, 3 while dragging, 4 ten times from a timer', async () => {
    stubVibrate();
    h = await mount({ search: '&diag=1' });
    const b = (n: number): HTMLElement => document.getElementById('diag-' + n) as HTMLElement;
    expect([1, 2, 3, 4].map((n) => !!document.getElementById('diag-' + n))).toEqual([true, true, true, true]);
    expect(document.querySelector('.diag-test input.haptic-switch')).toBeTruthy();
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

  it('iOS: a big test switch reports whether its click arrived and how long after the touch; a second line counts the controls\' clicks', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
    h = await mount({ search: '&diag=1' });
    expect([1, 2, 3, 4].map((n) => document.getElementById('diag-' + n))).toEqual([null, null, null, null]); // script ticks cannot work there
    const out = (): string => document.querySelector('.diag-out')?.textContent ?? '';
    expect(out()).toBe('test switch: no click yet\ncontrols: no click yet');
    const test = document.querySelector('.diag-test input.haptic-switch') as HTMLInputElement;
    ptr(test, 'pointerdown', 1);
    vi.advanceTimersByTime(80);
    test.click();
    expect(out()).toBe('test switch: 1 click, click 80 ms after touch (on release)\ncontrols: no click yet');
    ptr(test, 'pointerdown', 2);
    test.click();
    expect(out().split('\n')[0]).toBe('test switch: 2 clicks, click 0 ms after touch (on press)');
    const sw = [...h.ctl('btn-a').children].find((c) => c.classList.contains('haptic-switch')) as HTMLInputElement;
    ptr(sw, 'pointerdown', 3);
    vi.advanceTimersByTime(55);
    sw.click();
    expect(out().split('\n')[1]).toBe('controls: 1 click, click 55 ms after touch (on release)');
  });

  it('is absent without the parameter', async () => {
    h = await mount();
    expect(document.getElementById('diag-1')).toBeNull();
    expect(document.querySelector('.diag')).toBeNull();
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
    const w = parseFloat(cardEl().style.width);
    const hh = parseFloat(cardEl().style.height);
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

  it('with nothing selected, the settings card shows slots 1 2 3, Reset, Stick sensitivity, Haptics and Link, centred', async () => {
    rect(doneEl(), FW / 2 - 54, 4, 108, 52); // Done sits at the top centre: the card starts below it
    await enter();
    expect(cardEl().hidden).toBe(false);
    expect(cardEl().classList.contains('is-settings')).toBe(true);
    expect([...cardEl().querySelectorAll('.slot')].map((b) => b.textContent)).toEqual(['1', '2', '3']);
    expect([...cardEl().querySelectorAll('.slot')].map((b) => b.classList.contains('is-empty'))).toEqual([false, true, true]);
    expect(cardEl().querySelector('.reset')?.textContent).toBe('Reset');
    expect(valueOf('Stick sensitivity')).toBe('1.0');
    expect(cardEl().querySelector('.switch')?.getAttribute('aria-checked')).toBe('true');
    expect(cardEl().style.left).toBe(String(FW / 2) + 'px');
    // it sits where it hides the least, so every control can still be tapped to select it: the centre of each stays clear, and at
    // least two thirds of each is in the open
    const b = cardBox();
    for (const c of T.activeLayout(host.store).controls) {
      const [w, hh] = T.controlBox(c) as [number, number];
      const cx = (c.x / 100) * FW;
      const cy = (c.y / 100) * FH;
      const [bw, bh] = [(w * FH) / 100, (hh * FH) / 100];
      const ox = Math.max(0, Math.min(cx + bw / 2, b.r) - Math.max(cx - bw / 2, b.l));
      const oy = Math.max(0, Math.min(cy + bh / 2, b.b) - Math.max(cy - bh / 2, b.t));
      expect(cx > b.l && cx < b.r && cy > b.t && cy < b.b, c.id + ' centre').toBe(false);
      expect((ox * oy) / (bw * bh), c.id + ' covered').toBeLessThan(1 / 3);
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
    const chip = (label: string): HTMLElement => [...cardEl().querySelectorAll<HTMLElement>('.choice[aria-label="Haptics"] .opt')].find((e) => e.textContent === label) as HTMLElement;
    const checked = (): string[] => [...cardEl().querySelectorAll('.choice[aria-label="Haptics"] .opt[aria-checked="true"]')].map((e) => e.textContent ?? '');
    expect(checked()).toEqual(['Light']);
    vibrate?.mockClear();
    tapAt(chip('Off'));
    expect(checked()).toEqual(['Off']);
    expect(vibrate).not.toHaveBeenCalled(); // switching off is silent
    tapAt(chip('Light'));
    expect(checked()).toEqual(['Light']);
    expect(vibrate).toHaveBeenLastCalledWith(10); // one tick of the chosen strength
    tapAt(chip('Strong'));
    expect(checked()).toEqual(['Strong']);
    expect(vibrate).toHaveBeenLastCalledWith(25);
    expect(storage.get('lanplay.haptic.strength')).toBe('strong');
    tapAt(chip('Off')); // off again, saved with Done
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

describe('Add to Home Screen', () => {
  const sheet = (): HTMLElement => document.getElementById('a2hs') as HTMLElement;
  const iosUa = (): void => void Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
  const homeRow = (): HTMLElement | undefined => [...cardEl().querySelectorAll<HTMLElement>('.card-btn')].find((b) => b.textContent === 'Add to Home Screen');
  /** The home screen row lives under the card's Device "More" (collapsed by default). */
  const openDevice = (): void => {
    const more = cardEl().querySelector<HTMLElement>('.more');
    if (more?.getAttribute('aria-expanded') === 'false') tapAt(more);
  };
  const dismiss = (): void => tapAt(document.getElementById('a2hs-close') as Element);

  it('the sheet markup: three short steps with an inline share glyph, the two notes, a big Close; no inline styles', () => {
    document.body.innerHTML = BODY;
    expect(sheet().hidden).toBe(true);
    expect(sheet().getAttribute('role')).toBe('dialog');
    expect(sheet().querySelector('#a2hs-title')?.textContent).toBe('Add to Home Screen');
    const steps = [...sheet().querySelectorAll('li')].map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
    // iOS 26 Safari keeps Share inside the \u22ef menu of its compact toolbar, so the first step names both.
    expect(steps).toEqual(['Tap the Share button (on iOS 26 it is in the \u22ef menu)', 'Choose \u201cAdd to Home Screen\u201d', 'Tap Add']);
    expect(sheet().querySelector('li svg.share-glyph')).toBeTruthy();
    const notes = [...sheet().querySelectorAll('.overlay-sub')].map((p) => p.textContent);
    expect(notes).toEqual([
      'Opens full screen with no address bar. If you make a New link on the PC, add it again.',
      'In landscape Safari may hide its toolbar, so do this in portrait or from the address-bar menu.',
    ]);
    expect(sheet().querySelectorAll('[style]')).toHaveLength(0);
    const css = read('controller.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const decl = (sel: string): string => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] as string).split(',').some((x) => x.trim() === sel)).map((m) => m[2]).join(';');
    const z = (sel: string): number => Number([...decl(sel).matchAll(/z-index:\s*(\d+)/g)].pop()?.[1]);
    expect(z('.sheet')).toBeGreaterThan(z('.rotate-overlay')); // usable in portrait, where the rotate overlay is up
    expect(decl('.sheet')).toMatch(/overflow-y:\s*auto/);
    expect(decl('.sheet')).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(Number(/min-height:\s*(\d+)px/.exec(decl('.action'))?.[1])).toBeGreaterThanOrEqual(44);
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/); // dismissed means gone: it cannot cover the field
  });

  it('the haptic switch css: rendered (never display none or visibility hidden), nearly transparent, on top, no touch gestures', () => {
    const css = read('controller.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] as string).trim() === '.haptic-switch').map((m) => m[2]).join(';');
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/inset:\s*0/);
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/height:\s*100%/);
    expect(rule).toMatch(/opacity:\s*0\.011/);
    expect(rule).toMatch(/touch-action:\s*none/);
    expect(rule).toMatch(/z-index:\s*[1-9]/);
    expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden|pointer-events:\s*none/);
  });

  it('iPhone Safari that is not standalone: the sheet shows once the connection is up; Close hides it for good', async () => {
    iosUa();
    h = await mount({ welcome: false });
    expect(sheet().hidden).toBe(true); // not before the connection is up
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 2 });
    expect(sheet().hidden).toBe(false);
    dismiss();
    expect(sheet().hidden).toBe(true);
    expect(storage.get('lanplay.home.seen')).toBe('1');
    // the field plays as normal afterwards
    await vi.advanceTimersByTimeAsync(10);
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    // a reconnect does not bring it back, and neither does a new page load
    h.ws().drop();
    await vi.advanceTimersByTimeAsync(600);
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 2 });
    expect(sheet().hidden).toBe(true);
    h.destroy();
    h = await mount();
    expect(sheet().hidden).toBe(true);
  });

  it('stays up across a reconnect until it is closed', async () => {
    iosUa();
    h = await mount();
    expect(sheet().hidden).toBe(false);
    h.ws().drop();
    await vi.advanceTimersByTimeAsync(600);
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 2 });
    expect(sheet().hidden).toBe(false);
  });

  it('never on Android or a desktop, never when the page runs from the home screen', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ANDROID_UA });
    h = await mount();
    expect(sheet().hidden).toBe(true);
    h.destroy();
    iosUa();
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }); // iOS: opened from the home screen
    h = await mount();
    expect(sheet().hidden).toBe(true);
    h.destroy();
    delete (navigator as Any).standalone;
    standaloneNow = true; // display-mode: standalone
    h = await mount();
    expect(sheet().hidden).toBe(true);
  });

  it('never while editing: a connection that comes up in the editor leaves the sheet alone', async () => {
    iosUa();
    h = await mount({ welcome: false });
    await settle();
    tapAt(menuEl());
    expect(editing()).toBe(true);
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 2 });
    expect(sheet().hidden).toBe(true);
  });

  it('works when storage is blocked: it shows, and Close still closes', async () => {
    iosUa();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    h = await mount();
    expect(sheet().hidden).toBe(false);
    expect(() => dismiss()).not.toThrow();
    expect(sheet().hidden).toBe(true);
  });

  it('opening it releases anything held under it', async () => {
    iosUa();
    storage.set('lanplay.home.seen', '1');
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    tapAt(menuEl());
    await settle();
    openDevice();
    tapAt(homeRow() as Element);
    expect(sheet().hidden).toBe(false);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
  });

  it('settings card: an "Add to Home Screen" row on iOS that re-opens the sheet even after it was dismissed; hidden once standalone', async () => {
    iosUa();
    storage.set('lanplay.home.seen', '1');
    h = await mount();
    tapAt(menuEl());
    await settle();
    expect(homeRow()).toBeUndefined(); // collapsed under Device / More
    expect(parseFloat(cardEl().style.height)).toBe(T.CARD_PAD + 5 * T.ROW_H);
    openDevice();
    const row = homeRow() as HTMLElement;
    expect(row).toBeTruthy();
    expect(cardEl().querySelectorAll('.card-btn.wide')).toHaveLength(1); // no Full screen button on iOS
    expect(parseFloat(cardEl().style.height)).toBe(T.CARD_PAD + 5 * T.ROW_H + T.ROW_TWO_H + T.ROW_H);
    tapAt(row);
    expect(sheet().hidden).toBe(false);
    expect(editing()).toBe(true);
    dismiss();
    expect(sheet().hidden).toBe(true);
    expect(editing()).toBe(true); // back in the editor
    expect(cardEl().hidden).toBe(false);
    tapAt(doneEl());
    await settle();
    h.destroy();
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    h = await mount();
    tapAt(menuEl());
    await settle();
    openDevice();
    expect(homeRow()).toBeUndefined();
    expect(parseFloat(cardEl().style.height)).toBe(T.CARD_PAD + 5 * T.ROW_H + T.ROW_TWO_H);
  });

  it('Android Chrome: the install prompt it hands over backs the same row, once', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ANDROID_UA });
    stubVibrate();
    h = await mount();
    tapAt(menuEl());
    await settle();
    openDevice();
    expect(homeRow()).toBeUndefined(); // no install prompt on a LAN address: written steps instead
    expect([...cardEl().querySelectorAll('.card-fact')].map((e) => e.textContent)).toContain('Chrome menu, then Add to Home screen');
    tapAt(doneEl());
    await settle();
    const prompt = vi.fn(async () => ({ outcome: 'dismissed' }));
    const ev = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // no mini-infobar: the row is the way in
    tapAt(menuEl());
    await settle();
    openDevice();
    expect(homeRow()).toBeTruthy();
    expect(sheet().hidden).toBe(true);
    tapAt(homeRow() as Element);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sheet().hidden).toBe(true); // the browser's own prompt, not the iOS steps
    expect(homeRow()).toBeUndefined(); // a prompt can be used once
  });

  it('Android: appinstalled takes the row away', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ANDROID_UA });
    stubVibrate();
    h = await mount();
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: vi.fn(async () => ({})) }));
    window.dispatchEvent(new Event('appinstalled'));
    tapAt(menuEl());
    await settle();
    openDevice();
    expect(homeRow()).toBeUndefined();
  });
});

describe('edit mode: More, Add control, Duplicate, Delete', () => {
  const enter = async (): Promise<void> => {
    tapAt(menuEl());
    await settle();
  };
  const selectCtl = (id: string): void => {
    const c = h.at(id);
    ptr(h.ctl(id), 'pointerdown', 20, c.x, c.y);
    ptr(h.ctl(id), 'pointerup', 20, c.x, c.y);
  };
  const more = (): HTMLElement => cardEl().querySelector('.more') as HTMLElement;
  const openMore = (): void => tapAt(more());
  const labels = (): string[] => [...cardEl().querySelectorAll('.slider-label, .choice > .card-label, .card-row > .card-label')].map((e) => e.textContent ?? '');
  const row = (label: string): HTMLElement => {
    const hit = [...cardEl().children].find((c) => c.querySelector(':scope > .card-label, :scope > .slider-label')?.textContent === label);
    if (!hit) throw new Error('no row ' + label + ' in ' + labels().join(', '));
    return hit as HTMLElement;
  };
  const chip = (label: string, text: string): HTMLElement => {
    const b = [...row(label).querySelectorAll<HTMLElement>('.opt')].find((o) => o.textContent === text);
    if (!b) throw new Error('no chip ' + text);
    return b;
  };
  const chips = (label: string): string[] => [...row(label).querySelectorAll('.opt')].map((o) => o.textContent ?? '');
  const checked = (label: string): string | undefined => [...row(label).querySelectorAll('.opt')].find((o) => o.getAttribute('aria-checked') === 'true')?.textContent ?? undefined;
  const flip = (label: string): void => tapAt(row(label).querySelector('.switch') as Element);
  const dragSlider = (label: string, ratio: number): void => {
    const track = row(label).querySelector('.slider-track') as HTMLElement;
    rect(track, 100, 100, 200, 44);
    ptr(track, 'pointerdown', 70, 100 + 200 * ratio, 120);
    ptr(track, 'pointerup', 70, 100 + 200 * ratio, 120);
  };
  const saved = async (): Promise<LayoutStore> => {
    tapAt(doneEl(), 437, 28); // inside the stubbed Done rect
    await settle();
    return host.puts().at(-1) as LayoutStore;
  };
  const ctlOf = (st: LayoutStore, id: string): Any => T.activeLayout(st).controls.find((c: { id: string }) => c.id === id);
  const cardBox = (): { l: number; r: number; t: number; b: number } => {
    const w = parseFloat(cardEl().style.width);
    const hh = parseFloat(cardEl().style.height);
    const x = parseFloat(cardEl().style.left);
    const y = parseFloat(cardEl().style.top);
    return { l: x - w / 2, r: x + w / 2, t: y - hh / 2, b: y + hh / 2 };
  };

  beforeEach(async () => {
    h = await mount();
    rect(doneEl(), 383, 2, 108, 52);
    await enter();
  });

  it('the default card stays as simple as before: a title, Size, Opacity and one More button; nothing else', () => {
    selectCtl('btn-a');
    expect([...cardEl().querySelectorAll('.slider-label')].map((e) => e.textContent)).toEqual(['Size', 'Opacity']);
    expect(cardEl().querySelector('.card-title')?.textContent).toBe('A button');
    expect(more().textContent).toBe('More');
    expect(more().getAttribute('aria-expanded')).toBe('false');
    expect(cardEl().querySelector('.choice, .card-input, .switch')).toBeNull();
    expect(cardBox().b - cardBox().t).toBe(T.CARD_PAD + 3 * T.ROW_H);
  });

  it('More opens the button options; Less closes them; the choice is remembered for the session, across controls', () => {
    selectCtl('btn-lt');
    openMore();
    expect(more().textContent).toBe('Less');
    expect(more().getAttribute('aria-expanded')).toBe('true');
    expect(labels()).toEqual(['Size', 'Opacity', 'Label', 'Sends', 'Shape', 'Width', 'Height', 'Mode', 'Trigger']);
    selectCtl('btn-a'); // another control: still open; a circle has no Width / Height
    expect(labels()).toEqual(['Size', 'Opacity', 'Label', 'Sends', 'Shape', 'Mode']);
    tapAt(more());
    expect(labels()).toEqual(['Size', 'Opacity']);
    selectCtl('btn-b');
    expect(more().textContent).toBe('More');
  });

  it('a card taller than the room is capped and scrolls instead of growing off the screen, and never covers its control', () => {
    selectCtl('stick-left');
    openMore();
    const b = cardBox();
    expect(b.t).toBeGreaterThanOrEqual(60); // below Done
    expect(b.b).toBeLessThanOrEqual(FH);
    expect(b.r - b.l).toBe(T.CARD_W.more);
    const c = h.at('stick-left');
    const r = (38 * FH) / 200;
    expect(b.l < c.x + r && c.x - r < b.r && b.t < c.y + r && c.y - r < b.b).toBe(false);
    for (const id of ['btn-a', 'btn-lt', 'btn-start', 'dpad', 'stick-right']) {
      selectCtl(id);
      const bb = cardBox();
      const p = h.at(id);
      const [bw, bh] = T.controlBox(ctlOf(host.store, id)) as [number, number];
      expect(bb.l < p.x + (bw * FH) / 200 && p.x - (bw * FH) / 200 < bb.r && bb.t < p.y + (bh * FH) / 200 && p.y - (bh * FH) / 200 < bb.b, id).toBe(false);
      expect(bb.b - bb.t).toBeLessThanOrEqual(FH - 60);
    }
  });

  it('button: Label, Sends (12 buttons), Shape, Mode, Trigger; every change is saved with Done like Size and Opacity', async () => {
    selectCtl('btn-lt');
    openMore();
    // label
    const input = cardEl().querySelector('.card-input') as HTMLInputElement;
    expect(input.maxLength).toBe(LIMITS.labelChars);
    expect(input.value).toBe('LT');
    input.value = 'Aim';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.ctl('btn-lt').textContent).toBe('Aim');
    expect(document.contains(input)).toBe(true); // typing does not rebuild the card (the keyboard would drop)
    // the 12 buttons
    expect(chips('Sends')).toEqual(['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Start', 'Back', 'L3', 'R3']);
    expect(checked('Sends')).toBe('LT');
    tapAt(chip('Sends', 'RT'));
    expect(h.ctl('btn-lt').dataset['button']).toBe('RT');
    expect(h.ctl('btn-lt').textContent).toBe('Aim'); // a label of their own stays
    expect(cardEl().querySelector('.card-title')?.textContent).toBe('Right trigger');
    expect(checked('Sends')).toBe('RT');
    // shape: a pill, then a circle (round again)
    tapAt(chip('Shape', 'Pill'));
    expect(h.ctl('btn-lt').className).toContain('shape-pill');
    tapAt(chip('Shape', 'Circle'));
    expect(h.ctl('btn-lt').className).toContain('shape-circle');
    expect(labels()).not.toContain('Width');
    tapAt(chip('Shape', 'Rect'));
    expect(labels()).toContain('Width');
    dragSlider('Width', 1);
    expect(h.ctl('btn-lt').style.getPropertyValue('--w')).toBe('40');
    dragSlider('Height', 0);
    expect(h.ctl('btn-lt').style.getPropertyValue('--h')).toBe('8');
    // mode
    expect(checked('Mode')).toBe('Hold');
    tapAt(chip('Mode', 'Toggle'));
    expect(checked('Mode')).toBe('Toggle');
    tapAt(chip('Mode', 'Rapid'));
    expect(checked('Mode')).toBe('Rapid');
    // trigger strength is a percentage of 255
    expect(row('Trigger').querySelector('.slider-value')?.textContent).toBe('100%');
    dragSlider('Trigger', 0.5);
    expect(row('Trigger').querySelector('.slider-value')?.textContent).toBe('55%');
    tapAt(chip('Sends', 'A'));
    expect(labels()).not.toContain('Trigger'); // only LT and RT have a strength
    const st = await saved();
    expect(ctlOf(st, 'btn-lt')).toMatchObject({ button: 'A', label: 'Aim', shape: 'rect', w: 40, h: 8, latch: false, turbo: true });
    expect(ctlOf(st, 'btn-lt').value).toBe(Math.round(0.55 * 255));
    fixedPoint(st);
  });

  it('clearing the label gives the button its own name back', () => {
    selectCtl('btn-start');
    openMore();
    const input = cardEl().querySelector('.card-input') as HTMLInputElement;
    expect(input.value).toBe('Start');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.ctl('btn-start').textContent).toBe('Start');
    input.value = 'Pause2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.ctl('btn-start').textContent).toBe('Pause2');
  });

  it('stick: side, Mode, Dead zone, Sensitivity, Curve, Invert X / Y, Double-tap; saved and playable', async () => {
    selectCtl('stick-left');
    openMore();
    expect(labels()).toEqual(['Size', 'Opacity', 'Stick', 'Mode', 'Dead zone', 'Sensitivity', 'Curve', 'Invert X', 'Invert Y', 'Double-tap = click']);
    expect(checked('Stick')).toBe('Left');
    tapAt(chip('Stick', 'Right'));
    tapAt(chip('Mode', 'Floating'));
    expect(h.ctl('stick-left').classList.contains('is-floating')).toBe(true);
    tapAt(chip('Curve', 'Precise'));
    expect(checked('Curve')).toBe('Precise');
    dragSlider('Dead zone', 0.4);
    expect(row('Dead zone').querySelector('.slider-value')?.textContent).toBe('20%');
    dragSlider('Sensitivity', 1);
    expect(row('Sensitivity').querySelector('.slider-value')?.textContent).toBe('2.0');
    flip('Invert X');
    flip('Invert Y');
    flip('Double-tap = click');
    expect(row('Invert X').querySelector('.switch')?.getAttribute('aria-checked')).toBe('true');
    expect(row('Double-tap = click').querySelector('.switch')?.getAttribute('aria-checked')).toBe('false'); // it was on
    const st = await saved();
    expect(ctlOf(st, 'stick-left')).toMatchObject({ stick: 'right', mode: 'floating', curve: 'precise', deadzone: 0.2, sensitivity: 2, invertX: true, invertY: true, doubleTapClick: false });
    fixedPoint(st);
    // and it plays that way
    const c = h.at('stick-left');
    const r = ((38 * FH) / 100) / 2;
    ptr(h.ctl('stick-left'), 'pointerdown', 1, c.x, c.y);
    vi.advanceTimersByTime(10);
    ptr(h.ctl('stick-left'), 'pointermove', 1, c.x + r, c.y);
    expect(h.ws().states().at(-1)).toMatchObject({ rx: -32767, ry: 0, lx: 0 }); // right stick, X inverted
  });

  it('d-pad: Diagonals', async () => {
    selectCtl('dpad');
    openMore();
    expect(labels()).toEqual(['Size', 'Opacity', 'Diagonals']);
    expect(row('Diagonals').querySelector('.switch')?.getAttribute('aria-checked')).toBe('true');
    flip('Diagonals');
    expect(row('Diagonals').querySelector('.switch')?.getAttribute('aria-checked')).toBe('false');
    expect(ctlOf(await saved(), 'dpad').diagonals).toBe(false);
  });

  it('every row of the More panel is a 44 pt target, and the chips stay at least 44 pt wide', () => {
    const css = read('controller.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const decl = (sel: string): string => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] as string).split(',').some((x) => x.trim() === sel)).map((m) => m[2]).join(';');
    expect(decl('.card-row')).toMatch(/height:\s*44px/);
    expect(decl('.choice')).toMatch(/height:\s*44px/);
    expect(decl('.card-input')).toMatch(/height:\s*44px/);
    expect(decl('.card-input')).toMatch(/font-size:\s*17px/); // iOS zooms the page for anything smaller
    expect(decl('.card-input')).toMatch(/user-select:\s*text/); // the page is user-select: none, which would stop typing
    expect(decl('.opt')).toMatch(/min-width:\s*44px/);
    expect(decl('.card')).toMatch(/overflow-y:\s*auto/);
    expect(decl('.card')).toMatch(/overscroll-behavior:\s*contain/);
    expect(T.CARD_W.more - 24 - 3 - 5 * 4).toBeGreaterThanOrEqual(6 * 44); // six chips of 44 pt fit a wrapped row
  });

  it('the label field can be typed in: the page does not cancel its selection, and a resize (the keyboard) does not rebuild the card', () => {
    selectCtl('btn-a');
    openMore();
    const input = cardEl().querySelector('.card-input') as HTMLInputElement;
    const sel = new Event('selectstart', { bubbles: true, cancelable: true });
    input.dispatchEvent(sel);
    expect(sel.defaultPrevented).toBe(false);
    const other = new Event('selectstart', { bubbles: true, cancelable: true });
    h.ctl('btn-a').dispatchEvent(other);
    expect(other.defaultPrevented).toBe(true);
    window.dispatchEvent(new Event('resize'));
    expect(cardEl().querySelector('.card-input')).toBe(input);
    // the card and the sheet scroll; the rest of the page does not
    const inCard = new Event('touchmove', { bubbles: true, cancelable: true });
    cardEl().dispatchEvent(inCard);
    expect(inCard.defaultPrevented).toBe(false);
    const elsewhere = new Event('touchmove', { bubbles: true, cancelable: true });
    h.ctl('btn-a').dispatchEvent(elsewhere);
    expect(elsewhere.defaultPrevented).toBe(true);
  });

  it('Add control: Button, Stick and D-pad each appear in the middle, selected, with their card; Done saves them', async () => {
    const add = (name: string): HTMLElement => cardEl().querySelector(`[aria-label="Add ${name}"]`) as HTMLElement;
    expect([...cardEl().querySelectorAll('.card-row')].map((r) => r.querySelector('.card-label')?.textContent ?? '')).toContain('Add');
    tapAt(add('button'));
    let sel = document.querySelector('.is-selected') as HTMLElement;
    expect(sel.dataset['type']).toBe('button');
    expect(sel.style.left).toBe('50%');
    expect(sel.style.top).toBe('50%');
    expect(sel.dataset['button']).toBe('L3');
    expect(cardEl().querySelector('.card-title')?.textContent).toBe('Left stick click (L3)');
    expect(cardEl().classList.contains('is-settings')).toBe(false);
    ptr(document.getElementById('field') as Element, 'pointerdown', 40, 440, 395); // empty: back to the settings
    tapAt(add('stick'));
    sel = document.querySelector('.is-selected') as HTMLElement;
    expect(sel.dataset['type']).toBe('stick');
    ptr(document.getElementById('field') as Element, 'pointerdown', 41, 440, 395);
    tapAt(add('D-pad'));
    expect((document.querySelector('.is-selected') as HTMLElement).dataset['type']).toBe('dpad');
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(16);
    const st = await saved();
    expect(T.activeLayout(st).controls).toHaveLength(16);
    fixedPoint(st);
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(16);
  });

  it('Add control respects the limit: a full layout shows a message and adds nothing', () => {
    const add = (): HTMLElement => cardEl().querySelector('[aria-label="Add D-pad"]') as HTMLElement;
    for (let i = 13; i < LIMITS.controls; i++) {
      tapAt(add());
      ptr(document.getElementById('field') as Element, 'pointerdown', 50 + i, 440, 395);
    }
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(LIMITS.controls);
    tapAt(add());
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(LIMITS.controls);
    expect(cardEl().querySelector('.card-msg')?.textContent).toBe('Layout is full');
    selectCtl('btn-a');
    openMore();
    tapAt(cardEl().querySelector('.card-btn.grow') as Element); // Duplicate
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(LIMITS.controls);
    expect(cardEl().querySelector('.card-msg')?.textContent).toBe('Layout is full');
  });

  it('Duplicate copies the selected control a little aside and selects the copy', async () => {
    selectCtl('btn-a');
    openMore();
    const buttons = [...cardEl().querySelectorAll('.card-btn.grow')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Duplicate', 'Delete']);
    tapAt(buttons[0] as Element);
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(14);
    const sel = document.querySelector('.is-selected') as HTMLElement;
    expect(sel.dataset['cid']).not.toBe('btn-a');
    expect(sel.dataset['button']).toBe('A');
    expect(sel.style.left).toBe('89%');
    const st = await saved();
    expect(T.activeLayout(st).controls).toHaveLength(14);
    fixedPoint(st);
  });

  it('Delete needs a second tap within 2 s: the first only arms it, a pause disarms it, a new card starts disarmed', async () => {
    selectCtl('btn-a');
    openMore();
    const del = (): HTMLElement => [...cardEl().querySelectorAll<HTMLElement>('.card-btn.grow')][1] as HTMLElement;
    tapAt(del());
    expect(del().textContent).toBe('Tap again');
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(13);
    vi.advanceTimersByTime(2100);
    expect(del().textContent).toBe('Delete');
    tapAt(del()); // a tap after the pause is a first tap again
    expect(del().textContent).toBe('Tap again');
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(13);
    vi.advanceTimersByTime(1900);
    tapAt(del()); // inside the 2 s window
    await settle();
    expect(document.querySelectorAll('[data-cid]')).toHaveLength(12);
    expect(document.querySelector('[data-cid="btn-a"]')).toBeNull();
    expect(cardEl().classList.contains('is-settings')).toBe(true); // nothing is selected any more
    const st = await saved();
    expect(ctlOf(st, 'btn-a')).toBeUndefined();
    fixedPoint(st);
  });

  it('the settings card has 5 rows (slots and Reset, Add, Stick sensitivity, Haptics, Link and More); the device rows stay collapsed', () => {
    expect(cardBox().b - cardBox().t).toBe(T.CARD_PAD + 5 * T.ROW_H);
    expect(cardEl().textContent).not.toContain('Home');
    expect(cardEl().textContent).not.toContain('Stay awake');
    expect(cardBox().r - cardBox().l).toBe(T.CARD_W.settings);
  });
});

describe('an old store from the complicated editor', () => {
  it('loads, plays with the values it stored (toggle, rapid fire, trigger strength), and saves cleanly with the extra layouts untouched', async () => {
    host.store = oldStore();
    h = await mount();
    // every button of the old store has latch AND turbo. The editor shows that as "Toggle" (latch wins), so it plays as a plain
    // toggle: one tap switches it on and it stays on without blinking (no endless rapid fire), the next tap switches it off.
    const sent = h.ws().states().length;
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    vi.advanceTimersByTime(1000);
    expect(h.ws().states().slice(sent).map((s) => s.buttons)).toEqual([BTN.A]);
    ptr(h.ctl('btn-a'), 'pointerdown', 2);
    vi.advanceTimersByTime(300);
    ptr(h.ctl('btn-a'), 'pointerup', 2);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(false);
    // the trigger sends the strength it was given (value 90), not 255
    ptr(h.ctl('btn-lt'), 'pointerdown', 3);
    expect(h.ws().states().at(-1)?.lt).toBe(90);
    ptr(h.ctl('btn-lt'), 'pointerdown', 4);
    // the d-pad was stored without diagonals: strictly four-way
    const dp = h.at('dpad');
    const half = (26 * FH) / 100 / 2;
    vi.advanceTimersByTime(10);
    ptr(h.ctl('dpad'), 'pointerdown', 5, dp.x + half * 0.7, dp.y + half * 0.7);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.DPAD_RIGHT); // right only: a diagonal would add DOWN
    ptr(h.ctl('dpad'), 'pointerup', 5);
    // a label is rendered as stored
    expect(h.ctl('btn-a').textContent).toBe('Jump');
    // Done saves what was loaded, unchanged
    tapAt(menuEl());
    tapAt(doneEl());
    await settle();
    const saved = host.puts()[0] as LayoutStore;
    expect(saved).toEqual(oldStore());
    fixedPoint(saved);
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

// ---- Phone id, link probe, dead link, slot feedback (release 0.5) --------------------------------------------------------

describe('phone id', () => {
  it('is 24 symbols from the id alphabet, made from random bytes', () => {
    const id = T.newPhoneId(Uint8Array.from({ length: 24 }, (_, i) => i * 11));
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(T.newPhoneId(new Uint8Array(24))).toBe('A'.repeat(24));
    expect(T.newPhoneId([])).toBe('A'.repeat(24)); // never throws on short input
    expect(T.isPhoneId(id)).toBe(true);
    for (const bad of ['', 'short', 'x'.repeat(33), 'has space in it 123456', 'ünïcode-ünïcode-ünïcode', 5, null]) expect(T.isPhoneId(bad), String(bad)).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: 'hello', name: 'x', id }))).toEqual({ t: 'hello', name: 'x', id }); // the host accepts what the page makes
  });

  it('is sent in hello, kept in storage across loads, and used for the layout requests', async () => {
    h = await mount();
    const id = h.ws().frames()[0]?.['id'] as string;
    expect(T.isPhoneId(id)).toBe(true);
    expect(storage.get(T.ID_KEY)).toBe(id);
    expect(host.calls.filter((c) => c.path === '/api/layouts').every((c) => c.id === id)).toBe(true);
    h.destroy();
    FakeSocket.all = [];
    h = await mount();
    expect(h.ws().frames()[0]?.['id']).toBe(id);
  });

  it('replaces a stored value of the wrong shape, and without storage stays the same for every reconnect of the page', async () => {
    storage.set(T.ID_KEY, 'not an id!');
    h = await mount();
    const id = h.ws().frames()[0]?.['id'] as string;
    expect(T.isPhoneId(id)).toBe(true);
    expect(storage.get(T.ID_KEY)).toBe(id);
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
    const blocked = h.ws().frames()[0]?.['id'] as string;
    expect(T.isPhoneId(blocked)).toBe(true);
    h.ws().drop();
    await vi.advanceTimersByTimeAsync(600);
    h.ws().open();
    expect(h.ws().frames()[0]?.['id']).toBe(blocked);
  });
});

describe('link probe and round trip', () => {
  const linkRow = (): string => [...cardEl().querySelectorAll('.card-label')].map((e) => e.textContent ?? '').find((t) => t.startsWith('Link')) ?? '';

  it('parses an echo, keeps a sample window, shows the median', () => {
    expect(T.parseServerMessage('{"t":"p","n":7}')).toEqual({ t: 'p', n: 7 });
    for (const bad of ['{"t":"p"}', '{"t":"p","n":-1}', '{"t":"p","n":1.5}', '{"t":"p","n":"1"}']) expect(T.parseServerMessage(bad), bad).toBeNull();
    expect(T.medianRtt([])).toBeNull();
    expect(T.medianRtt([9])).toBe(9);
    expect(T.medianRtt([80, 5, 6, 7, 8])).toBe(7); // one hiccup does not move it
    expect(T.linkText(null)).toBe('Link: ...');
    expect(T.linkText(5.6)).toBe('Link: 6 ms');
  });

  it('sends {"t":"p","n":N} once on welcome and then every second; the host parser accepts each one', async () => {
    h = await mount();
    const ws = h.ws();
    expect(ws.pings).toEqual([1]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ws.pings).toEqual([1, 2, 3, 4]);
    expect(ws.sent.every((f) => !f.includes('"t":"p"'))).toBe(true);
    for (const n of ws.pings) expect(parseClientMessage(JSON.stringify({ t: 'p', n }))).toEqual({ t: 'p', n });
    expect(h.ws().frames().every((f) => f.t !== 'p')).toBe(true);
  });

  it('no probe before welcome, none after the socket is gone', async () => {
    h = await mount({ welcome: false });
    h.ws().open();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.ws().pings).toEqual([]);
    h.ws().receive({ t: 'welcome', slot: 1 });
    expect(h.ws().pings).toEqual([1]);
    const first = h.ws();
    first.drop();
    await vi.advanceTimersByTimeAsync(400);
    expect(first.pings).toEqual([1]);
  });

  it('the settings card shows "Link: N ms" from the echoes and updates it while open; the dot is amber above 40 ms', async () => {
    FakeSocket.echo = false;
    h = await mount();
    const ws = h.ws();
    /** Answer probe n after `ms` have passed since it went out. */
    const echo = async (n: number, ms: number): Promise<void> => {
      while (!ws.pings.includes(n)) await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(ms);
      ws.receive({ t: 'p', n });
    };
    expect(menuEl().dataset['state']).toBe('connected');
    tapAt(menuEl());
    await settle();
    expect(linkRow()).toBe('Link: ...');
    await vi.advanceTimersByTimeAsync(6); // probe 1 went out 16 ms ago (the 10 ms of mount count)
    ws.receive({ t: 'p', n: 1 });
    expect(linkRow()).toBe('Link: 16 ms');
    await echo(2, 4);
    expect(linkRow()).toBe('Link: 16 ms'); // median of 16 and 4 (the upper one of two)
    expect(menuEl().dataset['state']).toBe('connected');
    await echo(3, 60);
    expect(linkRow()).toBe('Link: 16 ms'); // one hiccup does not move it
    expect(menuEl().dataset['state']).toBe('connected');
    await echo(4, 60);
    expect(linkRow()).toBe('Link: 60 ms');
    expect(menuEl().dataset['state']).toBe('retrying'); // amber above 40 ms
    await echo(5, 5);
    await echo(6, 5);
    await echo(7, 5);
    expect(linkRow()).toBe('Link: 5 ms');
    expect(menuEl().dataset['state']).toBe('connected'); // and green again
    expect(h.ws()).toBe(ws); // the same socket all along
  });

  it('an echo for an unknown probe changes nothing', async () => {
    FakeSocket.echo = false;
    h = await mount();
    h.ws().receive({ t: 'p', n: 999 });
    tapAt(menuEl());
    await settle();
    expect(linkRow()).toBe('Link: ...');
  });
});

describe('dead link', () => {
  it('no echo for 2 s drops the socket and opens a new one at once, with the same id; the echo of a live link keeps it', async () => {
    FakeSocket.echo = false;
    h = await mount();
    const first = h.ws();
    const id = first.frames()[0]?.['id'];
    await vi.advanceTimersByTimeAsync(1980); // 10 ms were spent in mount
    expect(FakeSocket.all).toHaveLength(1);
    expect(first.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeSocket.all).toHaveLength(2); // at once: no 500 ms backoff
    expect(first.closed).toBe(true);
    expect(menuEl().dataset['state']).toBe('retrying');
    const second = h.ws();
    second.open();
    expect(second.frames()).toEqual([{ t: 'hello', name: expect.any(String), id }]);
    second.receive({ t: 'welcome', slot: 2 });
    expect(menuEl().dataset['state']).toBe('connected');
    expect(menuEl().getAttribute('aria-label')).toBe('Menu, Player 2');
    expect(second.states()).toEqual([NEUTRAL]); // the current (neutral) state is sent again
  });

  it('a late echo inside the 2 s keeps the link', async () => {
    FakeSocket.echo = false;
    h = await mount();
    const ws = h.ws();
    await vi.advanceTimersByTimeAsync(1500);
    ws.receive({ t: 'p', n: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    ws.receive({ t: 'p', n: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(ws.closed).toBe(false);
  });

  it('the first unanswered probe counts: echoes that stop mid-game end the link 2 s after the last answered probe', async () => {
    h = await mount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.echo = false;
    await vi.advanceTimersByTimeAsync(1000); // the probe at 4 s gets no answer
    await vi.advanceTimersByTimeAsync(1980);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('releases every control on the dead link, and the new socket starts neutral', async () => {
    FakeSocket.echo = false;
    h = await mount();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    await vi.advanceTimersByTimeAsync(2100);
    const second = h.ws();
    expect(second).not.toBe(FakeSocket.all[0]);
    second.open();
    second.receive({ t: 'welcome', slot: 2 });
    expect(second.states().at(-1)?.buttons).toBe(0);
    expect(h.ctl('btn-a').classList.contains('is-down')).toBe(false);
  });

  it('a socket that never opens is abandoned after 4 s and retried with the backoff', async () => {
    h = await mount({ welcome: false });
    await vi.advanceTimersByTimeAsync(3990);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeSocket.all[0]?.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(1); // the backoff is 500 ms
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('the network coming back replaces an attempt that started while it was down; coming to the foreground does not', async () => {
    h = await mount({ welcome: false });
    await settle();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(1); // already in flight
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]?.closed).toBe(true);
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 3 });
    expect(menuEl().dataset['state']).toBe('connected');
  });

  it('re-attach: after a drop the page says hello with the same id and shows the same player number again', async () => {
    h = await mount();
    const id = h.ws().frames()[0]?.['id'];
    h.ws().drop();
    await vi.advanceTimersByTimeAsync(500);
    const second = h.ws();
    second.open();
    expect(second.frames()[0]).toEqual({ t: 'hello', name: expect.any(String), id });
    second.receive({ t: 'welcome', slot: 2 });
    expect((document.getElementById('slot-toast') as HTMLElement).textContent).toBe('Player 2');
    expect((document.getElementById('slot-toast') as HTMLElement).hidden).toBe(false);
  });
});

describe('player number on connect', () => {
  const toast = (): HTMLElement => document.getElementById('slot-toast') as HTMLElement;
  it('shows "Player N" for 1.5 s in the middle, on every welcome', async () => {
    h = await mount({ welcome: false });
    expect(toast().hidden).toBe(true);
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 3 });
    expect(toast().hidden).toBe(false);
    expect(toast().textContent).toBe('Player 3');
    expect(toast().getAttribute('role')).toBe('status');
    await vi.advanceTimersByTimeAsync(T.SLOT_TOAST_MS - 1);
    expect(toast().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(toast().hidden).toBe(true);
    h.ws().drop();
    await vi.advanceTimersByTimeAsync(500);
    h.ws().open();
    h.ws().receive({ t: 'welcome', slot: 3 });
    expect(toast().hidden).toBe(false);
  });
});

describe('full screen, landscape lock, stay awake: optional on every phone', () => {
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
  const root = (): Any => document.documentElement;
  let fsElement: Element | null = null;
  const setFullscreen = (on: boolean): void => {
    fsElement = on ? root() : null;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  const firstTap = (): void => {
    ptr(document.getElementById('field') as Element, 'pointerdown', 70, 1, 1);
    ptr(document.getElementById('field') as Element, 'pointerup', 70, 1, 1);
  };
  const androidUa = (): void => void Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ANDROID_UA });
  const openDevice = (): void => {
    tapAt(menuEl());
    const more = cardEl().querySelector<HTMLElement>('.more');
    if (more?.getAttribute('aria-expanded') === 'false') tapAt(more);
  };

  const realPlay = (HTMLMediaElement.prototype as Any).play;
  beforeEach(() => {
    fsElement = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsElement });
    (HTMLMediaElement.prototype as Any).play = async () => {
      throw new Error('NotAllowedError'); // a browser that refuses; tests that want it to work replace it
    };
  });
  afterEach(() => {
    delete root().requestFullscreen;
    delete (document as Any).fullscreenElement;
    delete (navigator as Any).wakeLock;
    delete (screen as Any).orientation;
    (HTMLMediaElement.prototype as Any).play = realPlay;
  });

  it('with requestFullscreen, wakeLock, orientation.lock and vibrate all missing, the page plays and says so', async () => {
    delete root().requestFullscreen;
    delete (navigator as Any).wakeLock;
    delete (navigator as Any).vibrate;
    delete (screen as Any).orientation;
    androidUa();
    expect(typeof navigator.vibrate).not.toBe('function');
    h = await mount();
    expect(() => firstTap()).not.toThrow();
    await settle();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.A);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    vi.advanceTimersByTime(40);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    openDevice();
    expect(cardEl().textContent).toContain('Not available: set Auto-Lock to Never'); // the video could not play either
    expect(cardEl().textContent).not.toContain('Full screen'); // nothing to offer
    expect(cardEl().textContent).toContain('Chrome menu, then Add to Home screen');
    expect([...cardEl().querySelectorAll('.choice[aria-label="Haptics"]')]).toHaveLength(0); // no vibrate: the plain On/Off switch
  });

  it('the first tap, and only the first, asks for full screen without browser UI, then locks landscape and takes a wake lock', async () => {
    androidUa();
    const lock = vi.fn(async () => undefined);
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { lock } });
    root().requestFullscreen = vi.fn(async () => {
      setFullscreen(true);
    });
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release, addEventListener: vi.fn() }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    h = await mount();
    expect(root().requestFullscreen).not.toHaveBeenCalled(); // nothing before a gesture
    expect(request).not.toHaveBeenCalled();
    firstTap();
    await settle();
    expect(root().requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(lock).toHaveBeenCalledWith('landscape');
    expect(request).toHaveBeenCalledWith('screen');
    firstTap();
    await settle();
    expect(root().requestFullscreen).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    openDevice();
    expect(cardEl().textContent).toContain('Wake lock');
    expect(cardEl().textContent).not.toContain('Full screen'); // already in it
    h.destroy();
    expect(release).toHaveBeenCalled();
  });

  it('leaving full screen (back gesture) offers one tap to go back in; "Not now" closes the offer; play is released meanwhile', async () => {
    androidUa();
    root().requestFullscreen = vi.fn(async () => {
      setFullscreen(true);
    });
    h = await mount();
    const offer = document.getElementById('fs-offer') as HTMLElement;
    expect(offer.hidden).toBe(true);
    firstTap();
    await settle();
    ptr(h.ctl('btn-b'), 'pointerdown', 2);
    expect(h.ws().states().at(-1)?.buttons).toBe(BTN.B);
    setFullscreen(false);
    expect(offer.hidden).toBe(false);
    expect(h.ws().states().at(-1)?.buttons).toBe(0);
    tapAt(document.getElementById('fs-go') as Element);
    await settle();
    expect(root().requestFullscreen).toHaveBeenCalledTimes(2);
    expect(offer.hidden).toBe(true);
    setFullscreen(false);
    expect(offer.hidden).toBe(false);
    tapAt(document.getElementById('fs-skip') as Element);
    expect(offer.hidden).toBe(true);
    openDevice(); // the card still has a button for it
    expect([...cardEl().querySelectorAll('.card-btn.wide')].map((b) => b.textContent)).toContain('Full screen');
  });

  it('a refused request (no gesture, no permission) leaves no offer and no error', async () => {
    androidUa();
    root().requestFullscreen = vi.fn(async () => {
      throw new Error('denied');
    });
    const lock = vi.fn(async () => undefined);
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { lock } });
    h = await mount();
    firstTap();
    await settle();
    expect(lock).not.toHaveBeenCalled();
    expect((document.getElementById('fs-offer') as HTMLElement).hidden).toBe(true);
  });

  it('a lock that is refused (desktop, not fullscreen) is ignored', async () => {
    androidUa();
    root().requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(screen, 'orientation', {
      configurable: true,
      value: {
        lock: () => {
          throw new Error('NotSupportedError');
        },
      },
    });
    h = await mount();
    expect(() => firstTap()).not.toThrow();
    await settle();
  });

  it('iPhone: no full screen request and no offer (the home screen sheet is its way), the wake path still runs', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
    storage.set('lanplay.home.seen', '1');
    root().requestFullscreen = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release: async () => undefined }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    h = await mount();
    firstTap();
    await settle();
    expect(root().requestFullscreen).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('screen');
    setFullscreen(false);
    expect((document.getElementById('fs-offer') as HTMLElement).hidden).toBe(true);
  });

  it('no navigator.wakeLock (plain http): a muted, looping, inline video is started on the first tap; the card says so', async () => {
    delete (navigator as Any).wakeLock;
    const play = vi.fn(async () => undefined);
    (HTMLMediaElement.prototype as Any).play = play;
    h = await mount();
    expect(document.querySelector('video')).toBeNull();
    firstTap();
    await settle();
    const v = document.querySelector('video') as HTMLVideoElement;
    expect(v).toBeTruthy();
    expect(v.getAttribute('src')).toBe('wake.mp4');
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.hasAttribute('playsinline')).toBe(true);
    expect(v.getAttribute('aria-hidden')).toBe('true');
    expect(play).toHaveBeenCalledTimes(1);
    openDevice();
    expect(cardEl().textContent).toContain('Muted video');
    // the browser pauses it while the page is hidden: shown again, it is started again
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(play).toHaveBeenCalledTimes(2);
    h.destroy();
    expect(document.querySelector('video')).toBeNull();
  });

  it('a wake lock the browser released (page hidden) is taken again when the page is shown', async () => {
    const listeners: Array<() => void> = [];
    const request = vi.fn(async () => ({ release: async () => undefined, addEventListener: (_t: string, fn: () => void) => listeners.push(fn) }));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    h = await mount();
    firstTap();
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    for (const fn of listeners) fn(); // the browser lets go
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('accidental back', () => {
  it('pushes one history entry and puts it back whenever it is used up', async () => {
    const push = vi.spyOn(history, 'pushState');
    h = await mount();
    expect(push).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(push).toHaveBeenCalledTimes(2);
    expect(String(push.mock.calls[1]?.[2])).toContain('?t=tok-123'); // the saved URL keeps its token
    push.mockRestore();
  });
  it('works where history.pushState throws', async () => {
    const push = vi.spyOn(history, 'pushState').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    h = await mount();
    expect(() => window.dispatchEvent(new PopStateEvent('popstate'))).not.toThrow();
    push.mockRestore();
  });
});

describe('haptic strength', () => {
  it('Light is 10 ms and Strong 25 ms on a press tick, and an unknown stored value is Light', () => {
    expect(T.hapticLevelOf(null)).toBe('light');
    expect(T.hapticLevelOf('strong')).toBe('strong');
    expect(T.hapticLevelOf('x')).toBe('light');
    const calls: number[] = [];
    const hz = T.createHaptics({ mode: 'android', enabled: () => true, vibrate: (ms: number) => calls.push(ms), tickMs: () => 25, now: () => Date.now(), setTimer: setTimeout, clearTimer: clearTimeout });
    hz.tick();
    expect(calls).toEqual([25]);
  });
  it('a button press vibrates for the stored strength; Off is silent', async () => {
    stubVibrate();
    storage.set(T.HAPTIC_KEY, 'strong');
    h = await mount();
    vibrate?.mockClear();
    ptr(h.ctl('btn-a'), 'pointerdown', 1);
    expect(vibrate).toHaveBeenCalledWith(25);
    ptr(h.ctl('btn-a'), 'pointerup', 1);
    vi.advanceTimersByTime(40);
    tapAt(menuEl());
    await settle();
    tapAt([...cardEl().querySelectorAll<HTMLElement>('.choice[aria-label="Haptics"] .opt')].find((e) => e.textContent === 'Off') as Element);
    tapAt(doneEl());
    await settle();
    vibrate?.mockClear();
    ptr(h.ctl('btn-a'), 'pointerdown', 2);
    expect(vibrate).not.toHaveBeenCalled();
  });
});

describe('input path is untouched by the new features', () => {
  it('a stick drag sends only state frames at <= 125 per second while probes run, and a probe is never part of the pad count', async () => {
    h = await mount();
    const c = h.at('stick-right');
    ptr(h.ctl('stick-right'), 'pointerdown', 1, c.x, c.y);
    const before = h.ws().count('s');
    for (let i = 0; i < 1000; i++) {
      ptr(h.ctl('stick-right'), 'pointermove', 1, c.x + 20 + (i % 20), c.y);
      vi.advanceTimersByTime(1);
    }
    const frames = h.ws().count('s') - before;
    expect(frames).toBeLessThanOrEqual(130);
    expect(frames).toBeGreaterThan(100);
    expect(h.ws().pings.length).toBeGreaterThanOrEqual(1);
    expect(FakeSocket.all).toHaveLength(1);
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
