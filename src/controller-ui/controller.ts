/* LanPlay phone controller page.
 *
 * Classic script (no import/export) wrapped in an IIFE so it adds no globals. The wire protocol lives in
 * src/core/controller/protocol.ts and the layout schema in src/core/controller/layout.ts; this file mirrors the numbers and
 * types it needs (tests/ui/controller-page.test.ts asserts the mirrors match and that every edit is a fixed point of the
 * host's sanitizer).
 *
 *   1. wire constants and the mirror of layout.ts
 *   2. pure logic: layout store, geometry, pad maths, send timing, haptic decisions, protocol helpers
 *   3. boot(): the page (controls drawn from the active layout, play input, the small edit mode, host sync, connection)
 *   4. the test hook
 *
 * Design notes
 *  - Layouts live on the HOST (per phone id). The page loads them with GET /api/layouts, edits a local copy, and saves the whole
 *    store with ONE PUT /api/layouts when the user taps Done. The phone keeps only its random id (sent in hello, so the host can
 *    give the same slot and layouts back after a reconnect), the player-name digits, the haptic strength and a "home screen
 *    sheet was shown" flag (all through storageGet/storageSet, which survive blocked storage).
 *  - Input first: a pointer event updates the held state and sends the frame from inside the handler; painting happens after, with
 *    transforms only, and no layout is read while a finger is down (geometry is measured on resize, not on touch).
 *  - There is no animation-frame loop: Safari drops rAF to 30 fps in Low Power Mode. Sends are event-driven with timers only for
 *    the 8 ms stick gap, the 24 ms minimum press, the 500 ms keepalive, the 50 ms rapid-fire blink while a rapid-fire button is
 *    held, and the Android vibration clock (iOS has none: see createHaptics). A send from inside a handler cancels any trailing
 *    send that was armed before it.
 *  - Anything that could leave a control stuck (page hidden, window blur, socket closed, cancelled pointer, portrait, entering the
 *    editor) releases every control (toggled buttons too) and sends one neutral state.
 *  - Haptics: Android/Chrome have navigator.vibrate (a duration, no amplitude). iOS Safari has NO Vibration API. Its only haptic
 *    from a web page is the system tick of a real <input type=checkbox switch> that the finger itself touches: since WebKit commit
 *    fc1ef83 (iOS 26.5) a script-driven label.click() or a timer no longer plays it. So on iOS every button and the d-pad carry a
 *    transparent switch laid over them (see syncOverlay); the finger lands on it, the browser generates the click, the Taptic
 *    Engine ticks. That means ONE tick per tap and no stick ramp, and the tick may come on release rather than on press.
 *    UNVERIFIED on a real iPhone: ?diag=1 has a test switch that shows whether and when the click arrives.
 *  - Home screen: iOS Safari that is not running standalone gets a one-time "Add to Home Screen" sheet and a permanent row in the
 *    settings card (full screen, no address bar). Android Chrome's beforeinstallprompt, when it fires, backs the same row.
 *  - Link health: once welcomed, a {"t":"p","n":N} goes out every second and the host echoes it. The echo gives the round trip shown
 *    in the settings card. No echo for 2 s means the link is dead (Wi-Fi gone, TCP still "open"): the socket is dropped and a new
 *    one opened at once, which the host matches to the old slot by the phone id. The slot number is shown for 1.5 s on every welcome.
 *  - Android Chrome: the first tap asks for full screen (navigationUI hidden), then locks landscape, and takes a screen wake lock;
 *    where navigator.wakeLock is missing (plain http) a muted looping 2 x 2 video does the same job. Every one of these APIs is
 *    optional: the page plays the same without them. iOS has none of the first two and keeps its own behaviour.
 *  - Nothing is logged: the page URL carries the link token.
 */
(() => {
  'use strict';

  // ================================================================================================================
  // 1. Wire constants (copies of protocol.ts; GUIDE is deliberately absent)
  // ================================================================================================================

  const BTN = Object.freeze({
    UP: 0x0001,
    DOWN: 0x0002,
    LEFT: 0x0004,
    RIGHT: 0x0008,
    START: 0x0010,
    BACK: 0x0020,
    L3: 0x0040,
    R3: 0x0080,
    LB: 0x0100,
    RB: 0x0200,
    A: 0x1000,
    B: 0x2000,
    X: 0x4000,
    Y: 0x8000,
  });
  const DPAD_BITS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;
  const AXIS_MAX = 32767;

  // ================================================================================================================
  // MIRROR of src/core/controller/layout.ts (types and LIMITS). Keep in sync by hand; the host sanitizes everything, so a
  // stale number here only affects what the editor offers, never what the host accepts.
  // ================================================================================================================

  const LIMITS = Object.freeze({
    layouts: 20,
    controls: 40,
    nameChars: 32,
    labelChars: 6,
    maxStoreBytes: 256 * 1024,
    size: { min: 4, max: 80 },
    deadzone: { min: 0, max: 0.5 },
    sensitivity: { min: 0.25, max: 3 },
    opacity: { min: 0.1, max: 1 },
    value: { min: 1, max: 255 },
  });
  const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'START', 'BACK', 'L3', 'R3'] as const;
  type ButtonName = (typeof BUTTON_NAMES)[number];
  const CURVES = ['linear', 'precise', 'aggressive'] as const;
  type Curve = (typeof CURVES)[number];
  const SHAPES = ['circle', 'rect', 'pill'] as const;
  type Shape = (typeof SHAPES)[number];

  interface BaseControl {
    id: string;
    x: number;
    y: number;
    opacity: number;
  }
  interface StickControl extends BaseControl {
    type: 'stick';
    stick: 'left' | 'right';
    size: number;
    mode: 'fixed' | 'floating';
    deadzone: number;
    sensitivity: number;
    curve: Curve;
    invertX: boolean;
    invertY: boolean;
    doubleTapClick: boolean;
  }
  interface DpadControl extends BaseControl {
    type: 'dpad';
    size: number;
    diagonals: boolean;
  }
  interface ButtonControl extends BaseControl {
    type: 'button';
    button: ButtonName;
    w: number;
    h: number;
    shape: Shape;
    label: string;
    latch: boolean;
    turbo: boolean;
    value: number;
  }
  type Control = StickControl | DpadControl | ButtonControl;
  interface Layout {
    id: string;
    name: string;
    haptics: boolean;
    controls: Control[];
  }
  interface LayoutStore {
    version: 1;
    activeId: string;
    layouts: Layout[];
  }
  // ================================================================================================================
  // end of the mirror
  // ================================================================================================================

  /** XUSB bit for each digital button name. LT and RT are analog triggers (sent as 255) and have no bit. */
  const BUTTON_BITS: Readonly<Record<string, number>> = Object.freeze({
    A: BTN.A,
    B: BTN.B,
    X: BTN.X,
    Y: BTN.Y,
    LB: BTN.LB,
    RB: BTN.RB,
    START: BTN.START,
    BACK: BTN.BACK,
    L3: BTN.L3,
    R3: BTN.R3,
  });

  // ---- Tuning (page behaviour, not part of the schema) ----
  const SLOTS = 3;
  const DPAD_CENTRE = 0.2; // fraction of the d-pad half-size that counts as "centre"
  const DPAD_TAN = Math.tan(Math.PI / 3); // cardinal arms 60 degrees wide, diagonals 30
  const DOUBLE_TAP_MS = 300;
  const MIN_PRESS_MS = 24; // a button release is deferred until it has been down this long
  const STICK_SEND_MS = 8; // at most one stick frame per 8 ms, plus a trailing one
  const HARD_SEND_GAP_MS = 1000 / 240; // never more than 240 frames per second
  const KEEPALIVE_MS = 500;
  const PING_MS = 1000; // a link probe every second while welcomed
  const PING_DEAD_MS = 2000; // no echo for this long: the link is dead
  const CONNECT_MS = 4000; // a socket that is neither open nor welcomed after this long is abandoned
  const RTT_WARN_MS = 40; // the dot goes amber above this median round trip
  const RTT_SAMPLES = 5;
  const SLOT_TOAST_MS = 1500;
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  const SAVE_RETRY_MS = 5000;
  const TAP_SLOP = 12; // a tap counts when the finger is released within the button plus this many points
  const MAX_SLOT = 99;
  const WS_OPEN = 1;
  const NAME_KEY = 'lanplay.pad.number';
  const HOME_SEEN_KEY = 'lanplay.home.seen';
  const ID_KEY = 'lanplay.pad.id';
  const HAPTIC_KEY = 'lanplay.haptic.strength';
  const ID_CHARS = 24;
  const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'; // 64 symbols: a byte maps without bias
  const HAPTIC_MS = { light: 10, strong: 25 } as const;
  const TURBO_HALF_MS = 50; // rapid fire: 50 ms down, 50 ms up (10 presses a second)
  const CONFIRM_MS = 2000; // a second tap on Delete within this long confirms it
  const FLOATING_ZONE = 1.5; // a floating stick's touch area is this many times its base size (the CSS base is 1 / 1.5 of it)
  const SENSITIVITY_RANGE = { min: 0.5, max: 2 } as const;
  const OPACITY_MIN = 0.2;
  const SIZE_RANGE = { stick: { min: 24, max: 60 }, dpad: { min: 18, max: 45 }, button: { min: 8, max: 30 } } as const;
  const DIM_RANGE = { min: 8, max: 40 } as const; // the Width / Height sliders of a rect or pill button
  const DEADZONE_RANGE = { min: 0, max: 0.5 } as const;
  // The card is 44 pt rows inside 8 pt padding and a 1.5 pt border; its height is worked out from the rows, not measured (see cardHeight).
  const ROW_H = 44;
  const ROW_TWO_H = 52; // a label over a one-line fact
  const CARD_PAD = 19;
  const CARD_W = { settings: 300, control: 280, more: 328 } as const; // the wide one fits six 44 pt chips in a row
  const CHOICE_COLS = 6;

  // ================================================================================================================
  // 2. Pure logic (reachable from tests through the hook at the bottom)
  // ================================================================================================================

  interface Pad {
    b: number;
    lt: number;
    rt: number;
    lx: number;
    ly: number;
    rx: number;
    ry: number;
  }
  interface Axes {
    x: number;
    y: number;
  }
  type Phase = 'notoken' | 'connecting' | 'connected' | 'retrying' | 'full' | 'kicked' | 'replaced';
  /** Phases that end the reconnect loop: the page waits for the user (full, replaced) or for the host (kicked). */
  const isFinal = (p: Phase): boolean => p === 'full' || p === 'kicked' || p === 'replaced';
  /** Close reason the host sends when another page of the same phone (same phone id) took the slot: see protocol.ts. */
  const REPLACED_REASON = 'replaced';
  type ServerMessage = { t: 'welcome'; slot: number } | { t: 'full' } | { t: 'kicked' } | { t: 'p'; n: number };

  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const clampTo = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
  const round = (n: number, places: number): number => {
    const f = 10 ** places;
    return Math.round(n * f) / f;
  };
  function cleanText(v: string, max: number): string {
    return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max).trim();
  }
  /** `prefix`, or `prefix-2`, `prefix-3`... whichever is not in `used`. Result matches the host's id rule [A-Za-z0-9_-]{1,40}. */
  function freshId(prefix: string, used: ReadonlySet<string>): string {
    const base = prefix.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 36) || 'x';
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) {
      const id = `${base}-${n}`;
      if (!used.has(id)) return id;
    }
  }

  // ---- Reading controls from host JSON ---------------------------------------------------------------------------

  type NewKind = 'stick' | 'dpad' | ButtonName;
  const BUTTON_LOOK: Readonly<Record<ButtonName, { w: number; h: number; shape: Shape; label: string }>> = Object.freeze({
    A: { w: 16, h: 16, shape: 'circle', label: 'A' },
    B: { w: 16, h: 16, shape: 'circle', label: 'B' },
    X: { w: 16, h: 16, shape: 'circle', label: 'X' },
    Y: { w: 16, h: 16, shape: 'circle', label: 'Y' },
    LB: { w: 22, h: 13, shape: 'rect', label: 'LB' },
    RB: { w: 22, h: 13, shape: 'rect', label: 'RB' },
    LT: { w: 22, h: 13, shape: 'rect', label: 'LT' },
    RT: { w: 22, h: 13, shape: 'rect', label: 'RT' },
    START: { w: 14, h: 10, shape: 'pill', label: 'Start' },
    BACK: { w: 14, h: 10, shape: 'pill', label: 'Back' },
    L3: { w: 10, h: 10, shape: 'circle', label: 'L3' },
    R3: { w: 10, h: 10, shape: 'circle', label: 'R3' },
  });

  /** A control with the host's defaults (the numbers layout.ts falls back to when a field is missing). */
  function newControl(kind: NewKind, id: string, x: number, y: number): Control {
    const base = { id, x: round(x, 2), y: round(y, 2), opacity: 0.8 };
    if (kind === 'stick') {
      return { ...base, type: 'stick', stick: 'left', size: 36, mode: 'fixed', deadzone: 0.1, sensitivity: 1, curve: 'linear', invertX: false, invertY: false, doubleTapClick: true };
    }
    if (kind === 'dpad') return { ...base, type: 'dpad', size: 26, diagonals: true };
    const look = BUTTON_LOOK[kind];
    return { ...base, type: 'button', button: kind, w: look.w, h: look.h, shape: look.shape, label: look.label, latch: false, turbo: false, value: 255 };
  }

  type Validator = (v: unknown) => unknown;
  const numberIn =
    (lo: number, hi: number, places: number): Validator =>
    (v) =>
      isNum(v) ? round(clampTo(v, lo, hi), places) : undefined;
  const oneOf =
    (list: readonly string[]): Validator =>
    (v) =>
      typeof v === 'string' && list.includes(v) ? v : undefined;
  const flag: Validator = (v) => (typeof v === 'boolean' ? v : undefined);
  const dimension = numberIn(LIMITS.size.min, LIMITS.size.max, 2);
  const COMMON_PROPS: Record<string, Validator> = { x: numberIn(0, 100, 2), y: numberIn(0, 100, 2), opacity: numberIn(LIMITS.opacity.min, LIMITS.opacity.max, 2) };
  /** What a control may carry: everything layout.ts stores. Unknown keys and invalid values are ignored. */
  const PROPS: Record<Control['type'], Record<string, Validator>> = {
    stick: {
      ...COMMON_PROPS,
      stick: oneOf(['left', 'right']),
      size: dimension,
      mode: oneOf(['fixed', 'floating']),
      deadzone: numberIn(LIMITS.deadzone.min, LIMITS.deadzone.max, 3),
      sensitivity: numberIn(LIMITS.sensitivity.min, LIMITS.sensitivity.max, 3),
      curve: oneOf(CURVES),
      invertX: flag,
      invertY: flag,
      doubleTapClick: flag,
    },
    dpad: { ...COMMON_PROPS, size: dimension, diagonals: flag },
    button: {
      ...COMMON_PROPS,
      button: oneOf(BUTTON_NAMES),
      w: dimension,
      h: dimension,
      shape: oneOf(SHAPES),
      label: (v) => (typeof v === 'string' ? cleanText(v, LIMITS.labelChars) : undefined),
      latch: flag,
      turbo: flag,
      value: numberIn(LIMITS.value.min, LIMITS.value.max, 0),
    },
  };

  /** Apply validated properties (unknown keys and invalid values are ignored). Returns the SAME object when nothing changed. */
  function applyProps(c: Control, patch: Readonly<Record<string, unknown>>): Control {
    const table = PROPS[c.type];
    const next: Record<string, unknown> = { ...c };
    let changed = false;
    for (const key of Object.keys(patch)) {
      const validate = table[key];
      if (!validate) continue;
      const v = validate(patch[key]);
      if (v === undefined || v === next[key]) continue;
      next[key] = v;
      changed = true;
    }
    if (c.type === 'button') {
      const b = next as unknown as ButtonControl;
      if (b.label === '') b.label = BUTTON_LOOK[b.button].label;
      if (b.label !== c.label) changed = true;
    }
    return changed ? (next as unknown as Control) : c;
  }

  /** Tolerant read of a control from host JSON: anything missing or invalid falls back to the defaults. Never throws. */
  function coerceControl(raw: unknown, used: Set<string>, index: number): Control | null {
    if (!isObj(raw)) return null;
    const type = raw['type'];
    let kind: NewKind;
    if (type === 'stick' || type === 'dpad') kind = type;
    else if (type === 'button' && typeof raw['button'] === 'string' && (BUTTON_NAMES as readonly string[]).includes(raw['button'])) kind = raw['button'] as ButtonName;
    else return null;
    const wanted = typeof raw['id'] === 'string' ? raw['id'] : `${kind.toLowerCase()}-${index}`;
    const id = freshId(wanted, used);
    used.add(id);
    return applyProps(newControl(kind, id, 50, 50), raw);
  }

  /** Tolerant read of a store from host JSON, or null when it has no usable layout. Layouts beyond the three slots are kept as they are. */
  function coerceStore(raw: unknown): LayoutStore | null {
    if (!isObj(raw) || !Array.isArray(raw['layouts'])) return null;
    const usedLayouts = new Set<string>();
    const layouts: Layout[] = [];
    for (const rl of raw['layouts']) {
      if (layouts.length >= LIMITS.layouts) break;
      if (!isObj(rl) || !Array.isArray(rl['controls'])) continue;
      const id = freshId(typeof rl['id'] === 'string' ? rl['id'] : `layout-${layouts.length + 1}`, usedLayouts);
      usedLayouts.add(id);
      const usedControls = new Set<string>();
      const controls: Control[] = [];
      for (let i = 0; i < rl['controls'].length && controls.length < LIMITS.controls; i++) {
        const c = coerceControl(rl['controls'][i], usedControls, i);
        if (c) controls.push(c);
      }
      const name = typeof rl['name'] === 'string' ? cleanText(rl['name'], LIMITS.nameChars) : '';
      layouts.push({ id, name: name || `Layout ${layouts.length + 1}`, haptics: typeof rl['haptics'] === 'boolean' ? rl['haptics'] : true, controls });
    }
    const first = layouts[0];
    if (!first) return null;
    const wanted = raw['activeId'];
    return { version: 1, activeId: layouts.some((l) => l.id === wanted) ? (wanted as string) : first.id, layouts };
  }

  // ---- Geometry of controls --------------------------------------------------------------------------------------

  /** Touch-area size of a control as [width, height], in percent of the field HEIGHT. */
  function controlBox(c: Control): [number, number] {
    if (c.type === 'button') return [c.w, c.h];
    const s = c.type === 'stick' && c.mode === 'floating' ? c.size * FLOATING_ZONE : c.size;
    return [s, s];
  }

  /**
   * Where a floating stick's base is drawn on one axis: under the first touch, but kept inside the touch area so the whole base
   * stays visible. `centre` is the touch area's centre, `zone` its half size and `radius` that of the base (all pixels).
   */
  function floatingCentre(touch: number, centre: number, zone: number, radius: number): number {
    const slack = Math.max(0, zone - radius);
    return clampTo(touch, centre - slack, centre + slack);
  }

  /** Half extent of a control as [percent of width, percent of height]; `aspect` = field width / height. */
  function halfExtent(c: Control, aspect: number): [number, number] {
    const [w, h] = controlBox(c);
    return [w / 2 / (aspect > 0 ? aspect : 1), h / 2];
  }

  /** Keep a centre coordinate (percent) so the whole control stays on screen; a control larger than the screen is centred. */
  function clampCentre(v: number, half: number): number {
    return round(half * 2 >= 100 ? 50 : clampTo(v, half, 100 - half), 2);
  }

  interface Box {
    cx: number;
    cy: number;
    hw: number;
    hh: number;
  }

  /**
   * Where the settings/property card goes: centred on the field, unless that would cover the selected control, then the opposite
   * half (and, if the control is large, the other side or the top/bottom band). `box` is the control and `card` the card size, both
   * in pixels of the field; returns the card centre. Tries to keep a small gap around the control.
   */
  function placeCard(box: Box, card: { w: number; h: number }, field: { w: number; h: number }, gap = 8, top = gap): { x: number; y: number } {
    const hw = card.w / 2;
    const hh = card.h / 2;
    // `top`: the card's top edge never goes above this (it keeps the card out from under the Done button).
    const fit = (x: number, y: number): { x: number; y: number } => ({ x: clampTo(x, hw + gap, Math.max(hw + gap, field.w - hw - gap)), y: clampTo(y, top + hh, Math.max(top + hh, field.h - hh - gap)) });
    const hits = (p: { x: number; y: number }): boolean => Math.abs(p.x - box.cx) < hw + box.hw + gap && Math.abs(p.y - box.cy) < hh + box.hh + gap;
    const midX = field.w / 2;
    const midY = field.h / 2;
    const leftFirst = box.cx >= midX;
    const candidates = [
      fit(midX, midY),
      fit(leftFirst ? field.w * 0.25 : field.w * 0.75, midY),
      fit(leftFirst ? field.w * 0.75 : field.w * 0.25, midY),
      // a big control: put the card flush against its right or left side, or in the band above or below it
      fit(box.cx + box.hw + gap + hw, midY),
      fit(box.cx - box.hw - gap - hw, midY),
      fit(midX, box.cy >= midY ? top + hh : field.h - hh - gap),
    ];
    for (const c of candidates) if (!hits(c)) return c;
    return candidates[1] as { x: number; y: number };
  }

  /**
   * The settings card (nothing selected): on the vertical centre line, at the height that covers the least control area (so every
   * control stays tappable when possible), the one nearest the middle among equals. Its top edge stays at or below `top`.
   */
  function placeSettingsCard(boxes: readonly Box[], card: { w: number; h: number }, field: { w: number; h: number }, top: number, gap = 8): { x: number; y: number } {
    const hw = card.w / 2;
    const hh = card.h / 2;
    const x = clampTo(field.w / 2, hw + gap, Math.max(hw + gap, field.w - hw - gap));
    const lo = top + hh;
    const hi = Math.max(lo, field.h - hh - gap);
    const midY = clampTo(field.h / 2, lo, hi);
    const covered = (y: number): number => {
      let area = 0;
      for (const b of boxes) {
        const ox = Math.min(x + hw + gap, b.cx + b.hw) - Math.max(x - hw - gap, b.cx - b.hw);
        const oy = Math.min(y + hh + gap, b.cy + b.hh) - Math.max(y - hh - gap, b.cy - b.hh);
        if (ox > 0 && oy > 0) area += ox * oy;
      }
      return area;
    };
    let best = { y: midY, area: covered(midY) };
    for (let y = lo; y <= hi + 0.01; y += 4) {
      const area = covered(y);
      if (area < best.area - 0.5 || (Math.abs(area - best.area) <= 0.5 && Math.abs(y - midY) < Math.abs(best.y - midY))) best = { y, area };
    }
    return { x, y: best.y };
  }

  /** Card height from its rows (each a number of pixels): padding and border plus rows, never taller than `max` (the card scrolls then). */
  function cardHeight(rows: readonly number[], max: number): number {
    return Math.min(Math.max(max, ROW_H), CARD_PAD + rows.reduce((a, b) => a + b, 0));
  }

  // ---- Layout store operations (pure: each returns a new store, or the SAME store when it is a no-op) ------------------

  function activeLayout(store: LayoutStore): Layout {
    return store.layouts.find((l) => l.id === store.activeId) ?? (store.layouts[0] as Layout);
  }
  function switchLayout(store: LayoutStore, id: string): LayoutStore {
    return id !== store.activeId && store.layouts.some((l) => l.id === id) ? { ...store, activeId: id } : store;
  }

  function mapActive(store: LayoutStore, fn: (l: Layout) => Layout): LayoutStore {
    const cur = activeLayout(store);
    const next = fn(cur);
    return next === cur ? store : { ...store, layouts: store.layouts.map((l) => (l === cur ? next : l)) };
  }
  function mapControl(store: LayoutStore, id: string, fn: (c: Control, layout: Layout) => Control): LayoutStore {
    return mapActive(store, (l) => {
      const i = l.controls.findIndex((c) => c.id === id);
      const c = l.controls[i];
      if (!c) return l;
      const next = fn(c, l);
      return next === c ? l : { ...l, controls: l.controls.map((x, j) => (j === i ? next : x)) };
    });
  }

  /** Move a control's centre (percent) keeping the whole control on screen. */
  function moveControl(store: LayoutStore, id: string, x: number, y: number, aspect = 2): LayoutStore {
    if (!isNum(x) || !isNum(y)) return store;
    return mapControl(store, id, (c) => {
      const [hx, hy] = halfExtent(c, aspect);
      const nx = clampCentre(x, hx);
      const ny = clampCentre(y, hy);
      return nx === c.x && ny === c.y ? c : { ...c, x: nx, y: ny };
    });
  }

  /** The one number the Size slider edits: the diameter of a stick or d-pad, the height of a button. */
  function sizeOf(c: Control): number {
    return c.type === 'button' ? c.h : c.size;
  }
  /** Slider range for Size, widened to include a stored value outside it. */
  function sizeRange(c: Control): { min: number; max: number } {
    const r = SIZE_RANGE[c.type];
    const cur = sizeOf(c);
    return { min: Math.min(r.min, cur), max: Math.max(r.max, cur) };
  }
  /** Touch-area size [w, h] (percent of the field height) of a control at the top of its Size range, keeping a button's ratio. */
  function reachBox(c: Control): [number, number] {
    const max = sizeRange(c).max;
    if (c.type !== 'button') return [max, max];
    return [c.h > 0 ? (max * c.w) / c.h : max, max];
  }
  function opacityRange(c: Control): { min: number; max: number } {
    return { min: Math.min(OPACITY_MIN, c.opacity), max: 1 };
  }
  /** Range of the Width / Height sliders, widened to include a stored value outside it. */
  function dimRange(v: number): { min: number; max: number } {
    return { min: Math.min(DIM_RANGE.min, v), max: Math.max(DIM_RANGE.max, v) };
  }
  /** Height (px) of a wrapped choice row: a label line and `count` chips in rows of CHOICE_COLS. */
  function gridHeight(count: number): number {
    const lines = Math.max(1, Math.ceil(count / CHOICE_COLS));
    return 24 + lines * ROW_H + (lines - 1) * 4;
  }

  /** The three ways a button can behave, as the "Mode" choice shows them (latch wins if a stored button has both flags). */
  type ButtonMode = 'hold' | 'toggle' | 'rapid';
  function buttonMode(c: ButtonControl): ButtonMode {
    return c.latch ? 'toggle' : c.turbo ? 'rapid' : 'hold';
  }
  function modePatch(m: ButtonMode): { latch: boolean; turbo: boolean } {
    return { latch: m === 'toggle', turbo: m === 'rapid' };
  }

  /** `c` with `patch` applied and, when that changed it, its centre pulled back so the whole control is on screen. */
  function patchControl(c: Control, patch: Readonly<Record<string, unknown>>, aspect: number): Control {
    const next = applyProps(c, patch);
    if (next === c) return c;
    const [hx, hy] = halfExtent(next, aspect);
    return { ...next, x: clampCentre(next.x, hx), y: clampCentre(next.y, hy) };
  }

  /**
   * Set the Size of a control. Buttons scale width and height together: `ratio` (width / height) is the one the control had when
   * the slider was grabbed, so repeated rounding cannot make it drift. The control is kept on screen.
   */
  function setSize(store: LayoutStore, id: string, value: number, ratio?: number, aspect = 2): LayoutStore {
    if (!isNum(value)) return store;
    return mapControl(store, id, (c) => {
      const r = sizeRange(c);
      const v = round(clampTo(value, r.min, r.max), 2);
      if (c.type !== 'button') return patchControl(c, { size: v }, aspect);
      const k = ratio !== undefined && ratio > 0 ? ratio : c.h > 0 ? c.w / c.h : 1;
      return patchControl(c, { h: v, w: round(v * k, 2) }, aspect);
    });
  }

  /**
   * Set any properties the "More" panel offers (validated and clamped by applyProps; unknown keys are ignored). Two rules the panel
   * relies on: giving a button a new mapping renames it too, unless the player gave it a label of their own; and a circle is
   * always round, so choosing it squares the button off to its height.
   */
  function setProps(store: LayoutStore, id: string, patch: Readonly<Record<string, unknown>>, aspect = 2): LayoutStore {
    return mapControl(store, id, (c) => {
      let p = patch;
      if (c.type === 'button') {
        const to = patch['button'];
        if (typeof to === 'string' && (BUTTON_NAMES as readonly string[]).includes(to) && c.label === BUTTON_LOOK[c.button].label && !('label' in patch)) p = { ...p, label: BUTTON_LOOK[to as ButtonName].label };
        if (patch['shape'] === 'circle') p = { ...p, w: c.h };
      }
      return patchControl(c, p, aspect);
    });
  }

  /** Which control kinds the editor can add. */
  type AddKind = 'button' | 'stick' | 'dpad';

  /**
   * Put a new control in the middle of the active layout. A button gets the first button name the layout does not have yet, a
   * stick the side it does not have yet. Null when the layout is full (LIMITS.controls).
   */
  function addControl(store: LayoutStore, kind: AddKind): { store: LayoutStore; id: string } | null {
    const layout = activeLayout(store);
    if (layout.controls.length >= LIMITS.controls) return null;
    const id = freshId(kind === 'button' ? 'btn' : kind, new Set(layout.controls.map((c) => c.id)));
    let made: Control;
    if (kind === 'button') {
      const used = new Set(layout.controls.flatMap((c) => (c.type === 'button' ? [c.button] : [])));
      made = newControl(BUTTON_NAMES.find((n) => !used.has(n)) ?? 'A', id, 50, 50);
    } else {
      made = newControl(kind, id, 50, 50);
      if (made.type === 'stick' && layout.controls.some((c) => c.type === 'stick' && c.stick === 'left')) made = { ...made, stick: 'right' };
    }
    return { store: mapActive(store, (l) => ({ ...l, controls: [...l.controls, made] })), id };
  }

  /** A copy of a control, a little down and to the right so it can be told from the original. Null when the layout is full. */
  function duplicateControl(store: LayoutStore, id: string, aspect = 2): { store: LayoutStore; id: string } | null {
    const layout = activeLayout(store);
    const src = layout.controls.find((c) => c.id === id);
    if (!src || layout.controls.length >= LIMITS.controls) return null;
    const copyId = freshId(src.id, new Set(layout.controls.map((c) => c.id)));
    const [hx, hy] = halfExtent(src, aspect);
    const copy: Control = { ...src, id: copyId, x: clampCentre(src.x + 4, hx), y: clampCentre(src.y + 6, hy) };
    return { store: mapActive(store, (l) => ({ ...l, controls: [...l.controls, copy] })), id: copyId };
  }

  function deleteControl(store: LayoutStore, id: string): LayoutStore {
    return mapActive(store, (l) => (l.controls.some((c) => c.id === id) ? { ...l, controls: l.controls.filter((c) => c.id !== id) } : l));
  }

  function setOpacity(store: LayoutStore, id: string, value: number): LayoutStore {
    if (!isNum(value)) return store;
    return mapControl(store, id, (c) => applyProps(c, { opacity: clampTo(value, opacityRange(c).min, 1) }));
  }

  /** The stick sensitivity shown in the settings card: that of the first stick in the layout (1 when there is none). */
  function layoutSensitivity(l: Layout): number {
    const s = l.controls.find((c): c is StickControl => c.type === 'stick');
    return s ? s.sensitivity : 1;
  }
  /** Write a stick sensitivity (0.5..2.0) to every stick of the active layout. */
  function setSensitivity(store: LayoutStore, value: number): LayoutStore {
    if (!isNum(value)) return store;
    const v = round(clampTo(value, SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max), 3);
    return mapActive(store, (l) => {
      let changed = false;
      const controls = l.controls.map((c) => {
        if (c.type !== 'stick' || c.sensitivity === v) return c;
        changed = true;
        return { ...c, sensitivity: v };
      });
      return changed ? { ...l, controls } : l;
    });
  }
  /** Haptics on or off, written to every layout. */
  function setHaptics(store: LayoutStore, on: boolean): LayoutStore {
    if (store.layouts.every((l) => l.haptics === on)) return store;
    return { ...store, layouts: store.layouts.map((l) => (l.haptics === on ? l : { ...l, haptics: on })) };
  }

  /**
   * Fill an empty slot: a copy of the stock layout (`template`) made active. It inherits the haptics setting and stick sensitivity of
   * the layout the user is on, so those two settings feel global.
   */
  function addSlot(store: LayoutStore, template: Layout): LayoutStore {
    if (store.layouts.length >= LIMITS.layouts) return store;
    const cur = activeLayout(store);
    const sens = layoutSensitivity(cur);
    const id = freshId('layout', new Set(store.layouts.map((l) => l.id)));
    const controls = template.controls.slice(0, LIMITS.controls).map((c): Control => (c.type === 'stick' ? { ...c, sensitivity: sens } : { ...c }));
    return { version: 1, activeId: id, layouts: [...store.layouts, { id, name: cleanText(template.name, LIMITS.nameChars) || 'Layout', haptics: cur.haptics, controls }] };
  }
  /** Replace the controls of one layout with the stock ones; id, name, haptics and the stick sensitivity stay. */
  function resetLayout(store: LayoutStore, id: string, stock: Layout): LayoutStore {
    const old = store.layouts.find((l) => l.id === id);
    if (!old) return store;
    const sens = layoutSensitivity(old);
    const controls = stock.controls.slice(0, LIMITS.controls).map((c): Control => (c.type === 'stick' ? { ...c, sensitivity: sens } : { ...c }));
    return { ...store, layouts: store.layouts.map((l) => (l.id === id ? { ...l, controls } : l)) };
  }

  // ---- Pad state -------------------------------------------------------------------------------------------------

  const NEUTRAL: Readonly<Pad> = Object.freeze({ b: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
  const ZERO: Readonly<Axes> = Object.freeze({ x: 0, y: 0 });

  interface StickParams {
    deadzone: number;
    sensitivity: number;
    curve: Curve;
    invertX: boolean;
    invertY: boolean;
  }
  const STICK_DEFAULTS: Readonly<StickParams> = Object.freeze({ deadzone: 0.1, sensitivity: 1, curve: 'linear', invertX: false, invertY: false });

  /**
   * Stick offset from the base centre (pixels, y grows downwards) to XInput axes:
   *   r = min(1, distance / radius);  below the dead zone the output is 0, otherwise m = (r - dz) / (1 - dz);
   *   curve (linear m, precise m*m, aggressive sqrt m);  m = min(1, m * sensitivity);  axis = unit vector * m * 32767;
   *   then invertX / invertY. Up is positive on the wire, so a screen-up drag gives a positive y unless invertY is set.
   */
  function stickAxes(dx: number, dy: number, radius: number, p: Readonly<StickParams> = STICK_DEFAULTS): Axes {
    const dist = Math.hypot(dx, dy);
    if (!(radius > 0) || !(dist > 0)) return { x: 0, y: 0 };
    const r = Math.min(1, dist / radius);
    if (r < p.deadzone) return { x: 0, y: 0 };
    let m = p.deadzone >= 1 ? 0 : (r - p.deadzone) / (1 - p.deadzone);
    m = p.curve === 'precise' ? m * m : p.curve === 'aggressive' ? Math.sqrt(m) : m;
    m = Math.min(1, m * p.sensitivity);
    let x = (dx / dist) * m * AXIS_MAX;
    let y = (-dy / dist) * m * AXIS_MAX;
    if (p.invertX) x = -x;
    if (p.invertY) y = -y;
    return { x: Math.round(x) || 0, y: Math.round(y) || 0 };
  }

  /** How far the stick is pulled, 0..1 (the haptic clock follows this, not the curved output). */
  function deflection(dx: number, dy: number, radius: number): number {
    const dist = Math.hypot(dx, dy);
    return radius > 0 && dist > 0 ? Math.min(1, dist / radius) : 0;
  }

  /** Limit an offset to a circle (keeps the knob drawing inside the base). */
  function limitToRadius(dx: number, dy: number, radius: number): Axes {
    const len = Math.hypot(dx, dy);
    if (!(len > radius) || !(len > 0)) return { x: dx, y: dy };
    return { x: (dx / len) * radius, y: (dy / len) * radius };
  }

  /** D-pad bits for a touch offset from the pad centre. With diagonals: hat style (up to two adjacent bits). Without: one bit. */
  function dpadMask(dx: number, dy: number, half: number, diagonals = true): number {
    const len = Math.hypot(dx, dy);
    if (!(len > 0) || len <= half * DPAD_CENTRE) return 0;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (!diagonals) return ax >= ay ? (dx < 0 ? BTN.LEFT : BTN.RIGHT) : dy < 0 ? BTN.UP : BTN.DOWN;
    let m = 0;
    if (ay <= ax * DPAD_TAN) m |= dx < 0 ? BTN.LEFT : BTN.RIGHT;
    if (ax <= ay * DPAD_TAN) m |= dy < 0 ? BTN.UP : BTN.DOWN;
    return m;
  }

  /** XUSB bits for a set of button names plus the d-pad. LT and RT add nothing here (see buildPad). */
  function buttonMask(buttons: Iterable<string>, dpad: number): number {
    let m = dpad & DPAD_BITS;
    for (const name of buttons) m |= BUTTON_BITS[name] ?? 0;
    return m;
  }

  /** The wire state for the buttons currently down. LT and RT send `trigger` (the control's strength, 255 unless the player lowered it). */
  function buildPad(buttons: Iterable<ButtonName>, dpad: number, ls: Readonly<Axes>, rs: Readonly<Axes>, trigger: Readonly<{ LT: number; RT: number }> = { LT: 255, RT: 255 }): Pad {
    let b = dpad & DPAD_BITS;
    let lt = 0;
    let rt = 0;
    for (const name of buttons) {
      if (name === 'LT') lt = trigger.LT;
      else if (name === 'RT') rt = trigger.RT;
      else b |= BUTTON_BITS[name] ?? 0;
    }
    const axis = (v: number): number => clampTo(Math.round(v) || 0, -32768, AXIS_MAX);
    return { b, lt, rt, lx: axis(ls.x), ly: axis(ls.y), rx: axis(rs.x), ry: axis(rs.y) };
  }

  function samePad(a: Readonly<Pad> | null, b: Readonly<Pad>): boolean {
    return a !== null && a.b === b.b && a.lt === b.lt && a.rt === b.rt && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx && a.ry === b.ry;
  }

  /** A release must wait until the press has lasted MIN_PRESS_MS (a game that polls at 60 Hz can miss a 2 ms press). */
  function releaseDelay(pressedAt: number, now: number, minMs = MIN_PRESS_MS): number {
    return Math.max(0, minMs - (now - pressedAt));
  }

  /** Two taps on a stick: the second touch starts within 300 ms of the first tap's release. */
  function isDoubleTap(lastTapEnd: number | null, now: number): boolean {
    return lastTapEnd !== null && now >= lastTapEnd && now - lastTapEnd <= DOUBLE_TAP_MS;
  }

  // ---- Haptic decisions (pure; createHaptics below wires them to timers and sinks) --------------------------------------

  type HapticMode = 'android' | 'ios' | 'none';

  function isIosDevice(ua: string, maxTouchPoints: number): boolean {
    return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1);
  }

  /** Android and desktop Chrome have navigator.vibrate; iOS Safari does not (its tick comes from the switch overlays); anything else stays silent. */
  function hapticMode(ua: string, maxTouchPoints: number, hasVibrate: boolean): HapticMode {
    if (hasVibrate) return 'android';
    return isIosDevice(ua, maxTouchPoints) ? 'ios' : 'none';
  }

  /** Android stick feedback by deflection d: a pulse of `pulse` ms every `period` ms, stronger (longer, more often) the farther it is pulled. */
  function androidPattern(d: number): { pulse: number; period: number } | null {
    if (!(d >= 0.15)) return null;
    if (d < 0.4) return { pulse: 6, period: 140 };
    if (d < 0.65) return { pulse: 10, period: 110 };
    if (d < 0.9) return { pulse: 16, period: 90 };
    return { pulse: 24, period: 80 };
  }

  interface AndroidStick {
    active: boolean;
    /** When the next pulse is due. */
    nextAt: number;
    /** Length of the pulse train currently running, so a stronger pull can take over at once. */
    pulse: number;
  }
  /**
   * One step of the Android stick clock. Returns the new state, the argument for navigator.vibrate (0 cancels) or null, and how long
   * until the clock must be consulted again (null: not needed).
   */
  function androidStickStep(s: AndroidStick, d: number, now: number): { s: AndroidStick; vibrate: number | null; wait: number | null } {
    const p = androidPattern(d);
    if (!p) return { s: { active: false, nextAt: 0, pulse: 0 }, vibrate: s.active ? 0 : null, wait: null };
    // A stronger pull starts its pulse train at once; a weaker one waits for the current pulse to finish.
    if (!s.active || now >= s.nextAt || p.pulse > s.pulse) return { s: { active: true, nextAt: now + p.period, pulse: p.pulse }, vibrate: p.pulse, wait: p.period };
    return { s, vibrate: null, wait: s.nextAt - now };
  }

  interface HapticDeps {
    mode: HapticMode;
    /** Layout setting: false means no vibration anywhere. */
    enabled(): boolean;
    /** Android sink: navigator.vibrate. */
    vibrate(ms: number): void;
    /** Length of one press tick (10 when absent). */
    tickMs?(): number;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
  }
  interface Haptics {
    /** One press tick (buttons, d-pad direction change, stick touch-down). */
    tick(): void;
    /** The larger deflection of the two sticks, 0..1; call on every stick event and with 0 on release. */
    setStick(d: number): void;
    /** Cancel everything (release, hidden, blur, edit mode). */
    stop(): void;
  }

  /**
   * Android: a vibrate per press (10 ms, 25 ms on Strong) and a pulse train that follows the stick pull. Everything else does nothing here: iOS has no
   * programmatic haptic any more (a script-made switch click or a timer is not a trusted gesture), its ticks are real touches on
   * the overlays. Never throws.
   */
  function createHaptics(deps: HapticDeps): Haptics {
    let android: AndroidStick = { active: false, nextAt: 0, pulse: 0 };
    let timer: unknown = null;
    let timerDue = 0;
    let lastD = 0;
    const safe = (fn: () => void): void => {
      try {
        fn();
      } catch {
        /* haptics are a nicety */
      }
    };
    const clearTimer = (): void => {
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    };
    /** Keep one timer due `wait` ms from `now`; an already armed timer for (nearly) the same moment is left alone. */
    const arm = (wait: number | null, now: number): void => {
      if (wait === null) return clearTimer();
      const due = now + Math.max(1, Math.ceil(wait));
      if (timer !== null && Math.abs(due - timerDue) < 2) return;
      clearTimer();
      timerDue = due;
      timer = deps.setTimer(onTimer, due - now);
    };
    function step(): void {
      const now = deps.now();
      const r = androidStickStep(android, lastD, now);
      android = r.s;
      if (r.vibrate !== null) {
        const ms = r.vibrate;
        safe(() => deps.vibrate(ms));
      }
      arm(r.wait, now);
    }
    function onTimer(): void {
      timer = null;
      if (!deps.enabled()) return stop();
      step();
    }
    function stop(): void {
      clearTimer();
      lastD = 0;
      if (android.active) {
        android = { active: false, nextAt: 0, pulse: 0 };
        safe(() => deps.vibrate(0));
      }
    }
    return {
      tick(): void {
        if (deps.mode === 'android' && deps.enabled()) safe(() => deps.vibrate(deps.tickMs ? deps.tickMs() : 10));
      },
      setStick(d: number): void {
        if (deps.mode !== 'android') return;
        if (!deps.enabled()) return stop();
        lastD = d;
        if (d <= 0) return stop();
        step();
      },
      stop,
    };
  }

  // ---- Switch overlay diagnostics (pure) ---------------------------------------------------------------------------------

  /**
   * One line for ?diag=1: how long after the finger touched the switch its click arrived. A click within a few ms of the touch
   * means the browser fires it on press, otherwise it fires on release (the finger was down for about that long).
   */
  function describeSwitchClick(downAt: number | null, clickAt: number): string {
    if (downAt === null || clickAt < downAt) return 'click, touch time unknown';
    const ms = Math.round(clickAt - downAt);
    return 'click ' + ms + ' ms after touch (' + (ms < 30 ? 'on press' : 'on release') + ')';
  }

  // ---- Add to Home Screen (pure) -----------------------------------------------------------------------------------------

  type HomeMode = 'sheet' | 'prompt' | 'steps';
  /**
   * What the "Add to Home Screen" row does: 'prompt' calls the install prompt Chrome handed over (it needs https, so on a LAN
   * address it does not come), 'sheet' shows the steps (iOS has no API for it), 'steps' is one line of text for Android Chrome,
   * null hides the row (already installed and running standalone, or nothing to offer).
   */
  function homeScreenMode(ua: string, maxTouchPoints: number, standalone: boolean, hasPrompt: boolean): HomeMode | null {
    if (standalone) return null;
    if (hasPrompt) return 'prompt';
    if (isIosDevice(ua, maxTouchPoints)) return 'sheet';
    return /Android/i.test(ua) ? 'steps' : null;
  }

  // ---- Protocol helpers --------------------------------------------------------------------------------------------

  /** Delay before reconnect attempt number `attempt` (0-based): 500, 1000, 2000, 4000, 5000, 5000... */
  function backoffDelay(attempt: number): number {
    return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  }

  function deviceLabel(ua: string, maxTouchPoints: number): string {
    if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) return 'iPad';
    if (/iPhone|iPod/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) return 'Android phone';
    return 'Phone';
  }

  /** "iPhone 47": a device label and a two-digit number that tells two similar phones apart on the host screen. */
  function playerName(ua: string, maxTouchPoints: number, n: number): string {
    return deviceLabel(ua, maxTouchPoints) + ' ' + String(clampTo(Math.trunc(n) || 10, 10, 99));
  }

  function wsUrl(loc: { protocol: string; host: string }, token: string): string {
    return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws?t=' + encodeURIComponent(token);
  }

  function parseServerMessage(raw: unknown): ServerMessage | null {
    if (typeof raw !== 'string' || raw.length > 512) return null;
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isObj(j)) return null;
    switch (j['t']) {
      case 'welcome': {
        const slot = j['slot'];
        return typeof slot === 'number' && Number.isInteger(slot) && slot >= 1 && slot <= MAX_SLOT ? { t: 'welcome', slot } : null;
      }
      case 'full':
        return { t: 'full' };
      case 'kicked':
        return { t: 'kicked' };
      case 'p': {
        const n = j['n'];
        return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? { t: 'p', n } : null;
      }
      default:
        return null;
    }
  }

  /** A random phone id of ID_CHARS symbols from random bytes (at least ID_CHARS of them). */
  function newPhoneId(bytes: ArrayLike<number>): string {
    let out = '';
    for (let i = 0; i < ID_CHARS; i++) out += ID_ALPHABET.charAt((bytes[i] ?? 0) & 63);
    return out;
  }
  const isPhoneId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,32}$/.test(v);

  /** Median of the newest round trips (ms); null before the first echo. One Wi-Fi hiccup does not move it. */
  function medianRtt(samples: readonly number[]): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[sorted.length >> 1] as number;
  }
  const linkText = (ms: number | null): string => 'Link: ' + (ms === null ? '...' : Math.max(0, Math.round(ms)) + ' ms');

  type HapticLevel = 'light' | 'strong';
  const hapticLevelOf = (v: string | null): HapticLevel => (v === 'strong' ? 'strong' : 'light');

  function statusText(phase: Phase, slot: number | null): string {
    switch (phase) {
      case 'notoken':
        return 'Open the link or QR code from the LanPlay host screen';
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return slot === null ? 'Connected' : 'Player ' + slot;
      case 'retrying':
        return 'Disconnected — retrying...';
      case 'full':
        return 'All 4 player slots are taken';
      case 'kicked':
        return 'Removed from this PC';
      case 'replaced':
        return 'Open in another tab';
    }
  }

  const BUTTON_ARIA: Readonly<Record<ButtonName, string>> = Object.freeze({
    A: 'A button',
    B: 'B button',
    X: 'X button',
    Y: 'Y button',
    LB: 'Left bumper',
    RB: 'Right bumper',
    LT: 'Left trigger',
    RT: 'Right trigger',
    START: 'Start',
    BACK: 'Back',
    L3: 'Left stick click (L3)',
    R3: 'Right stick click (R3)',
  });
  const controlName = (c: Control): string => (c.type === 'button' ? BUTTON_ARIA[c.button] : c.type === 'stick' ? (c.stick === 'left' ? 'Left' : 'Right') + ' stick' : 'D-pad');

  // ================================================================================================================
  // 3. The page
  // ================================================================================================================

  interface ButtonHold {
    kind: 'btn';
    cid: string;
  }
  interface StickHold {
    kind: 'stick';
    cid: string;
    side: 'left' | 'right';
    /** Base centre and radius in CSS pixels, measured on resize (never on touch). */
    cx: number;
    cy: number;
    radius: number;
    params: StickParams;
    downAt: number;
    click: boolean;
    ax: Axes;
    /** Deflection 0..1 for the haptic clock. */
    d: number;
    knob: HTMLElement | null;
  }
  interface DpadHold {
    kind: 'dpad';
    cid: string;
    cx: number;
    cy: number;
    half: number;
    diagonals: boolean;
    bits: number;
    el: HTMLElement;
  }
  type Hold = ButtonHold | StickHold | DpadHold;
  interface EditDrag {
    pointerId: number;
    id: string;
    /** The control centre minus the finger, in percent. */
    ox: number;
    oy: number;
  }
  interface ApiResult {
    ok: boolean;
    status: number;
    body: unknown;
  }
  interface Booted {
    destroy(): void;
  }

  function boot(): Booted {
    const ac = new AbortController();
    const on = { signal: ac.signal };
    const onPassive = { signal: ac.signal, passive: true };

    const must = <T extends HTMLElement>(id: string): T => {
      const el = document.getElementById(id);
      if (!el) throw new Error('controller page is missing #' + id);
      return el as T;
    };
    const fieldEl = must('field');
    const menu = must('menu');
    const menuSlot = must('menu-slot');
    const done = must('done');
    const card = must('card');
    const noticeEl = must('notice');
    const noticeText = must('notice-text');
    const retryBtn = must('retry');
    const sheet = must('a2hs');
    const sheetClose = must('a2hs-close');
    const fsOffer = must('fs-offer');
    const fsGo = must('fs-go');
    const fsSkip = must('fs-skip');
    const slotToast = must('slot-toast');

    // Monotonic: a wall-clock step (NTP, manual time change) must not stall the send gap or the minimum-press timer.
    const now = (): number => performance.now();

    // ---- Storage (private mode and blocked storage throw). Only the player-name digits live here. ----
    const storageGet = (k: string): string | null => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    };
    const storageSet = (k: string, v: string): void => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* storage unavailable: carry on without it */
      }
    };

    // ---- Page state ----
    const params = new URLSearchParams(location.search);
    const ua = navigator.userAgent;
    const hmode = hapticMode(ua, navigator.maxTouchPoints ?? 0, typeof navigator.vibrate === 'function');
    const token = params.get('t');
    let phase: Phase = token ? 'connecting' : 'notoken';
    let slot: number | null = null;
    let layoutState: 'loading' | 'ready' | 'failed' = 'loading';
    let store: LayoutStore | null = null;
    let mode: 'play' | 'edit' = 'play';
    let portrait = false;
    let destroyed = false;
    /** Bumped by every edit; a save response is only adopted when nothing changed since it was sent. */
    let rev = 0;
    /** The last save failed (or an edit has not been saved yet): the dot is amber and a retry is pending. */
    let unsaved = false;
    let selectedId: string | null = null;
    let defaultCache: Layout | null = null;

    // ---- Geometry: measured on resize only, so no layout is read while a finger is down ----
    let fm = { left: 0, top: 0, w: 0, h: 0 };
    let unit = 0; // pixels per 1% of the field height
    function measure(): void {
      const r = fieldEl.getBoundingClientRect();
      fm = r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, w: r.width, h: r.height } : { left: 0, top: 0, w: window.innerWidth, h: window.innerHeight };
      unit = fm.h / 100;
      if (unit > 0) document.documentElement.style.setProperty('--u', unit.toFixed(4) + 'px');
    }
    const aspect = (): number => (fm.h > 0 ? fm.w / fm.h : 2);

    // ---- Controls on screen ----
    const controls = new Map<string, Control>(); // active layout, by id
    const elems = new Map<string, HTMLElement>();

    const div = (cls: string): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = cls;
      return d;
    };

    function createEl(c: Control): HTMLElement {
      let el: HTMLElement;
      if (c.type === 'button') {
        // Not a <button>: on iOS it holds the haptic switch overlay, and an input inside a button is invalid HTML.
        el = div('');
        el.setAttribute('role', 'button');
        el.setAttribute('aria-pressed', 'false');
      } else if (c.type === 'stick') {
        el = div('ctl ctl-stick');
        el.setAttribute('role', 'group');
        const base = div('stick-base');
        base.appendChild(div('stick-knob'));
        el.appendChild(base);
      } else {
        el = div('ctl ctl-dpad');
        el.setAttribute('role', 'group');
        for (const dir of ['up', 'left', 'right', 'down']) {
          const arm = document.createElement('span');
          arm.className = 'arm arm-' + dir;
          el.appendChild(arm);
        }
      }
      el.dataset['cid'] = c.id;
      el.dataset['type'] = c.type;
      return el;
    }

    function updateEl(el: HTMLElement, c: Control): void {
      const [w, h] = controlBox(c);
      el.style.left = c.x + '%';
      el.style.top = c.y + '%';
      el.style.setProperty('--w', String(w));
      el.style.setProperty('--h', String(h));
      el.style.opacity = String(c.opacity);
      el.setAttribute('aria-label', controlName(c));
      if (c.type === 'button') {
        el.className = 'ctl key ctl-btn shape-' + c.shape; // resets the state classes, re-applied below
        el.classList.toggle('is-down', isOn(c.id));
        el.dataset['button'] = c.button;
        if (el.textContent !== c.label) el.textContent = c.label; // replaces the children, so the overlay is added after
        // Text size follows the button height but shrinks for long labels (units of 1% of the field height).
        el.style.setProperty('--fs', Math.max(2.2, Math.min(c.h * 0.42, (c.w * 1.4) / Math.max(1, c.label.length))).toFixed(2));
      } else if (c.type === 'stick') {
        el.classList.toggle('is-floating', c.mode === 'floating');
      }
      syncOverlay(el, c);
    }

    // ---- iOS haptics: a transparent switch over every button and the d-pad ----
    /**
     * iOS plays its tick for a real finger on a real <input type=checkbox switch> and, since WebKit fc1ef83, for nothing a script
     * does. So the switch lies over the control (a child, so the control's pointer handlers still see the events) and the finger
     * lands on it. It is nearly transparent, not hidden: WebKit must render it. UNVERIFIED on a real iPhone; see ?diag=1.
     */
    const switchLog = { control: { n: 0, text: '' }, test: { n: 0, text: '' } };
    let showDiag: (() => void) | null = null;
    const isSwitch = (t: EventTarget | null): boolean => t instanceof Element && t.classList.contains('haptic-switch');

    function makeSwitch(which: 'control' | 'test'): HTMLInputElement {
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.setAttribute('switch', '');
      sw.className = 'haptic-switch';
      sw.tabIndex = -1;
      sw.setAttribute('aria-hidden', 'true');
      let touchedAt: number | null = null;
      sw.addEventListener(
        'pointerdown',
        () => {
          touchedAt = now();
          sw.checked = false; // reset before the gesture, not inside its click: the tick may still be running after the click event
        },
        on,
      );
      sw.addEventListener(
        'click',
        (e) => {
          e.stopPropagation(); // nothing on the control or the field listens to click, and a tick must not trigger one that does
          const log = switchLog[which];
          log.n += 1;
          log.text = describeSwitchClick(touchedAt, now());
          touchedAt = null;
          showDiag?.();
        },
        on,
      );
      return sw;
    }

    /** Add or remove the overlay of one control: only on iOS, only while playing, only with haptics on, never on sticks. */
    function syncOverlay(el: HTMLElement, c: Control): void {
      const want = hmode === 'ios' && mode === 'play' && c.type !== 'stick' && !!store && activeLayout(store).haptics;
      const have = [...el.children].find((ch) => ch.classList.contains('haptic-switch'));
      if (want && !have) el.appendChild(makeSwitch('control'));
      else if (!want && have) have.remove();
    }

    /** Make the DOM match the active layout without recreating elements (so a drag keeps its pointer capture). */
    function syncField(reset: boolean): void {
      if (reset) {
        for (const el of elems.values()) el.remove();
        elems.clear();
      }
      controls.clear();
      const layout = store ? activeLayout(store) : null;
      const order: HTMLElement[] = [];
      if (layout) {
        for (const c of layout.controls) {
          controls.set(c.id, c);
          let el = elems.get(c.id);
          if (el && el.dataset['type'] !== c.type) {
            el.remove();
            el = undefined;
          }
          if (!el) {
            el = createEl(c);
            elems.set(c.id, el);
            fieldEl.appendChild(el);
          }
          updateEl(el, c);
          order.push(el);
        }
      }
      for (const [id, el] of [...elems]) {
        if (!controls.has(id)) {
          el.remove();
          elems.delete(id);
        }
      }
      if (order.some((el, i) => fieldEl.children[i] !== el)) fieldEl.append(...order); // only when the order really changed
      for (const [id, el] of elems) el.classList.toggle('is-selected', mode === 'edit' && id === selectedId);
    }

    // ---- Haptics wiring (iOS ticks are the overlays above; this is Android's vibrate) ----
    const rawVibrate = (ms: number): void => {
      if (typeof navigator.vibrate === 'function') navigator.vibrate(ms);
    };
    const haptics = createHaptics({
      mode: hmode,
      enabled: () => !!store && activeLayout(store).haptics,
      vibrate: rawVibrate,
      tickMs: () => HAPTIC_MS[hapticLevelOf(storageGet(HAPTIC_KEY))],
      now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });

    // ---- Play input state ----
    const holds = new Map<number, Hold>(); // pointerId -> what that finger holds
    const fingers = new Map<string, number>(); // button control id -> fingers on it
    const pressedAt = new Map<string, number>(); // button control id -> when it went down
    const pendingRelease = new Map<string, ReturnType<typeof setTimeout>>(); // releases waiting out the minimum press time
    const lastTapEnd = new Map<string, number>(); // stick control id -> when its last tap ended
    const latched = new Set<string>(); // toggle buttons that are switched on
    let turboOn = true; // the blink phase of rapid fire
    let turboTimer: ReturnType<typeof setInterval> | null = null;

    const isOn = (cid: string): boolean => (fingers.get(cid) ?? 0) > 0 || pendingRelease.has(cid) || latched.has(cid);
    /** Rapid fire, as the Mode choice shows it: a stored button with both latch and turbo is a plain toggle (see buttonMode). */
    const isRapid = (c: Control | undefined): boolean => !!c && c.type === 'button' && buttonMode(c) === 'rapid';

    /** Ids of the buttons that count as held right now: a finger on them, a release still waiting, or switched on. */
    function* pressedIds(): Generator<string> {
      for (const [cid, n] of fingers) if (n > 0) yield cid;
      for (const cid of pendingRelease.keys()) yield cid;
      for (const cid of latched) yield cid;
    }

    /** Rapid fire blinks the output 50 ms on, 50 ms off, but only while a rapid-fire button is held. */
    function syncTurbo(): void {
      let any = false;
      for (const cid of pressedIds()) if (isRapid(controls.get(cid))) any = true;
      if (any && turboTimer === null) {
        turboOn = true;
        turboTimer = setInterval(() => {
          turboOn = !turboOn;
          requestSend(0);
        }, TURBO_HALF_MS);
      } else if (!any && turboTimer !== null) {
        clearInterval(turboTimer);
        turboTimer = null;
        turboOn = true;
      }
    }

    function paintButton(cid: string): void {
      const el = elems.get(cid);
      if (!el) return;
      const down = isOn(cid);
      el.classList.toggle('is-down', down);
      if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', down ? 'true' : 'false');
    }

    function readPad(): Pad {
      const names: ButtonName[] = [];
      const trigger = { LT: 0, RT: 0 }; // the strongest pressed LT / RT control wins
      for (const cid of pressedIds()) {
        const c = controls.get(cid);
        if (!c || c.type !== 'button' || (!turboOn && isRapid(c))) continue;
        names.push(c.button);
        if (c.button === 'LT' || c.button === 'RT') trigger[c.button] = Math.max(trigger[c.button], c.value);
      }
      let dpad = 0;
      let ls: Readonly<Axes> = ZERO;
      let rs: Readonly<Axes> = ZERO;
      for (const h of holds.values()) {
        if (h.kind === 'stick') {
          if (h.side === 'left') ls = h.ax;
          else rs = h.ax;
          if (h.click) names.push(h.side === 'left' ? 'L3' : 'R3');
        } else if (h.kind === 'dpad') {
          dpad |= h.bits;
        }
      }
      return buildPad(names, dpad, ls, rs, trigger);
    }

    function paintDpad(el: HTMLElement, bits: number): void {
      for (const [dir, bit] of [['up', BTN.UP], ['down', BTN.DOWN], ['left', BTN.LEFT], ['right', BTN.RIGHT]] as const) {
        el.querySelector('.arm-' + dir)?.classList.toggle('is-down', (bits & bit) !== 0);
      }
    }

    function resetStickVisual(el: HTMLElement): void {
      el.classList.remove('is-active');
      const knob = el.querySelector<HTMLElement>('.stick-knob');
      if (knob) knob.style.transform = '';
      const base = el.querySelector<HTMLElement>('.stick-base');
      if (base) base.style.transform = '';
    }

    /** Larger deflection of the sticks held right now. */
    function pushStickHaptics(): void {
      let d = 0;
      for (const h of holds.values()) if (h.kind === 'stick') d = Math.max(d, h.d);
      haptics.setStick(d);
    }

    // ---- Play: pointer handling (state, then send, then paint, then haptics) ----
    function inputEnabled(): boolean {
      return mode === 'play' && layoutState === 'ready' && !portrait && phase !== 'notoken' && !isFinal(phase);
    }

    function playDown(e: PointerEvent): void {
      if (!inputEnabled() || holds.has(e.pointerId)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest<HTMLElement>('[data-cid]');
      const c = el ? controls.get(el.dataset['cid'] ?? '') : undefined;
      if (!el || !c) return;
      // A touch is implicitly captured by the element it lands on. On the haptic switch that must stay so: capturing it to the
      // control would aim the browser's click at the control, and then the switch never toggles and never ticks.
      if (!isSwitch(target)) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is already gone; lostpointercapture cleans up */
        }
      }
      const t = now();

      if (c.type === 'button' && c.latch) {
        // Toggle: tap to hold, tap again to release. No finger is tracked, so the lift changes nothing.
        if (!latched.delete(c.id)) latched.add(c.id);
        requestSend(0);
        paintButton(c.id);
        syncTurbo();
        haptics.tick();
      } else if (c.type === 'button') {
        holds.set(e.pointerId, { kind: 'btn', cid: c.id });
        const n = (fingers.get(c.id) ?? 0) + 1;
        fingers.set(c.id, n);
        const pending = pendingRelease.get(c.id);
        if (pending !== undefined) {
          clearTimeout(pending); // pressed again before the deferred release went out: it simply stays down
          pendingRelease.delete(c.id);
        }
        if (n === 1) {
          pressedAt.set(c.id, t);
          requestSend(0);
          paintButton(c.id);
          syncTurbo();
          haptics.tick();
        }
      } else if (c.type === 'stick') {
        if (zoneBusy((h) => h.kind === 'stick' && h.cid === c.id)) return;
        const click = c.doubleTapClick && isDoubleTap(lastTapEnd.get(c.id) ?? null, t);
        lastTapEnd.delete(c.id);
        const areaX = fm.left + (c.x / 100) * fm.w;
        const areaY = fm.top + (c.y / 100) * fm.h;
        const radius = (c.size * unit) / 2;
        const zone = c.mode === 'floating' ? radius * FLOATING_ZONE : radius;
        const hold: StickHold = {
          kind: 'stick',
          cid: c.id,
          side: c.stick,
          // a floating stick's centre is where the finger landed (kept inside the touch area), a fixed one's the control's
          cx: c.mode === 'floating' ? floatingCentre(e.clientX, areaX, zone, radius) : areaX,
          cy: c.mode === 'floating' ? floatingCentre(e.clientY, areaY, zone, radius) : areaY,
          radius,
          params: { deadzone: c.deadzone, sensitivity: c.sensitivity, curve: c.curve, invertX: c.invertX, invertY: c.invertY },
          downAt: t,
          click,
          ax: ZERO,
          d: 0,
          knob: el.querySelector<HTMLElement>('.stick-knob'),
        };
        holds.set(e.pointerId, hold);
        updateStick(hold, e);
        requestSend(STICK_SEND_MS);
        el.classList.add('is-active');
        if (c.mode === 'floating') {
          const base = el.querySelector<HTMLElement>('.stick-base');
          if (base) base.style.transform = 'translate3d(' + (hold.cx - areaX).toFixed(1) + 'px,' + (hold.cy - areaY).toFixed(1) + 'px,0)';
        }
        paintKnob(hold, e);
        haptics.tick();
        pushStickHaptics();
      } else {
        if (zoneBusy((h) => h.kind === 'dpad' && h.cid === c.id)) return;
        const hold: DpadHold = {
          kind: 'dpad',
          cid: c.id,
          cx: fm.left + (c.x / 100) * fm.w,
          cy: fm.top + (c.y / 100) * fm.h,
          half: (c.size * unit) / 2,
          diagonals: c.diagonals,
          bits: 0,
          el,
        };
        holds.set(e.pointerId, hold);
        moveDpad(hold, e);
      }
    }

    function zoneBusy(match: (h: Hold) => boolean): boolean {
      for (const h of holds.values()) if (match(h)) return true;
      return false;
    }

    function updateStick(h: StickHold, e: PointerEvent): void {
      const dx = e.clientX - h.cx;
      const dy = e.clientY - h.cy;
      h.ax = stickAxes(dx, dy, h.radius, h.params);
      h.d = deflection(dx, dy, h.radius);
    }

    function paintKnob(h: StickHold, e: PointerEvent): void {
      if (!h.knob) return;
      const k = limitToRadius(e.clientX - h.cx, e.clientY - h.cy, h.radius);
      h.knob.style.transform = 'translate3d(' + k.x.toFixed(1) + 'px,' + k.y.toFixed(1) + 'px,0)';
    }

    function moveDpad(h: DpadHold, e: PointerEvent): void {
      const next = dpadMask(e.clientX - h.cx, e.clientY - h.cy, h.half, h.diagonals);
      if (next === h.bits) return;
      const added = (next & ~h.bits) !== 0;
      h.bits = next;
      requestSend(0);
      paintDpad(h.el, next);
      if (added) haptics.tick();
    }

    function playMove(e: PointerEvent): void {
      const h = holds.get(e.pointerId);
      if (!h || h.kind === 'btn') return;
      if (h.kind === 'stick') {
        updateStick(h, e);
        requestSend(STICK_SEND_MS);
        paintKnob(h, e);
        pushStickHaptics();
      } else {
        moveDpad(h, e);
      }
    }

    function finishButtonRelease(cid: string): void {
      pendingRelease.delete(cid);
      pressedAt.delete(cid);
      requestSend(0);
      paintButton(cid);
      syncTurbo();
    }

    function endHold(h: Hold): void {
      if (h.kind === 'btn') {
        const n = (fingers.get(h.cid) ?? 0) - 1;
        if (n > 0) {
          fingers.set(h.cid, n);
          return;
        }
        fingers.delete(h.cid);
        const wait = releaseDelay(pressedAt.get(h.cid) ?? 0, now());
        if (wait > 0) {
          // Down for less than the minimum press: keep it down for the remainder, then release.
          pendingRelease.set(
            h.cid,
            setTimeout(() => finishButtonRelease(h.cid), wait),
          );
        } else {
          pressedAt.delete(h.cid);
          requestSend(0);
          paintButton(h.cid);
          syncTurbo();
        }
      } else if (h.kind === 'stick') {
        const el = elems.get(h.cid);
        if (el) resetStickVisual(el);
        const t = now();
        if (!h.click && t - h.downAt <= DOUBLE_TAP_MS) lastTapEnd.set(h.cid, t);
        requestSend(0);
        pushStickHaptics();
      } else {
        requestSend(0);
        paintDpad(h.el, 0);
      }
    }

    function playEnd(e: PointerEvent): void {
      const h = holds.get(e.pointerId);
      if (!h) return;
      holds.delete(e.pointerId);
      endHold(h);
    }

    /** Release every control. Does not send anything by itself. */
    function releaseAll(): void {
      holds.clear();
      fingers.clear();
      pressedAt.clear();
      for (const t of pendingRelease.values()) clearTimeout(t);
      pendingRelease.clear();
      lastTapEnd.clear();
      latched.clear();
      syncTurbo();
      haptics.stop();
      for (const el of fieldEl.querySelectorAll('.is-down')) {
        el.classList.remove('is-down');
        if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', 'false');
      }
      for (const el of fieldEl.querySelectorAll<HTMLElement>('.ctl-stick')) resetStickVisual(el);
    }

    /** Safety release: drop everything and tell the host right now. */
    function neutralise(): void {
      releaseAll();
      flushNow();
    }

    // ---- Sending ----
    let ws: WebSocket | null = null;
    let welcomed = false;
    let lastSent: Pad | null = null;
    let lastSendAt = -1e9;
    let sendTimer: ReturnType<typeof setTimeout> | null = null;
    let sendTimerDue = 0;
    let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

    function canSend(): boolean {
      return ws !== null && ws.readyState === WS_OPEN && welcomed;
    }

    let lastFrameAt = 0; // any frame, keepalives included
    const KEEPALIVE_FRAME = JSON.stringify({ t: 'k' });

    function sendRaw(text: string): boolean {
      if (!ws) return false;
      try {
        ws.send(text);
      } catch {
        return false;
      }
      lastFrameAt = now();
      armKeepalive();
      return true;
    }

    /**
     * A keepalive is due 500 ms after the last frame of any kind, and then every 500 ms of silence. ONE timer: a frame sent while it
     * is pending only moves lastFrameAt, and the timer re-arms itself for the remainder (no clear/set per stick frame).
     */
    function armKeepalive(): void {
      if (keepaliveTimer !== null) return;
      keepaliveTimer = setTimeout(onKeepalive, KEEPALIVE_MS);
    }
    function onKeepalive(): void {
      keepaliveTimer = null;
      if (!canSend()) return;
      const wait = lastFrameAt + KEEPALIVE_MS - now();
      if (wait > 1) {
        keepaliveTimer = setTimeout(onKeepalive, wait);
        return;
      }
      sendRaw(KEEPALIVE_FRAME);
    }

    function stopKeepalive(): void {
      if (keepaliveTimer !== null) clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }

    /** Send the current state if it differs from what the host has. Only the newest sample matters: every frame is the full state. */
    function sendIfChanged(): void {
      if (!canSend()) return;
      const pad = readPad();
      if (samePad(lastSent, pad)) return;
      if (sendRaw('{"t":"s","b":' + pad.b + ',"lt":' + pad.lt + ',"rt":' + pad.rt + ',"lx":' + pad.lx + ',"ly":' + pad.ly + ',"rx":' + pad.rx + ',"ry":' + pad.ry + '}')) {
        lastSent = pad;
        lastSendAt = lastFrameAt;
        // This frame carries the newest state, so a trailing send armed earlier is now redundant: without this it fired right after
        // and doubled the stick rate (measured 172 frames/s instead of <= 125).
        if (sendTimer !== null) {
          clearTimeout(sendTimer);
          sendTimer = null;
        }
      }
    }

    /**
     * Send from inside the event handler when the gap since the last frame allows it (`minGap` 0 for button edges, 8 ms for sticks,
     * never closer than 1/240 s); otherwise one timer sends the latest state at the earliest allowed time.
     */
    function requestSend(minGap: number): void {
      const t = now();
      const due = lastSendAt + Math.max(minGap, HARD_SEND_GAP_MS);
      if (t >= due) return sendIfChanged();
      if (sendTimer !== null && sendTimerDue <= due) return;
      if (sendTimer !== null) clearTimeout(sendTimer);
      sendTimerDue = due;
      sendTimer = setTimeout(() => {
        sendTimer = null;
        sendIfChanged();
      }, Math.max(0, Math.ceil(due - t)));
    }

    /** Send right now, whatever the gap (safety release, welcome). */
    function flushNow(): void {
      sendIfChanged();
    }

    // ---- Connection ----
    const number = (() => {
      const stored = Number.parseInt(storageGet(NAME_KEY) ?? '', 10);
      if (Number.isInteger(stored) && stored >= 10 && stored <= 99) return stored;
      const fresh = 10 + Math.floor(Math.random() * 90);
      storageSet(NAME_KEY, String(fresh));
      return fresh;
    })();
    const name = playerName(ua, navigator.maxTouchPoints ?? 0, number);
    /** Random, kept on the phone: the host gives this phone its slot and layouts back after a reconnect. Without storage it lasts until the page is reloaded. */
    const phoneId = (() => {
      const stored = storageGet(ID_KEY);
      if (isPhoneId(stored)) return stored;
      const bytes = new Uint8Array(ID_CHARS);
      try {
        crypto.getRandomValues(bytes);
      } catch {
        for (let i = 0; i < ID_CHARS; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      const fresh = newPhoneId(bytes);
      storageSet(ID_KEY, fresh);
      return fresh;
    })();
    const helloFrame = JSON.stringify({ t: 'hello', name, id: phoneId });
    let attempt = 0;
    let everDropped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // ---- Link health: a probe every second, the round trip, and the dead-link rule ----
    let pingN = 0;
    const pingSentAt = new Map<number, number>(); // probes sent and not echoed yet
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let deadTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let rtts: number[] = [];
    let rtt: number | null = null;
    let slow = false;
    /** The "Link: 6 ms" text of the open settings card; null while the card is not showing it. */
    let linkEl: HTMLElement | null = null;
    const paintLink = (): void => {
      if (linkEl?.isConnected) linkEl.textContent = linkText(rtt);
    };

    function stopPing(): void {
      if (pingTimer !== null) clearInterval(pingTimer);
      if (deadTimer !== null) clearTimeout(deadTimer);
      pingTimer = null;
      deadTimer = null;
      pingSentAt.clear();
      rtts = [];
      rtt = null;
      slow = false;
      paintLink();
    }

    /** Arm the dead-link timer for the oldest probe that has not been echoed. */
    function armDead(sock: WebSocket): void {
      if (deadTimer !== null) clearTimeout(deadTimer);
      deadTimer = null;
      let oldest = Infinity;
      for (const at of pingSentAt.values()) oldest = Math.min(oldest, at);
      if (oldest === Infinity) return;
      deadTimer = setTimeout(() => {
        deadTimer = null;
        lost(sock, true);
      }, Math.max(0, oldest + PING_DEAD_MS - now()));
    }

    function sendPing(sock: WebSocket): void {
      if (sock !== ws || !welcomed || sock.readyState !== WS_OPEN) return;
      pingN += 1;
      try {
        sock.send('{"t":"p","n":' + pingN + '}');
      } catch {
        return; // the close event follows
      }
      pingSentAt.set(pingN, now());
      if (deadTimer === null) armDead(sock);
    }

    function onPong(sock: WebSocket, n: number): void {
      const sentAt = pingSentAt.get(n);
      if (sentAt === undefined) return;
      for (const k of pingSentAt.keys()) if (k <= n) pingSentAt.delete(k); // the link is ordered: everything before n arrived too
      armDead(sock);
      rtts.push(Math.max(0, now() - sentAt));
      if (rtts.length > RTT_SAMPLES) rtts.shift();
      rtt = medianRtt(rtts);
      paintLink();
      const nowSlow = rtt !== null && rtt > RTT_WARN_MS;
      if (nowSlow !== slow) {
        slow = nowSlow;
        render();
      }
    }

    /** green: playing; amber: connecting, retrying, or the last save has not reached the host; red: blocked. */
    function dotState(): string {
      if (phase === 'connected' && (unsaved || slow)) return 'retrying';
      return phase;
    }

    function render(): void {
      const text = statusText(phase, slot);
      menu.dataset['state'] = dotState();
      menuSlot.textContent = slot === null ? 'P?' : 'P' + slot;
      menu.setAttribute('aria-label', 'Menu, ' + text);
      const blocked = phase === 'notoken' || isFinal(phase);
      const layoutFailed = !blocked && layoutState === 'failed';
      noticeEl.hidden = !(blocked || layoutFailed);
      noticeText.textContent = blocked ? text : layoutFailed ? 'Cannot load your layout' : '';
      retryBtn.hidden = !(phase === 'full' || phase === 'replaced' || layoutFailed);
      retryBtn.textContent = phase === 'replaced' ? 'Reconnect' : 'Try again';
      menu.hidden = blocked || mode === 'edit';
      done.hidden = mode !== 'edit';
    }

    function setPhase(next: Phase): void {
      phase = next;
      render();
    }

    function connect(): void {
      if (destroyed || !token || isFinal(phase)) return;
      setPhase(everDropped ? 'retrying' : 'connecting');
      let sock: WebSocket;
      try {
        sock = new WebSocket(wsUrl(location, token));
      } catch {
        everDropped = true;
        scheduleReconnect();
        setPhase('retrying');
        return;
      }
      ws = sock;
      welcomed = false;
      if (connectTimer !== null) clearTimeout(connectTimer);
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (!welcomed) lost(sock, false); // never opened, or opened and never answered: do not wait for the browser's own timeout
      }, CONNECT_MS);
      sock.onopen = () => {
        if (sock !== ws) return;
        try {
          sock.send(helloFrame);
        } catch {
          /* the close event follows */
        }
      };
      sock.onmessage = (ev: MessageEvent) => {
        if (sock !== ws) return;
        const msg = parseServerMessage(ev.data);
        if (!msg) return;
        if (msg.t === 'p') {
          if (welcomed) onPong(sock, msg.n);
        } else if (msg.t === 'welcome') {
          welcomed = true;
          slot = msg.slot;
          attempt = 0;
          everDropped = false;
          lastSent = null;
          if (connectTimer !== null) clearTimeout(connectTimer);
          connectTimer = null;
          stopPing();
          pingTimer = setInterval(() => sendPing(sock), PING_MS);
          sendPing(sock);
          setPhase('connected');
          showSlot(msg.slot);
          flushNow();
          offerSheet();
          retrySave(); // the layout did not reach the host last time: try again now that we are back (not while editing)
        } else {
          // 'full' and 'kicked' are final: no reconnect until the user asks (full) or the host re-adds the phone. ('replaced' arrives as a close reason.)
          releaseAll();
          setPhase(msg.t);
          sock.close();
        }
      };
      // Another page of this phone (a second tab) said hello with the same phone id and the host closed this socket: final, because
      // reconnecting would take the slot back and the two pages would trade it forever. Only the user's Reconnect continues.
      sock.onclose = (ev: CloseEvent) => {
        if (sock === ws && ev && ev.reason === REPLACED_REASON) lost(sock, false, 'replaced');
        else lost(sock, false);
      };
      // onerror needs no handling: a failed socket always fires close next.
    }

    /**
     * The socket is gone, or must be treated as gone (no echo, no welcome): detach it first, so its own close event is ignored, then
     * close it and come back. `atOnce` skips the backoff: a link that was healthy a moment ago is retried immediately.
     */
    function lost(sock: WebSocket, atOnce: boolean, final?: Phase): void {
      if (sock !== ws) return;
      ws = null;
      welcomed = false;
      slot = null;
      lastSent = null;
      stopKeepalive();
      stopPing();
      if (connectTimer !== null) clearTimeout(connectTimer);
      connectTimer = null;
      releaseAll();
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      if (final) {
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        setPhase(final);
        return;
      }
      if (isFinal(phase)) return;
      everDropped = true;
      setPhase('retrying');
      if (atOnce) {
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        attempt = 0;
        connect();
      } else {
        scheduleReconnect();
      }
    }

    function scheduleReconnect(): void {
      if (destroyed || reconnectTimer !== null) return;
      const delay = backoffDelay(attempt);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    /**
     * Come back to the foreground (or the network returned): do not wait out the backoff. When the network has just returned, an
     * attempt still in flight started while it was down, so it is replaced; coming back to the foreground leaves it alone.
     */
    function reconnectNow(networkBack = false): void {
      if (destroyed || !token || isFinal(phase) || welcomed) return;
      if (ws && ws.readyState === 0) {
        if (!networkBack) return; // an attempt is already in flight
        lost(ws, true);
        return;
      }
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      attempt = 0;
      connect();
    }

    // ---- Host API (layouts) ----
    async function api(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<ApiResult> {
      if (!token) return { ok: false, status: 0, body: null };
      try {
        const init: RequestInit = { method, cache: 'no-store', credentials: 'omit' };
        if (body !== undefined) {
          init.headers = { 'Content-Type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        const res = await fetch(path + '?t=' + encodeURIComponent(token) + '&id=' + encodeURIComponent(phoneId), init); // the host files layouts under the phone id
        let parsed: unknown = null;
        try {
          parsed = await res.json();
        } catch {
          /* an error page is not JSON */
        }
        return { ok: res.ok, status: res.status, body: parsed };
      } catch {
        return { ok: false, status: 0, body: null };
      }
    }

    async function loadLayouts(): Promise<void> {
      layoutState = 'loading';
      render();
      const r = await api('GET', '/api/layouts');
      if (destroyed) return;
      const s = r.ok ? coerceStore(r.body) : null;
      if (!s) {
        layoutState = 'failed';
        render();
        return;
      }
      store = s;
      layoutState = 'ready';
      measure();
      syncField(true);
      render();
    }

    /** The host's stock layout, fetched once. Null when the request fails. */
    async function getDefaultLayout(): Promise<Layout | null> {
      if (defaultCache) return defaultCache;
      const r = await api('GET', '/api/default-layout');
      if (destroyed || !r.ok) return null;
      const s = coerceStore({ layouts: [r.body] });
      defaultCache = s ? activeLayout(s) : null;
      return defaultCache;
    }

    // ---- Saving: one PUT per Done; a failed one is retried every 5 s and on reconnect ----
    let saving = false;
    let saveAgain = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    /** A retry (timer or reconnect) only while playing: in edit mode the store is a draft, and Done saves it. */
    function retrySave(): void {
      if (mode === 'play' && unsaved) void save();
    }

    async function save(): Promise<void> {
      if (!store || destroyed) return;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      if (saving) {
        saveAgain = true;
        return;
      }
      saving = true;
      const sentRev = rev;
      const r = await api('PUT', '/api/layouts', store);
      saving = false;
      if (destroyed) return;
      if (r.ok) {
        const s = coerceStore(r.body);
        // The host's sanitized store is the truth, unless the user kept editing while it was in flight.
        if (s && rev === sentRev && mode === 'play') {
          const changedActive = store !== null && s.activeId !== store.activeId;
          store = s;
          syncField(changedActive);
        }
        unsaved = rev !== sentRev;
      } else {
        unsaved = true;
      }
      render();
      if (saveAgain) {
        saveAgain = false;
        void save();
      } else if (unsaved && mode === 'play') {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          retrySave();
        }, SAVE_RETRY_MS);
      }
    }

    // ---- Chrome buttons: one tap helper ----
    /**
     * Fire `fn` on pointerup when the finger is released within the element plus a 12 pt slop. The pointer is captured on
     * pointerdown, so a slightly rolling finger still ends on the element. Synthesised clicks are NOT relied upon (a touch click has
     * detail > 0 and is ignored, so nothing fires twice); a click with detail 0 is the keyboard / assistive-technology path.
     */
    function tap(el: HTMLElement, fn: () => void, scoped = true): void {
      let active: number | null = null;
      const opts = scoped ? on : undefined;
      el.addEventListener(
        'pointerdown',
        (e) => {
          active = e.pointerId;
          try {
            el.setPointerCapture(e.pointerId);
          } catch {
            /* synthetic pointer */
          }
        },
        opts,
      );
      el.addEventListener(
        'pointerup',
        (e) => {
          if (active !== e.pointerId) return;
          active = null;
          const r = el.getBoundingClientRect();
          const noLayout = r.width === 0 && r.height === 0;
          if (noLayout || (e.clientX >= r.left - TAP_SLOP && e.clientX <= r.right + TAP_SLOP && e.clientY >= r.top - TAP_SLOP && e.clientY <= r.bottom + TAP_SLOP)) fn();
        },
        opts,
      );
      el.addEventListener(
        'pointercancel',
        () => {
          active = null;
        },
        opts,
      );
      el.addEventListener(
        'click',
        (e) => {
          if (e.detail === 0) fn();
        },
        opts,
      );
    }

    // ---- Edit mode ----
    let drag: EditDrag | null = null;

    function enterEdit(): void {
      if (mode === 'edit' || layoutState !== 'ready' || !store || phase === 'notoken' || isFinal(phase)) return;
      neutralise(); // the pad stays neutral while editing: only keepalives go out
      mode = 'edit';
      document.body.classList.add('editing');
      fieldEl.classList.add('is-editing');
      selectedId = null;
      syncField(false);
      render();
      showCard();
    }

    function exitEdit(): void {
      if (mode !== 'edit') return;
      mode = 'play';
      drag = null;
      document.body.classList.remove('editing');
      fieldEl.classList.remove('is-editing');
      selectedId = null;
      disarmConfirm();
      card.hidden = true;
      card.textContent = '';
      syncField(false);
      render();
    }

    /** Done: back to play at once, and ONE save. A failed save keeps the draft and retries. */
    function finishEdit(): void {
      if (mode !== 'edit') return;
      exitEdit();
      unsaved = true;
      render();
      void save();
    }

    /** Replace the store with an edited one (edit mode only; nothing is sent until Done). */
    function edit(next: LayoutStore): void {
      if (!store || next === store) return;
      const layoutChanged = next.activeId !== store.activeId;
      store = next;
      rev += 1;
      unsaved = true;
      if (layoutChanged) selectedId = null;
      syncField(layoutChanged);
    }

    function select(id: string | null): void {
      selectedId = id;
      for (const [cid, el] of elems) el.classList.toggle('is-selected', cid === id);
    }

    function editDown(e: PointerEvent): void {
      if (drag) return;
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest<HTMLElement>('[data-cid]');
      const c = el ? controls.get(el.dataset['cid'] ?? '') : undefined;
      if (!el || !c) {
        select(null);
        showCard();
        return;
      }
      select(c.id);
      card.hidden = true; // the card comes back when the finger lifts
      const px = ((e.clientX - fm.left) / fm.w) * 100;
      const py = ((e.clientY - fm.top) / fm.h) * 100;
      drag = { pointerId: e.pointerId, id: c.id, ox: c.x - px, oy: c.y - py };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* see playDown */
      }
    }

    function editMove(e: PointerEvent): void {
      if (!store || !drag || drag.pointerId !== e.pointerId) return;
      const px = ((e.clientX - fm.left) / fm.w) * 100;
      const py = ((e.clientY - fm.top) / fm.h) * 100;
      edit(moveControl(store, drag.id, px + drag.ox, py + drag.oy, aspect()));
    }

    function editEnd(e: PointerEvent): void {
      if (!drag || drag.pointerId !== e.pointerId) return;
      drag = null;
      showCard();
    }

    // ---- The card (the only editor surface): Size, Opacity and More for a selected control; the settings when nothing is ----
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    };

    /**
     * A slider driven by pointer events (native range inputs are fiddly on iOS): a 44 pt thumb on a 44 pt tall track, tap on the track
     * jumps there, drag follows the finger, arrow keys step. `onInput` runs on every change.
     */
    function makeSlider(o: { label: string; min: number; max: number; step: number; value: number; fmt: (v: number) => string; onInput: (v: number) => void }): HTMLElement {
      const root = el('div', 'slider');
      const label = el('span', 'slider-label', o.label);
      const out = el('span', 'slider-value');
      const track = el('div', 'slider-track');
      track.tabIndex = 0;
      track.setAttribute('role', 'slider');
      track.setAttribute('aria-label', o.label);
      track.setAttribute('aria-valuemin', String(o.min));
      track.setAttribute('aria-valuemax', String(o.max));
      track.appendChild(el('div', 'slider-fill'));
      track.appendChild(el('div', 'slider-thumb'));
      root.append(label, track, out);
      let value = clampTo(o.value, o.min, o.max);
      const paint = (): void => {
        const ratio = o.max > o.min ? (value - o.min) / (o.max - o.min) : 0;
        track.style.setProperty('--p', ratio.toFixed(4));
        track.setAttribute('aria-valuenow', String(value));
        out.textContent = o.fmt(value);
      };
      const set = (v: number): void => {
        const snapped = round(clampTo(Math.round((v - o.min) / o.step) * o.step + o.min, o.min, o.max), 3);
        if (snapped === value) return;
        value = snapped;
        paint();
        o.onInput(value);
      };
      // The track is measured once per drag: every step restyles the control, so a read per move would force a layout each time.
      let r = { left: 0, width: 0 };
      const fromX = (x: number): void => {
        if (r.width > 0) set(o.min + clampTo((x - r.left) / r.width, 0, 1) * (o.max - o.min));
      };
      let active: number | null = null;
      track.addEventListener('pointerdown', (e) => {
        active = e.pointerId;
        const b = track.getBoundingClientRect();
        r = { left: b.left, width: b.width };
        try {
          track.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
        fromX(e.clientX);
      });
      track.addEventListener('pointermove', (e) => {
        if (active === e.pointerId) fromX(e.clientX);
      });
      for (const type of ['pointerup', 'pointercancel'] as const) {
        track.addEventListener(type, (e) => {
          if (active === e.pointerId) active = null;
        });
      }
      track.addEventListener('keydown', (e) => {
        const k = e.key;
        if (k === 'ArrowLeft' || k === 'ArrowDown') set(value - o.step);
        else if (k === 'ArrowRight' || k === 'ArrowUp') set(value + o.step);
        else if (k === 'Home') set(o.min);
        else if (k === 'End') set(o.max);
        else return;
        e.preventDefault();
      });
      paint();
      return root;
    }

    /** Heights (px) of the rows in the card being built: its own height is worked out from them, never measured (see cardHeight). */
    let rows: number[] = [];
    const addRow = (node: HTMLElement, px = ROW_H): void => {
      card.appendChild(node);
      rows.push(px);
    };
    /** Whether the "More" panel is open on the control card. It stays as the player left it until the page is reloaded. */
    let moreOpen = false;
    /** Whether the settings card shows its Device rows (stay awake, full screen, home screen). */
    let deviceOpen = false;
    let wakeEl: HTMLElement | null = null;

    function placeCardNow(): void {
      const c = selectedId ? controls.get(selectedId) : undefined;
      const field = { w: fm.w, h: fm.h };
      // Keep the card's top edge below Done (edit mode only, so this layout read never happens while playing).
      const d = done.getBoundingClientRect();
      const top = Math.max(8, d.height > 0 ? d.bottom - fm.top + 6 : 8);
      // A card taller than the room under Done scrolls instead of growing over the screen.
      const size = { w: Math.min(c ? (moreOpen ? CARD_W.more : CARD_W.control) : CARD_W.settings, Math.max(ROW_H, field.w - 16)), h: cardHeight(rows, field.h - top - 8) };
      card.style.width = size.w + 'px';
      card.style.height = size.h + 'px';
      const boxOf = (x: Control): Box => {
        const [bw, bh] = controlBox(x);
        return { cx: (x.x / 100) * field.w, cy: (x.y / 100) * field.h, hw: (bw * unit) / 2, hh: (bh * unit) / 2 };
      };
      let p: { x: number; y: number };
      if (c) {
        // Placed for the LARGEST size the Size slider can reach, so growing the control never slides it under the card.
        const [bw, bh] = reachBox(c);
        p = placeCard({ cx: (c.x / 100) * field.w, cy: (c.y / 100) * field.h, hw: (bw * unit) / 2, hh: (bh * unit) / 2 }, size, field, 8, top);
      } else {
        p = placeSettingsCard([...controls.values()].map(boxOf), size, field, top);
      }
      card.style.left = fm.left + p.x + 'px';
      card.style.top = fm.top + p.y + 'px';
    }

    function showCard(): void {
      if (mode !== 'edit' || !store) return;
      const scrolled = card.scrollTop; // a rebuild after a tap in the More panel must not jump back to the top
      disarmConfirm(); // a fresh card shows "Reset" and "Delete": the first tap on it only arms it
      card.textContent = '';
      rows = [];
      const c = selectedId ? controls.get(selectedId) : undefined;
      if (c) buildControlCard(c);
      else buildSettingsCard();
      card.appendChild(el('p', 'card-msg'));
      card.classList.toggle('is-settings', !c);
      card.hidden = false;
      placeCardNow();
      card.scrollTop = scrolled;
    }

    /** Write properties of one control through the same edit() path as Size and Opacity; `rebuild` redraws the card (choices do, sliders must not). */
    function put(id: string, patch: Readonly<Record<string, unknown>>, rebuild: boolean): void {
      if (store) edit(setProps(store, id, patch, aspect()));
      if (rebuild) showCard();
    }

    /** A labelled On/Off switch row. `value` is read again after every tap, so the row repaints from the store, not from itself. */
    function makeToggle(label: string, value: () => boolean, flip: () => void): HTMLElement {
      const row = el('div', 'card-row');
      row.appendChild(el('span', 'card-label', label));
      const sw = el('button', 'switch');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', label);
      const paint = (): void => {
        const on2 = value();
        sw.setAttribute('aria-checked', on2 ? 'true' : 'false');
        sw.textContent = on2 ? 'On' : 'Off';
      };
      paint();
      tap(
        sw,
        () => {
          flip();
          paint();
        },
        false,
      );
      row.appendChild(sw);
      return row;
    }

    /** One of several exclusive choices ("segmented control"); a tap on another one calls `pick`. `grid` wraps long lists under their label. */
    function makeChoice<T extends string>(label: string, options: ReadonlyArray<readonly [T, string]>, current: T, pick: (v: T) => void, grid = false): HTMLElement {
      const row = el('div', grid ? 'choice is-grid' : 'choice');
      row.setAttribute('role', 'radiogroup');
      row.setAttribute('aria-label', label);
      row.appendChild(el('span', 'card-label', label));
      const opts = el('div', 'opts');
      for (const [value, text] of options) {
        const b = el('button', 'card-btn opt', text);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', value === current ? 'true' : 'false');
        tap(b, () => pick(value), false);
        opts.appendChild(b);
      }
      row.appendChild(opts);
      return row;
    }

    /** A short text field (the button label). 16 px text so iOS does not zoom the page when it takes focus. */
    function makeText(label: string, value: string, max: number, onInput: (v: string) => void): HTMLElement {
      const row = el('label', 'card-row');
      row.appendChild(el('span', 'card-label', label));
      const input = el('input', 'card-input');
      input.type = 'text';
      input.value = value;
      input.maxLength = max;
      input.spellcheck = false;
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('enterkeyhint', 'done');
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => onInput(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
      row.appendChild(input);
      return row;
    }

    function buildControlCard(c: Control): void {
      const id = c.id;
      const ratio = c.type === 'button' && c.h > 0 ? c.w / c.h : 1; // kept for the whole drag of the slider, so rounding cannot drift
      const head = el('div', 'card-row card-head');
      head.appendChild(el('h2', 'card-title', controlName(c)));
      const more = el('button', 'card-btn more', moreOpen ? 'Less' : 'More');
      more.type = 'button';
      more.setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
      tap(
        more,
        () => {
          moreOpen = !moreOpen;
          showCard();
        },
        false,
      );
      head.appendChild(more);
      addRow(head);
      const sr = sizeRange(c);
      addRow(
        makeSlider({
          label: 'Size',
          min: sr.min,
          max: sr.max,
          step: 1,
          value: sizeOf(c),
          fmt: (v) => String(Math.round(v)),
          onInput: (v) => {
            if (store) edit(setSize(store, id, v, ratio, aspect()));
          },
        }),
      );
      const or = opacityRange(c);
      addRow(
        makeSlider({
          label: 'Opacity',
          min: or.min,
          max: or.max,
          step: 0.05,
          value: c.opacity,
          fmt: (v) => Math.round(v * 100) + '%',
          onInput: (v) => {
            if (store) edit(setOpacity(store, id, v));
          },
        }),
      );
      if (moreOpen) buildMore(c);
    }

    /** Everything else a control stores, one tap away and out of the way of the simple card. */
    function buildMore(c: Control): void {
      const id = c.id;
      const flag = (key: string) => (): boolean => (controls.get(id) as unknown as Record<string, unknown> | undefined)?.[key] === true;
      const toggle = (label: string, key: string): void => addRow(makeToggle(label, flag(key), () => put(id, { [key]: !flag(key)() }, false)));
      const slide = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, key: string, scale = 1): void =>
        addRow(makeSlider({ label, min, max, step, value, fmt, onInput: (v) => put(id, { [key]: round(v * scale, 3) }, false) }));
      if (c.type === 'button') {
        addRow(makeText('Label', c.label, LIMITS.labelChars, (v) => put(id, { label: v }, false)));
        addRow(
          makeChoice('Sends', BUTTON_NAMES.map((n) => [n, BUTTON_LOOK[n].label] as const), c.button, (v) => put(id, { button: v }, true), true),
          gridHeight(BUTTON_NAMES.length),
        );
        addRow(makeChoice('Shape', [['circle', 'Circle'], ['rect', 'Rect'], ['pill', 'Pill']] as const, c.shape, (v) => put(id, { shape: v }, true)));
        if (c.shape !== 'circle') {
          const wr = dimRange(c.w);
          const hr = dimRange(c.h);
          slide('Width', wr.min, wr.max, 1, c.w, (v) => String(Math.round(v)), 'w');
          slide('Height', hr.min, hr.max, 1, c.h, (v) => String(Math.round(v)), 'h');
        }
        addRow(makeChoice('Mode', [['hold', 'Hold'], ['toggle', 'Toggle'], ['rapid', 'Rapid']] as const, buttonMode(c), (v) => put(id, modePatch(v), true)));
        if (c.button === 'LT' || c.button === 'RT') {
          slide('Trigger', 5, 100, 5, clampTo(Math.round((c.value / 255) * 20) * 5, 5, 100), (v) => Math.round(v) + '%', 'value', 2.55);
        }
      } else if (c.type === 'stick') {
        addRow(makeChoice('Stick', [['left', 'Left'], ['right', 'Right']] as const, c.stick, (v) => put(id, { stick: v }, true)));
        addRow(makeChoice('Mode', [['fixed', 'Fixed'], ['floating', 'Floating']] as const, c.mode, (v) => put(id, { mode: v }, true)));
        slide('Dead zone', DEADZONE_RANGE.min * 100, DEADZONE_RANGE.max * 100, 1, round(c.deadzone * 100, 0), (v) => Math.round(v) + '%', 'deadzone', 0.01);
        const sr = { min: Math.min(SENSITIVITY_RANGE.min, c.sensitivity), max: Math.max(SENSITIVITY_RANGE.max, c.sensitivity) };
        slide('Sensitivity', sr.min, sr.max, 0.1, c.sensitivity, (v) => v.toFixed(1), 'sensitivity');
        addRow(makeChoice('Curve', [['linear', 'Linear'], ['precise', 'Precise'], ['aggressive', 'Sharp']] as const, c.curve, (v) => put(id, { curve: v }, true)));
        toggle('Invert X', 'invertX');
        toggle('Invert Y', 'invertY');
        toggle('Double-tap = click', 'doubleTapClick');
      } else {
        toggle('Diagonals', 'diagonals');
      }
      const actions = el('div', 'card-row');
      const dup = el('button', 'card-btn grow', 'Duplicate');
      dup.type = 'button';
      tap(dup, () => addAndSelect(store ? duplicateControl(store, id, aspect()) : null), false);
      const del = el('button', 'card-btn grow', 'Delete');
      del.type = 'button';
      confirmButton(del, 'Delete', CONFIRM_MS, () => {
        if (!store) return;
        edit(deleteControl(store, id));
        select(null);
        showCard();
      });
      actions.append(dup, del);
      addRow(actions);
    }

    /** Make a freshly added or duplicated control the selected one (null: the layout is full). */
    function addAndSelect(r: { store: LayoutStore; id: string } | null): void {
      if (!r) return say('Layout is full');
      edit(r.store);
      select(r.id);
      showCard();
    }

    let confirmTimer: ReturnType<typeof setTimeout> | null = null;
    function disarmConfirm(): void {
      if (confirmTimer !== null) clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    /** A button that needs a second tap within `ms` to run `action` (Reset, Delete): the first tap only arms it. */
    function confirmButton(btn: HTMLElement, idle: string, ms: number, action: () => void): void {
      tap(
        btn,
        () => {
          if (confirmTimer === null) {
            btn.textContent = 'Tap again';
            confirmTimer = setTimeout(() => {
              confirmTimer = null;
              btn.textContent = idle;
            }, ms);
            return;
          }
          disarmConfirm();
          btn.textContent = idle;
          action();
        },
        false,
      );
    }

    async function pickSlot(i: number): Promise<void> {
      if (!store) return;
      const existing = store.layouts[i];
      if (existing) {
        edit(switchLayout(store, existing.id));
        select(null);
        showCard();
        return;
      }
      const def = await getDefaultLayout();
      if (destroyed || !store || mode !== 'edit') return;
      if (!def) return say('Cannot load the default layout');
      let next = store;
      while (next.layouts.length <= i && next.layouts.length < LIMITS.layouts) next = addSlot(next, def);
      edit(next);
      select(null);
      showCard();
    }

    function say(msg: string): void {
      const p = card.querySelector('.card-msg');
      if (p) p.textContent = msg;
    }

    function buildSettingsCard(): void {
      if (!store) return;
      const s = store;
      const layout = activeLayout(s);
      const row1 = el('div', 'card-row');
      const slots = el('div', 'slots');
      slots.setAttribute('role', 'group');
      slots.setAttribute('aria-label', 'Layout slot');
      const activeIndex = Math.max(0, s.layouts.findIndex((l) => l.id === s.activeId));
      for (let i = 0; i < SLOTS; i++) {
        const b = el('button', 'card-btn slot' + (s.layouts[i] ? '' : ' is-empty'), String(i + 1));
        b.type = 'button';
        b.setAttribute('aria-pressed', i === activeIndex ? 'true' : 'false');
        b.setAttribute('aria-label', 'Layout ' + (i + 1) + (s.layouts[i] ? '' : ' (empty)'));
        tap(b, () => void pickSlot(i), false);
        slots.appendChild(b);
      }
      const reset = el('button', 'card-btn reset', 'Reset');
      reset.type = 'button';
      confirmButton(reset, 'Reset', 3000, () => {
        void getDefaultLayout().then((def) => {
          if (!def) return say('Cannot load the default layout');
          if (store && mode === 'edit') {
            edit(resetLayout(store, activeLayout(store).id, def));
            showCard();
          }
        });
      });
      row1.append(slots, reset);
      addRow(row1);

      const add = el('div', 'card-row');
      add.appendChild(el('span', 'card-label', 'Add'));
      for (const [kind, text] of [['button', 'Button'], ['stick', 'Stick'], ['dpad', 'D-pad']] as const) {
        const b = el('button', 'card-btn', text);
        b.type = 'button';
        b.setAttribute('aria-label', 'Add ' + (kind === 'dpad' ? 'D-pad' : kind));
        tap(b, () => addAndSelect(store ? addControl(store, kind) : null), false);
        add.appendChild(b);
      }
      addRow(add);

      addRow(
        makeSlider({
          label: 'Stick sensitivity',
          min: SENSITIVITY_RANGE.min,
          max: SENSITIVITY_RANGE.max,
          step: 0.1,
          value: clampTo(layoutSensitivity(layout), SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max),
          fmt: (v) => v.toFixed(1),
          onInput: (v) => {
            if (store) edit(setSensitivity(store, v));
          },
        }),
      );
      if (hmode === 'android') {
        // Off is the layout's haptics flag (the host stores it); Light and Strong are how long a press vibrates, kept on this phone.
        const level = hapticLevelOf(storageGet(HAPTIC_KEY));
        const current: 'off' | HapticLevel = layout.haptics ? level : 'off';
        addRow(
          makeChoice('Haptics', [['off', 'Off'], ['light', 'Light'], ['strong', 'Strong']] as const, current, (v) => {
            if (!store) return;
            if (v === 'off') {
              edit(setHaptics(store, false));
            } else {
              storageSet(HAPTIC_KEY, v);
              edit(setHaptics(store, true));
              haptics.tick(); // one tick of the chosen strength
            }
            showCard();
          }),
        );
      } else {
        addRow(
          makeToggle(
            'Haptics',
            () => !!store && activeLayout(store).haptics,
            () => {
              if (!store) return;
              const next = !activeLayout(store).haptics;
              edit(setHaptics(store, next));
              if (next) haptics.tick(); // one tick when it is switched on
            },
          ),
        );
      }
      const device = el('div', 'card-row');
      linkEl = el('span', 'card-label', linkText(rtt));
      device.appendChild(linkEl);
      const more = el('button', 'card-btn more', deviceOpen ? 'Less' : 'More');
      more.type = 'button';
      more.setAttribute('aria-expanded', deviceOpen ? 'true' : 'false');
      tap(
        more,
        () => {
          deviceOpen = !deviceOpen;
          showCard();
        },
        false,
      );
      device.appendChild(more);
      addRow(device);
      if (!deviceOpen) return;

      const awakeRow = el('div', 'card-row is-two');
      awakeRow.appendChild(el('span', 'card-label', 'Stay awake'));
      wakeEl = el('span', 'card-fact', wakeText(awake));
      awakeRow.appendChild(wakeEl);
      addRow(awakeRow, ROW_TWO_H);
      if (canFullscreen() && !inFullscreen()) {
        const b = el('button', 'card-btn wide', 'Full screen');
        b.type = 'button';
        tap(b, () => void enterFullscreen(), false);
        addRow(b);
      }
      const home = homeMode();
      if (home === 'steps') {
        const row = el('div', 'card-row is-two');
        row.appendChild(el('span', 'card-label', 'Add to Home screen'));
        row.appendChild(el('span', 'card-fact', 'Chrome menu, then Add to Home screen'));
        addRow(row, ROW_TWO_H);
      } else if (home) {
        const b = el('button', 'card-btn wide', 'Add to Home Screen');
        b.type = 'button';
        tap(b, () => (home === 'prompt' ? promptInstall() : openSheet()), false);
        addRow(b);
      }
    }

    // ---- Add to Home Screen ----
    interface InstallPrompt extends Event {
      prompt(): Promise<unknown>;
    }
    let installPrompt: InstallPrompt | null = null; // Android Chrome hands it over when the page qualifies (it needs https)
    let sheetOffered = false;
    const displayMode = (m: string): boolean => typeof matchMedia === 'function' && matchMedia('(display-mode: ' + m + ')').matches;
    const isStandalone = (): boolean => (navigator as { standalone?: boolean }).standalone === true || displayMode('standalone') || displayMode('fullscreen');
    const homeMode = (): HomeMode | null => homeScreenMode(ua, navigator.maxTouchPoints ?? 0, isStandalone(), installPrompt !== null);

    function openSheet(): void {
      neutralise(); // the sheet covers the field: nothing may stay held under it
      sheet.hidden = false;
    }
    function closeSheet(): void {
      sheet.hidden = true;
      storageSet(HOME_SEEN_KEY, '1');
    }
    function promptInstall(): void {
      const p = installPrompt;
      installPrompt = null; // a prompt can be used once
      try {
        void p?.prompt().catch(() => undefined);
      } catch {
        /* the browser refused: nothing to do */
      }
      if (mode === 'edit') showCard();
    }
    /** First time the connection is up on an iPhone that has not added the page yet: show the steps once, never while editing. */
    function offerSheet(): void {
      if (sheetOffered || mode !== 'play' || homeScreenMode(ua, navigator.maxTouchPoints ?? 0, isStandalone(), false) !== 'sheet' || storageGet(HOME_SEEN_KEY) === '1') return;
      sheetOffered = true;
      openSheet();
    }
    window.addEventListener(
      'beforeinstallprompt',
      (e) => {
        e.preventDefault();
        installPrompt = e as InstallPrompt;
      },
      on,
    );
    window.addEventListener(
      'appinstalled',
      () => {
        installPrompt = null;
      },
      on,
    );

    // ---- The player number on connect and on re-attach ----
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    function showSlot(n: number): void {
      slotToast.textContent = 'Player ' + n;
      slotToast.hidden = false;
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = null;
        slotToast.hidden = true;
      }, SLOT_TOAST_MS);
    }

    // ---- Full screen, landscape lock, stay awake: each one optional, started by the first tap (browsers want a gesture) ----
    const root = document.documentElement;
    /** Android Chrome and the like. iOS has no such API (an iPad that has one is left alone too), and an installed page is full screen already. */
    const canFullscreen = (): boolean => typeof root.requestFullscreen === 'function' && !isIosDevice(ua, navigator.maxTouchPoints ?? 0) && !isStandalone();
    const inFullscreen = (): boolean => document.fullscreenElement != null;
    let wasFullscreen = false;

    function lockLandscape(): void {
      try {
        const o = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
        const p = o && typeof o.lock === 'function' ? o.lock('landscape') : undefined;
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
      } catch {
        /* no orientation lock here: the rotate overlay does its job */
      }
    }
    async function enterFullscreen(): Promise<void> {
      if (!canFullscreen() || inFullscreen()) return;
      try {
        await root.requestFullscreen({ navigationUI: 'hide' });
      } catch {
        return; // refused: the settings card still offers it
      }
      lockLandscape();
    }
    function hideFsOffer(): void {
      fsOffer.hidden = true;
    }
    document.addEventListener(
      'fullscreenchange',
      () => {
        const inFs = inFullscreen();
        if (inFs) hideFsOffer();
        else if (wasFullscreen && canFullscreen() && !destroyed) {
          neutralise(); // the offer covers the field
          fsOffer.hidden = false;
        }
        wasFullscreen = inFs;
        if (mode === 'edit' && !selectedId) showCard();
      },
      on,
    );

    type Awake = 'idle' | 'lock' | 'video' | 'none';
    interface WakeSentinel {
      release?(): Promise<void>;
      addEventListener?(type: string, fn: () => void): void;
    }
    let awake: Awake = 'idle';
    let sentinel: WakeSentinel | null = null;
    let wakeVideo: HTMLVideoElement | null = null;
    let firstTapDone = false;
    const wakeText = (a: Awake): string => (a === 'lock' ? 'Wake lock' : a === 'video' ? 'Muted video' : a === 'none' ? 'Not available: set Auto-Lock to Never' : 'Starts on your first tap');
    const paintWake = (): void => {
      if (wakeEl?.isConnected) wakeEl.textContent = wakeText(awake);
    };

    /** The 2 x 2 muted looping video that keeps the screen on where navigator.wakeLock is missing (plain http). */
    async function startVideo(): Promise<void> {
      try {
        if (!wakeVideo) {
          const v = document.createElement('video');
          v.className = 'wake-video';
          v.muted = true;
          v.loop = true;
          v.setAttribute('muted', '');
          v.setAttribute('loop', '');
          v.setAttribute('playsinline', '');
          v.setAttribute('aria-hidden', 'true');
          v.tabIndex = -1;
          v.src = 'wake.mp4';
          document.body.appendChild(v);
          wakeVideo = v;
        }
        await wakeVideo.play();
        awake = 'video';
      } catch {
        awake = 'none';
      }
      paintWake();
    }
    async function startAwake(): Promise<void> {
      const wl = (navigator as Navigator & { wakeLock?: { request?(type: 'screen'): Promise<WakeSentinel> } }).wakeLock;
      if (wl && typeof wl.request === 'function') {
        try {
          const sen = await wl.request('screen');
          if (destroyed) {
            void sen.release?.();
            return;
          }
          sentinel = sen;
          sen.addEventListener?.('release', () => {
            if (sentinel !== sen) return;
            sentinel = null;
            if (awake === 'lock') awake = 'idle'; // the browser let go (page hidden): taken again when it is shown
            paintWake();
          });
          awake = 'lock';
          paintWake();
          return;
        } catch {
          /* refused (not a secure context, low battery): the video does the same */
        }
      }
      await startVideo();
    }
    /** The page is visible again: the browser released the lock and paused the video while it was hidden. */
    function keepAwakeAgain(): void {
      if (destroyed || !firstTapDone) return;
      if (awake === 'idle') void startAwake();
      else if (awake === 'video') void wakeVideo?.play().catch(() => undefined);
    }
    function onFirstTap(): void {
      if (firstTapDone) return;
      firstTapDone = true;
      document.removeEventListener('pointerup', onFirstTap, true);
      void enterFullscreen();
      void startAwake();
    }
    document.addEventListener('pointerup', onFirstTap, { capture: true, signal: ac.signal });

    // ---- Accidental back: one history entry that is put back whenever it is used up ----
    const holdBack = (): void => {
      try {
        history.pushState(null, '', location.href);
      } catch {
        /* no history API: back leaves the page, as it did */
      }
    };
    holdBack();
    window.addEventListener('popstate', holdBack, on);

    // ---- Orientation ----
    const portraitQuery = typeof matchMedia === 'function' ? matchMedia('(orientation: portrait)') : null;
    const isPortrait = (): boolean => (portraitQuery ? portraitQuery.matches : window.innerHeight > window.innerWidth);
    portrait = isPortrait();
    function onResize(): void {
      measure();
      syncField(false);
      if (mode === 'edit') placeCardNow(); // not showCard: the on-screen keyboard resizes the viewport and a rebuild would drop the label field
      const p = isPortrait();
      if (p === portrait) return;
      portrait = p;
      if (p) neutralise();
    }

    // ---- Diagnostics: ?diag=1 tells on a real phone which haptic paths work ----
    if (params.get('diag') === '1') {
      const diag = div('diag');
      diag.setAttribute('role', 'group');
      diag.setAttribute('aria-label', 'Haptics diagnostics');
      // The switch test: the same overlay the controls carry, in a big box. Touch it and feel for a tick; the readout says whether
      // its click arrived and how long after the touch (on press, or only when the finger lifted).
      const test = div('diag-test');
      test.appendChild(el('span', 'diag-test-label', 'Touch to test the switch'));
      test.appendChild(makeSwitch('test'));
      const out = el('p', 'diag-out');
      showDiag = () => {
        const line = (name: string, log: { n: number; text: string }): string => name + ': ' + (log.n === 0 ? 'no click yet' : log.n + (log.n === 1 ? ' click, ' : ' clicks, ') + log.text);
        out.textContent = line('test switch', switchLog.test) + '\n' + line('controls', switchLog.control);
      };
      showDiag();
      diag.append(test, out);
      if (hmode !== 'ios') {
        // Android/desktop: the programmatic paths. (On iOS none of them can tick any more, so they are not offered.)
        const buttons = div('diag-buttons');
        const rawTick = (): void => rawVibrate(10);
        const mk = (n: number, label: string): HTMLButtonElement => {
          const b = el('button', 'diag-btn', String(n));
          b.type = 'button';
          b.id = 'diag-' + n;
          b.setAttribute('aria-label', label);
          buttons.appendChild(b);
          return b;
        };
        mk(1, 'Vibrate from click').addEventListener('click', rawTick, on);
        mk(2, 'Vibrate from pointerdown').addEventListener('pointerdown', rawTick, on);
        const three = mk(3, 'Vibrate while dragging');
        let lastDragTick = 0;
        three.addEventListener('pointerdown', (e) => three.setPointerCapture?.(e.pointerId), on);
        three.addEventListener(
          'pointermove',
          () => {
            const t = now();
            if (t - lastDragTick >= 30) {
              lastDragTick = t;
              rawTick();
            }
          },
          on,
        );
        let timerCount = 0;
        mk(4, 'Ten vibrations from a timer').addEventListener(
          'click',
          () => {
            timerCount = 0;
            const iv = setInterval(() => {
              rawTick();
              if (++timerCount >= 10) clearInterval(iv);
            }, 100);
          },
          on,
        );
        diag.appendChild(buttons);
      }
      document.body.appendChild(diag);
    }

    // ---- Wiring ----
    fieldEl.addEventListener('pointerdown', (e) => (mode === 'edit' ? editDown(e) : playDown(e)), onPassive);
    fieldEl.addEventListener('pointermove', (e) => (mode === 'edit' ? editMove(e) : playMove(e)), onPassive);
    fieldEl.addEventListener('pointerup', (e) => (mode === 'edit' ? editEnd(e) : playEnd(e)), onPassive);
    // A cancelled pointer (system gesture, palm rejection) is a reason to distrust everything: release all. Except on a haptic
    // switch: its touch is deliberately not cancelled at touchstart, so iOS may claim just that touch (a long press, say), and that
    // must not also drop the stick under the other thumb. Only that finger's control is released.
    fieldEl.addEventListener('pointercancel', (e) => (mode === 'edit' ? editEnd(e) : isSwitch(e.target) ? playEnd(e) : neutralise()), onPassive);
    fieldEl.addEventListener('lostpointercapture', (e) => (mode === 'edit' ? editEnd(e) : playEnd(e)), onPassive);

    // iOS: touchstart on the field stops the magnifier, the callout and double-tap zoom; touchmove and gesturestart stop pinch and
    // scroll. Two exceptions. A touch on a haptic switch must NOT be cancelled: preventDefault on touchstart or touchmove stops the
    // browser from generating the click, and without the click there is no tick (the CSS touch-action: none covers zoom and scroll
    // there). And the card and the home screen sheet scroll when they are taller than the screen.
    const scrolls = (t: EventTarget | null): boolean => t instanceof Element && t.closest('#card, #a2hs') !== null;
    fieldEl.addEventListener('touchstart', (e) => (isSwitch(e.target) ? undefined : e.preventDefault()), { passive: false, signal: ac.signal });
    document.addEventListener('touchmove', (e) => (isSwitch(e.target) || scrolls(e.target) ? undefined : e.preventDefault()), { passive: false, signal: ac.signal });
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(g, (e) => e.preventDefault(), { passive: false, signal: ac.signal });
    document.addEventListener('contextmenu', (e) => e.preventDefault(), on);
    document.addEventListener('selectstart', (e) => (e.target instanceof HTMLInputElement ? undefined : e.preventDefault()), on); // the label field needs a caret
    document.addEventListener('dragstart', (e) => e.preventDefault(), on);

    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') neutralise();
        else {
          reconnectNow();
          keepAwakeAgain();
        }
      },
      on,
    );
    window.addEventListener('blur', neutralise, on);
    window.addEventListener('pagehide', neutralise, on);
    window.addEventListener('online', () => reconnectNow(true), on);
    window.addEventListener('resize', onResize, on);
    window.addEventListener('orientationchange', onResize, on);
    window.visualViewport?.addEventListener('resize', onResize, on);
    portraitQuery?.addEventListener('change', onResize, on);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => onResize());
      observer.observe(fieldEl);
    }

    tap(menu, enterEdit);
    tap(done, finishEdit);
    tap(sheetClose, closeSheet);
    tap(fsGo, () => {
      hideFsOffer();
      void enterFullscreen();
    });
    tap(fsSkip, hideFsOffer);
    tap(retryBtn, () => {
      if (phase === 'full' || phase === 'replaced') {
        attempt = 0;
        everDropped = false;
        setPhase('connecting');
        connect();
      } else if (layoutState === 'failed') {
        void loadLayouts();
      }
    });

    measure();
    render();
    if (token) {
      connect();
      void loadLayouts();
    }

    return {
      destroy(): void {
        destroyed = true;
        ac.abort();
        observer?.disconnect();
        stopKeepalive();
        for (const t of [reconnectTimer, sendTimer, retryTimer, confirmTimer, toastTimer, connectTimer, deadTimer]) if (t !== null) clearTimeout(t);
        if (pingTimer !== null) clearInterval(pingTimer);
        void sentinel?.release?.();
        wakeVideo?.remove();
        for (const t of pendingRelease.values()) clearTimeout(t);
        if (turboTimer !== null) clearInterval(turboTimer);
        haptics.stop();
        const sock = ws;
        ws = null;
        sock?.close();
      },
    };
  }

  // ================================================================================================================
  // 4. Start
  // ================================================================================================================

  // Tests set window.__LANPLAY_TEST__ = {} before loading this file. The pure functions and boot() are then handed to that
  // object and the page does not start by itself. A normal page never defines the global, so it exposes nothing.
  const hook = (window as unknown as { __LANPLAY_TEST__?: unknown }).__LANPLAY_TEST__;
  if (typeof hook === 'object' && hook !== null) {
    Object.assign(hook, {
      BTN,
      NEUTRAL,
      LIMITS,
      BUTTON_NAMES,
      CURVES,
      SHAPES,
      SLOTS,
      MIN_PRESS_MS,
      STICK_SEND_MS,
      HARD_SEND_GAP_MS,
      KEEPALIVE_MS,
      DOUBLE_TAP_MS,
      SAVE_RETRY_MS,
      TAP_SLOP,
      SIZE_RANGE,
      SENSITIVITY_RANGE,
      CARD_W,
      ROW_H,
      ROW_TWO_H,
      CARD_PAD,
      DIM_RANGE,
      FLOATING_ZONE,
      TURBO_HALF_MS,
      CONFIRM_MS,
      HOME_SEEN_KEY,
      // layout store
      coerceStore,
      activeLayout,
      switchLayout,
      moveControl,
      setSize,
      setOpacity,
      setSensitivity,
      setHaptics,
      addSlot,
      resetLayout,
      layoutSensitivity,
      sizeOf,
      sizeRange,
      opacityRange,
      controlBox,
      halfExtent,
      placeCard,
      placeSettingsCard,
      reachBox,
      applyProps,
      setProps,
      addControl,
      duplicateControl,
      deleteControl,
      dimRange,
      gridHeight,
      buttonMode,
      modePatch,
      cardHeight,
      floatingCentre,
      // pad maths and send timing
      stickAxes,
      deflection,
      limitToRadius,
      dpadMask,
      buttonMask,
      buildPad,
      samePad,
      releaseDelay,
      isDoubleTap,
      // haptics
      hapticMode,
      androidPattern,
      androidStickStep,
      createHaptics,
      describeSwitchClick,
      homeScreenMode,
      isIosDevice,
      // protocol
      backoffDelay,
      deviceLabel,
      playerName,
      wsUrl,
      parseServerMessage,
      statusText,
      newPhoneId,
      isPhoneId,
      medianRtt,
      linkText,
      hapticLevelOf,
      PING_MS,
      PING_DEAD_MS,
      CONNECT_MS,
      RTT_WARN_MS,
      SLOT_TOAST_MS,
      ID_KEY,
      HAPTIC_KEY,
      boot,
    });
  } else {
    boot();
  }
})();
