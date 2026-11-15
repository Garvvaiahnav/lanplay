/* LanPlay phone controller page.
 *
 * Classic script (no import/export) wrapped in an IIFE so it adds no globals. The wire protocol is implemented in
 * src/core/controller/protocol.ts and the layout schema in src/core/controller/layout.ts; this file mirrors the numbers and
 * types it needs (tests/ui/controller-page.test.ts asserts the mirrors match and that every edit is a fixed point of the
 * host's sanitizer).
 *
 * Layout of this file
 *   1. wire constants and the mirror of layout.ts
 *   2. pure logic: layout store operations, undo history, stick / d-pad / pad maths, protocol helpers
 *   3. boot(): the page (rendering from the active layout, play input, edit mode, host sync, connection)
 *   4. the test hook
 *
 * Design notes
 *  - Layouts live on the HOST (per phone IP). The page loads them with GET /api/layouts, edits a local draft and saves the whole
 *    store with PUT /api/layouts; the sanitized store in the response is the truth. There is no fallback layout and nothing is
 *    kept on the phone except the player-name digits.
 *  - Every control is driven by Pointer Events with setPointerCapture, so any number of fingers work at once.
 *  - Anything that could leave a control stuck (page hidden, window blur, socket closed, cancelled pointer, portrait, entering
 *    the editor) releases every control and sends one neutral state.
 *  - Nothing is logged: the page URL carries the session token.
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

  /** XUSB bit for each digital button name. LT and RT are analog triggers and have no bit. */
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
  const FLOATING_ZONE = 1.5; // a floating stick's touch area is this many times its base size
  const STICK_RADIUS_FALLBACK = 56;
  const DPAD_CENTRE = 0.2; // fraction of the d-pad half-size that counts as "centre"
  const DPAD_TAN = Math.tan(Math.PI / 3); // cardinal arms 60 degrees wide, diagonals 30
  const DOUBLE_TAP_MS = 300;
  const TURBO_HALF_PERIOD_MS = 50;
  const MIN_FRAME_MS = 16;
  const KEEPALIVE_MS = 500;
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  const VIBRATE_MS = 8;
  const HINT_VISIBLE_MS = 12000;
  const EDIT_HOLD_MS = 600;
  const SAVE_DEBOUNCE_MS = 1500;
  const SAVED_VISIBLE_MS = 2500;
  const UNDO_STEPS = 20;
  const MAX_SLOT = 99;
  const WS_OPEN = 1;
  const NAME_KEY = 'lanplay.pad.number';
  const HINT_KEY = 'lanplay.pad.timeout-hint';

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
  interface ButtonOut {
    button: ButtonName;
    value: number;
  }
  type Phase = 'notoken' | 'connecting' | 'connected' | 'retrying' | 'full' | 'kicked';
  type ServerMessage = { t: 'welcome'; slot: number } | { t: 'full' } | { t: 'kicked' };

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

  // ---- Controls: defaults, validated property patches --------------------------------------------------------------

  const BUTTON_LOOK: Readonly<Record<ButtonName, { w: number; h: number; shape: Shape; label: string }>> = Object.freeze({
    A: { w: 14, h: 14, shape: 'circle', label: 'A' },
    B: { w: 14, h: 14, shape: 'circle', label: 'B' },
    X: { w: 14, h: 14, shape: 'circle', label: 'X' },
    Y: { w: 14, h: 14, shape: 'circle', label: 'Y' },
    LB: { w: 17, h: 11, shape: 'rect', label: 'LB' },
    RB: { w: 17, h: 11, shape: 'rect', label: 'RB' },
    LT: { w: 17, h: 11, shape: 'rect', label: 'LT' },
    RT: { w: 17, h: 11, shape: 'rect', label: 'RT' },
    START: { w: 12, h: 7, shape: 'pill', label: 'Start' },
    BACK: { w: 12, h: 7, shape: 'pill', label: 'Back' },
    L3: { w: 10, h: 10, shape: 'circle', label: 'L3' },
    R3: { w: 10, h: 10, shape: 'circle', label: 'R3' },
  });

  type NewKind = 'stick' | 'dpad' | ButtonName;

  /** A control with the host's defaults (the same numbers layout.ts falls back to). */
  function newControl(kind: NewKind, id: string, x: number, y: number, side: 'left' | 'right' = 'left'): Control {
    const base = { id, x: round(x, 2), y: round(y, 2), opacity: 0.8 };
    if (kind === 'stick') {
      return { ...base, type: 'stick', stick: side, size: 36, mode: 'fixed', deadzone: 0.1, sensitivity: 1, curve: 'linear', invertX: false, invertY: false, doubleTapClick: true };
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

  /**
   * Apply a property patch with validation: unknown keys and invalid values are ignored, numbers are clamped to LIMITS and rounded
   * the way the host rounds them. Returns the SAME object when nothing changed. Changing a button's name also renames its label
   * when the label was still the old default.
   */
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
      if (b.button !== c.button && !('label' in patch) && (c.label === c.button || c.label === BUTTON_LOOK[c.button].label)) b.label = BUTTON_LOOK[b.button].label;
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

  /** Tolerant read of a store from host JSON, or null when it has no usable layout. */
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

  /** Touch-area size of a control as [width, height], in percent of the viewport HEIGHT. */
  function controlBox(c: Control): [number, number] {
    if (c.type === 'button') return [c.w, c.h];
    const s = c.type === 'stick' && c.mode === 'floating' ? c.size * FLOATING_ZONE : c.size;
    return [s, s];
  }

  /** Half extent of a control as [percent of width, percent of height]; `aspect` = viewport width / height. */
  function halfExtent(c: Control, aspect: number): [number, number] {
    const [w, h] = controlBox(c);
    return [w / 2 / (aspect > 0 ? aspect : 1), h / 2];
  }

  /** Keep a centre coordinate (percent) so the whole control stays on screen; a control larger than the screen is centred. */
  function clampCentre(v: number, half: number): number {
    return round(half * 2 >= 100 ? 50 : clampTo(v, half, 100 - half), 2);
  }

  /** New dimensions for a control whose bottom-right resize handle sits at (wPct, hPct) = twice its offset from the centre. */
  function sizeFromHandle(c: Control, wPct: number, hPct: number): Record<string, number> {
    if (c.type === 'button') {
      if (c.shape === 'circle') {
        const d = Math.max(wPct, hPct);
        return { w: d, h: d };
      }
      return { w: wPct, h: hPct };
    }
    const d = Math.max(wPct, hPct);
    return { size: c.type === 'stick' && c.mode === 'floating' ? d / FLOATING_ZONE : d };
  }

  // ---- Layout store operations (pure: every one returns a new store, or the SAME store when it is a no-op) ------------

  function activeLayout(store: LayoutStore): Layout {
    return store.layouts.find((l) => l.id === store.activeId) ?? (store.layouts[0] as Layout);
  }

  const cloneControls = (cs: readonly Control[]): Control[] => cs.slice(0, LIMITS.controls).map((c) => ({ ...c }));

  function uniqueName(store: LayoutStore, base: string): string {
    const taken = new Set(store.layouts.map((l) => l.name));
    const name = cleanText(base, LIMITS.nameChars) || 'Layout';
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = name.slice(0, LIMITS.nameChars - suffix.length).trim() + suffix;
      if (!taken.has(candidate)) return candidate;
    }
  }

  function insertLayout(store: LayoutStore, name: string, haptics: boolean, controls: readonly Control[]): LayoutStore {
    if (store.layouts.length >= LIMITS.layouts) return store;
    const id = freshId('layout', new Set(store.layouts.map((l) => l.id)));
    const layout: Layout = { id, name: uniqueName(store, name), haptics, controls: cloneControls(controls) };
    return { version: 1, activeId: id, layouts: [...store.layouts, layout] };
  }

  /** New empty layout, made active. */
  function newBlankLayout(store: LayoutStore): LayoutStore {
    return insertLayout(store, `Layout ${store.layouts.length + 1}`, true, []);
  }
  /** New layout with the controls of `template` (the host's stock layout, or any other), made active. */
  function newLayoutFrom(store: LayoutStore, template: Layout): LayoutStore {
    return insertLayout(store, template.name, template.haptics, template.controls);
  }
  function duplicateLayout(store: LayoutStore, id: string): LayoutStore {
    const src = store.layouts.find((l) => l.id === id);
    return src ? insertLayout(store, `${src.name} copy`, src.haptics, src.controls) : store;
  }
  function renameLayout(store: LayoutStore, id: string, name: string): LayoutStore {
    const clean = cleanText(name, LIMITS.nameChars);
    const cur = store.layouts.find((l) => l.id === id);
    if (!cur || !clean || clean === cur.name) return store;
    return { ...store, layouts: store.layouts.map((l) => (l.id === id ? { ...l, name: clean } : l)) };
  }
  /** Never deletes the last layout. Deleting the active one activates its neighbour. */
  function deleteLayout(store: LayoutStore, id: string): LayoutStore {
    const index = store.layouts.findIndex((l) => l.id === id);
    if (index < 0 || store.layouts.length <= 1) return store;
    const layouts = store.layouts.filter((l) => l.id !== id);
    const activeId = store.activeId === id ? (layouts[Math.min(index, layouts.length - 1)] as Layout).id : store.activeId;
    return { version: 1, activeId, layouts };
  }
  function switchLayout(store: LayoutStore, id: string): LayoutStore {
    return id !== store.activeId && store.layouts.some((l) => l.id === id) ? { ...store, activeId: id } : store;
  }
  /** Next (step 1) or previous (step -1) layout, wrapping around. */
  function cycleLayout(store: LayoutStore, step: number): LayoutStore {
    const n = store.layouts.length;
    if (n <= 1) return store;
    const i = store.layouts.findIndex((l) => l.id === store.activeId);
    return switchLayout(store, (store.layouts[(((i < 0 ? 0 : i) + step) % n + n) % n] as Layout).id);
  }
  /** Replace the controls (and the haptics setting) of one layout with the stock ones; id and name stay. */
  function resetLayout(store: LayoutStore, id: string, stock: Layout): LayoutStore {
    if (!store.layouts.some((l) => l.id === id)) return store;
    return { ...store, layouts: store.layouts.map((l) => (l.id === id ? { ...l, haptics: stock.haptics, controls: cloneControls(stock.controls) } : l)) };
  }
  function setHaptics(store: LayoutStore, id: string, on: boolean): LayoutStore {
    const cur = store.layouts.find((l) => l.id === id);
    if (!cur || cur.haptics === on) return store;
    return { ...store, layouts: store.layouts.map((l) => (l.id === id ? { ...l, haptics: on } : l)) };
  }

  // Control operations act on the ACTIVE layout.

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

  const canAddControl = (store: LayoutStore): boolean => activeLayout(store).controls.length < LIMITS.controls;

  /** Add a control near the middle of the screen (staggered so new ones do not hide each other). Returns the new id, or null at the limit. */
  function addControl(store: LayoutStore, kind: NewKind, aspect = 2): { store: LayoutStore; id: string | null } {
    const layout = activeLayout(store);
    if (layout.controls.length >= LIMITS.controls) return { store, id: null };
    const used = new Set(layout.controls.map((c) => c.id));
    const side: 'left' | 'right' = layout.controls.some((c) => c.type === 'stick' && c.stick === 'left') ? 'right' : 'left';
    const prefix = kind === 'stick' ? `stick-${side}` : kind === 'dpad' ? 'dpad' : `btn-${kind.toLowerCase()}`;
    const id = freshId(prefix, used);
    const step = layout.controls.length % 5;
    const probe = newControl(kind, id, 0, 0, side);
    const [hx, hy] = halfExtent(probe, aspect);
    const c = newControl(kind, id, clampCentre(50 + (step - 2) * 4, hx), clampCentre(50 + (step - 2) * 4, hy), side);
    return { store: mapActive(store, (l) => ({ ...l, controls: [...l.controls, c] })), id };
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

  /** Resize: `{size}` for sticks and d-pads, `{w, h}` for buttons; clamped to LIMITS.size and kept on screen. */
  function resizeControl(store: LayoutStore, id: string, dims: { size?: number; w?: number; h?: number }, aspect = 2): LayoutStore {
    return mapControl(store, id, (c) => {
      const resized = applyProps(c, dims);
      if (resized === c) return c;
      const [hx, hy] = halfExtent(resized, aspect);
      return { ...resized, x: clampCentre(resized.x, hx), y: clampCentre(resized.y, hy) };
    });
  }

  /** A copy next to the original with a fresh id. Returns the new id, or null at the limit / when the control is missing. */
  function duplicateControl(store: LayoutStore, id: string, aspect = 2): { store: LayoutStore; id: string | null } {
    const layout = activeLayout(store);
    const src = layout.controls.find((c) => c.id === id);
    if (!src || layout.controls.length >= LIMITS.controls) return { store, id: null };
    const newId = freshId(id, new Set(layout.controls.map((c) => c.id)));
    const copy: Control = { ...src, id: newId };
    const [hx, hy] = halfExtent(copy, aspect);
    copy.x = clampCentre(src.x + 4, hx);
    copy.y = clampCentre(src.y + 4, hy);
    return { store: mapActive(store, (l) => ({ ...l, controls: [...l.controls, copy] })), id: newId };
  }

  function deleteControl(store: LayoutStore, id: string): LayoutStore {
    return mapActive(store, (l) => (l.controls.some((c) => c.id === id) ? { ...l, controls: l.controls.filter((c) => c.id !== id) } : l));
  }

  /** Set validated properties on one control (see applyProps). */
  function patchControl(store: LayoutStore, id: string, patch: Readonly<Record<string, unknown>>): LayoutStore {
    return mapControl(store, id, (c) => applyProps(c, patch));
  }

  // ---- Undo (the last UNDO_STEPS stores; stores are immutable so a step is just a reference) --------------------------

  interface History {
    past: LayoutStore[];
    /** Key of the gesture in progress; edits with the same key share one undo step. */
    key: string | null;
  }
  const emptyHistory = (): History => ({ past: [], key: null });
  /** Call before replacing `before` with an edited store. A repeated non-null key (a drag, a slider) records only the first. */
  function recordEdit(h: History, before: LayoutStore, key: string | null): History {
    if (key !== null && h.key === key) return h;
    return { past: [...h.past, before].slice(-UNDO_STEPS), key };
  }
  function endGesture(h: History): History {
    return h.key === null ? h : { ...h, key: null };
  }
  function undo(h: History): { history: History; store: LayoutStore } | null {
    const prev = h.past[h.past.length - 1];
    return prev ? { history: { past: h.past.slice(0, -1), key: null }, store: prev } : null;
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
   * Stick offset from the base centre (screen pixels, y grows downwards) to XInput axes:
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

  /** XUSB bits for a set of buttons plus the d-pad. LT and RT add nothing here (see buildPad). */
  function buttonMask(buttons: Iterable<string>, dpad: number): number {
    let m = dpad & DPAD_BITS;
    for (const name of buttons) m |= BUTTON_BITS[name] ?? 0;
    return m;
  }

  /** The wire state for the buttons currently down. Triggers send their configured value (the largest wins when several are down). */
  function buildPad(outs: Iterable<ButtonOut>, dpad: number, ls: Readonly<Axes>, rs: Readonly<Axes>): Pad {
    let b = dpad & DPAD_BITS;
    let lt = 0;
    let rt = 0;
    for (const o of outs) {
      if (o.button === 'LT') lt = Math.max(lt, o.value);
      else if (o.button === 'RT') rt = Math.max(rt, o.value);
      else b |= BUTTON_BITS[o.button] ?? 0;
    }
    const axis = (v: number): number => clampTo(Math.round(v) || 0, -32768, AXIS_MAX);
    const trig = (v: number): number => clampTo(Math.round(v) || 0, 0, 255);
    return { b, lt: trig(lt), rt: trig(rt), lx: axis(ls.x), ly: axis(ls.y), rx: axis(rs.x), ry: axis(rs.y) };
  }

  function samePad(a: Readonly<Pad> | null, b: Readonly<Pad>): boolean {
    return a !== null && a.b === b.b && a.lt === b.lt && a.rt === b.rt && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx && a.ry === b.ry;
  }

  /** Union of two pad snapshots for latching presses: buttons OR-ed, triggers maxed, sticks from the newer one. */
  function mergePress(older: Readonly<Pad>, newer: Readonly<Pad>): Pad {
    return { ...newer, b: older.b | newer.b, lt: Math.max(older.lt, newer.lt), rt: Math.max(older.rt, newer.rt) };
  }

  /** True when `pad` still shows every button and trigger that `press` had down. */
  function coversPress(pad: Readonly<Pad>, press: Readonly<Pad>): boolean {
    return (press.b & ~pad.b) === 0 && press.lt <= pad.lt && press.rt <= pad.rt;
  }

  /** Two taps on a stick: the second touch starts within 300 ms of the first tap's release. */
  function isDoubleTap(lastTapEnd: number | null, now: number): boolean {
    return lastTapEnd !== null && now >= lastTapEnd && now - lastTapEnd <= DOUBLE_TAP_MS;
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
      default:
        return null;
    }
  }

  function statusText(phase: Phase, slot: number | null): string {
    switch (phase) {
      case 'notoken':
        return 'Open the link or QR code from the LanPlay host screen';
      case 'connecting':
        return 'Connecting…';
      case 'connected':
        return slot === null ? 'Connected' : 'Player ' + slot;
      case 'retrying':
        return 'Disconnected — retrying…';
      case 'full':
        return 'All 4 player slots are taken';
      case 'kicked':
        return 'Removed from this PC';
    }
  }

  /** Short, user-facing reason for a failed layout request. */
  function httpMessage(status: number): string {
    if (status === 401 || status === 403) return 'The host did not accept this link';
    if (status === 413) return 'The layout is too big to save';
    if (status === 429) return 'Too many requests, wait a moment';
    if (status === 0) return 'Cannot reach the PC';
    return 'The PC reported an error';
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
    /** Zone rect origin and the base centre inside it (CSS pixels). */
    left: number;
    top: number;
    ox: number;
    oy: number;
    radius: number;
    params: StickParams;
    downAt: number;
    click: boolean;
    ax: Axes;
  }
  interface DpadHold {
    kind: 'dpad';
    cid: string;
    cx: number;
    cy: number;
    half: number;
    diagonals: boolean;
    bits: number;
  }
  type Hold = ButtonHold | StickHold | DpadHold;
  interface EditDrag {
    pointerId: number;
    kind: 'move' | 'resize';
    id: string;
    /** move: the control centre minus the finger, in percent. */
    ox: number;
    oy: number;
  }
  type SaveState = 'idle' | 'saving' | 'saved' | 'error';
  type Tab = 'control' | 'add' | 'layout';
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

    const must = <T extends HTMLElement>(id: string): T => {
      const el = document.getElementById(id);
      if (!el) throw new Error('controller page is missing #' + id);
      return el as T;
    };
    const fieldEl = must('field');
    const strip = must('strip');
    const statusEl = must('status');
    const saveEl = must('save');
    const saveRetry = must('save-retry');
    const layoutPick = must<HTMLSelectElement>('layout-pick');
    const fsBtn = must('fullscreen');
    const editBtn = must('edit');
    const panel = must('panel');
    const doneBtn = must('done');
    const undoBtn = must<HTMLButtonElement>('undo');
    const panelSave = must<HTMLButtonElement>('panel-save');
    const collapseBtn = must('collapse');
    const panelBody = must('panel-body');
    const panelMsg = must('panel-msg');
    const panelContent = must('panel-content');
    const hintEl = must('hint');
    const hintClose = must('hint-close');
    const noticeEl = must('notice');
    const noticeText = must('notice-text');
    const retryBtn = must('retry');

    const now = (): number => Date.now();

    // ---- Storage (private mode and blocked storage throw). Only the player-name digits and the hint flag live here. ----
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
    const token = new URLSearchParams(location.search).get('t');
    let phase: Phase = token ? 'connecting' : 'notoken';
    let slot: number | null = null;
    let layoutState: 'loading' | 'ready' | 'failed' = 'loading';
    let store: LayoutStore | null = null;
    let mode: 'play' | 'edit' = 'play';
    let portrait = false;
    let destroyed = false;
    /** Bumped by every edit; a save response is only adopted when nothing changed since it was sent. */
    let rev = 0;
    let history: History = emptyHistory();
    let selectedId: string | null = null;
    let tab: Tab = 'control';
    let defaultCache: Layout | null = null;

    // ---- Units: sizes in layouts are percent of the viewport height ----
    function updateUnit(): void {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return; // the on-screen keyboard resizes the viewport
      const vv = window.visualViewport;
      const h = window.innerHeight > 0 ? window.innerHeight : (vv?.height ?? 0);
      if (h > 0) document.documentElement.style.setProperty('--u', (h / 100).toFixed(4) + 'px');
    }
    const aspect = (): number => (window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 2);
    function fieldMetrics(): { left: number; top: number; w: number; h: number } {
      const r = fieldEl.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, w: r.width, h: r.height } : { left: 0, top: 0, w: window.innerWidth, h: window.innerHeight };
    }

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
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-pressed', 'false');
        el = b;
      } else if (c.type === 'stick') {
        el = div('ctl ctl-stick');
        el.setAttribute('role', 'group');
        const base = div('stick-base');
        base.appendChild(div('stick-knob'));
        el.appendChild(base);
      } else {
        el = div('ctl ctl-dpad');
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', 'D-pad');
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
      if (c.type === 'button') {
        el.className = 'ctl key ctl-btn shape-' + c.shape; // resets the state classes, which are re-applied below
        el.classList.toggle('is-down', isDown(c.id));
        el.classList.toggle('is-latch', c.latch);
        el.dataset['button'] = c.button;
        el.setAttribute('aria-label', BUTTON_ARIA[c.button]);
        if (el.textContent !== c.label) el.textContent = c.label;
        // Text size follows the button height but shrinks for long labels (units of 1% of the viewport height).
        el.style.setProperty('--fs', Math.max(2.2, Math.min(c.h * 0.42, (c.w * 1.4) / Math.max(1, c.label.length))).toFixed(2));
      } else if (c.type === 'stick') {
        el.classList.toggle('is-floating', c.mode === 'floating');
        el.setAttribute('aria-label', (c.stick === 'left' ? 'Left' : 'Right') + ' stick');
        el.style.setProperty('--s', String(c.size));
      }
    }

    /** Make the DOM match the active layout without recreating elements (pointer capture survives edits). */
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
      updateSelection();
    }

    function updateSelection(): void {
      for (const [id, el] of elems) {
        const sel = mode === 'edit' && id === selectedId;
        el.classList.toggle('is-selected', sel);
        const handle = el.querySelector('.resize-handle');
        if (sel && !handle) {
          const hd = document.createElement('span');
          hd.className = 'resize-handle';
          hd.dataset['handle'] = '1';
          el.appendChild(hd);
        } else if (!sel && handle) {
          handle.remove();
        }
      }
    }

    // ---- Play input state ----
    const holds = new Map<number, Hold>(); // pointerId -> what that finger holds
    const fingers = new Map<string, number>(); // button control id -> fingers on it
    const latched = new Set<string>(); // button controls toggled on
    const lastTapEnd = new Map<string, number>(); // stick control id -> when its last tap ended
    let turboOn = true;
    let turboTimer: ReturnType<typeof setInterval> | null = null;
    /** Pad as it was when a button went down; see onFrame. */
    let latch: Pad | null = null;

    function haptic(): void {
      if (!store || !activeLayout(store).haptics) return;
      try {
        if (typeof navigator.vibrate === 'function') navigator.vibrate(VIBRATE_MS);
      } catch {
        /* vibration is a nicety */
      }
    }

    const isDown = (cid: string): boolean => (fingers.get(cid) ?? 0) > 0 || latched.has(cid);

    function paintButton(cid: string): void {
      const el = elems.get(cid);
      if (!el) return;
      const down = isDown(cid);
      el.classList.toggle('is-down', down);
      if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', down ? 'true' : 'false');
    }

    /** Rapid fire runs only while a turbo button is held; the output blinks 50 ms on, 50 ms off. */
    function syncTurbo(): void {
      let any = false;
      for (const cid of [...fingers.keys(), ...latched]) {
        const c = controls.get(cid);
        if (c && c.type === 'button' && c.turbo && isDown(cid)) any = true;
      }
      if (any && turboTimer === null) {
        turboOn = true;
        turboTimer = setInterval(() => {
          turboOn = !turboOn;
          requestFlush();
        }, TURBO_HALF_PERIOD_MS);
      } else if (!any && turboTimer !== null) {
        clearInterval(turboTimer);
        turboTimer = null;
        turboOn = true;
      }
    }

    function readPad(): Pad {
      const outs: ButtonOut[] = [];
      const add = (cid: string): void => {
        const c = controls.get(cid);
        if (c && c.type === 'button' && (!c.turbo || turboOn)) outs.push({ button: c.button, value: c.value });
      };
      for (const [cid, n] of fingers) if (n > 0) add(cid);
      for (const cid of latched) add(cid);
      let dpad = 0;
      let ls: Readonly<Axes> = ZERO;
      let rs: Readonly<Axes> = ZERO;
      for (const h of holds.values()) {
        if (h.kind === 'stick') {
          if (h.side === 'left') ls = h.ax;
          else rs = h.ax;
          if (h.click) outs.push({ button: h.side === 'left' ? 'L3' : 'R3', value: 255 });
        } else if (h.kind === 'dpad') {
          dpad |= h.bits;
        }
      }
      return buildPad(outs, dpad, ls, rs);
    }

    function paintDpad(cid: string, bits: number): void {
      const el = elems.get(cid);
      if (!el) return;
      for (const [dir, bit] of [['up', BTN.UP], ['down', BTN.DOWN], ['left', BTN.LEFT], ['right', BTN.RIGHT]] as const) {
        el.querySelector('.arm-' + dir)?.classList.toggle('is-down', (bits & bit) !== 0);
      }
    }

    function resetStickVisual(el: HTMLElement): void {
      el.classList.remove('is-active');
      const base = el.querySelector<HTMLElement>('.stick-base');
      const knob = el.querySelector<HTMLElement>('.stick-knob');
      base?.style.removeProperty('--ox');
      base?.style.removeProperty('--oy');
      if (knob) knob.style.transform = '';
    }

    function paintKnob(el: HTMLElement, dx: number, dy: number, radius: number): void {
      const knob = el.querySelector<HTMLElement>('.stick-knob');
      if (!knob) return;
      const k = limitToRadius(dx, dy, radius);
      knob.style.transform = 'translate(' + k.x.toFixed(1) + 'px, ' + k.y.toFixed(1) + 'px)';
    }

    /** Remember that something was pressed, in case it is released again before the next frame goes out. */
    function latchPress(): void {
      const cur = readPad();
      latch = latch ? mergePress(latch, cur) : cur;
    }

    function pressDown(cid: string): void {
      paintButton(cid);
      haptic();
      latchPress();
      syncTurbo();
    }

    // ---- Play: pointer handling ----
    function inputEnabled(): boolean {
      return mode === 'play' && layoutState === 'ready' && !portrait && phase !== 'notoken' && phase !== 'full' && phase !== 'kicked';
    }

    function playDown(e: PointerEvent): void {
      if (!inputEnabled() || holds.has(e.pointerId)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest<HTMLElement>('[data-cid]');
      const c = el ? controls.get(el.dataset['cid'] ?? '') : undefined;
      if (!el || !c) return;

      if (c.type === 'button') {
        if (c.latch) {
          // Tap to hold, tap again to release: nothing to track per finger.
          if (latched.has(c.id)) {
            latched.delete(c.id);
            paintButton(c.id);
            syncTurbo();
          } else {
            latched.add(c.id);
            pressDown(c.id);
          }
        } else {
          holds.set(e.pointerId, { kind: 'btn', cid: c.id });
          const n = (fingers.get(c.id) ?? 0) + 1;
          fingers.set(c.id, n);
          if (n === 1) pressDown(c.id);
        }
      } else if (c.type === 'stick') {
        if (zoneBusy((h) => h.kind === 'stick' && h.cid === c.id)) return;
        const rect = el.getBoundingClientRect();
        const baseW = el.querySelector<HTMLElement>('.stick-base')?.getBoundingClientRect().width ?? 0;
        const radius = baseW > 0 ? baseW / 2 : STICK_RADIUS_FALLBACK;
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        let ox = rect.width / 2;
        let oy = rect.height / 2;
        if (c.mode === 'floating') {
          // The base appears under the finger, kept fully inside the touch area.
          ox = rect.width >= radius * 2 ? clampTo(px, radius, rect.width - radius) : px;
          oy = rect.height >= radius * 2 ? clampTo(py, radius, rect.height - radius) : py;
          const base = el.querySelector<HTMLElement>('.stick-base');
          base?.style.setProperty('--ox', ox.toFixed(1) + 'px');
          base?.style.setProperty('--oy', oy.toFixed(1) + 'px');
        }
        const t = now();
        const click = c.doubleTapClick && isDoubleTap(lastTapEnd.get(c.id) ?? null, t);
        lastTapEnd.delete(c.id);
        const hold: StickHold = {
          kind: 'stick',
          cid: c.id,
          side: c.stick,
          left: rect.left,
          top: rect.top,
          ox,
          oy,
          radius,
          params: { deadzone: c.deadzone, sensitivity: c.sensitivity, curve: c.curve, invertX: c.invertX, invertY: c.invertY },
          downAt: t,
          click,
          ax: ZERO,
        };
        holds.set(e.pointerId, hold);
        el.classList.add('is-active');
        moveStick(hold, el, e);
        if (click) {
          haptic();
          latchPress();
        }
      } else {
        if (zoneBusy((h) => h.kind === 'dpad' && h.cid === c.id)) return;
        const rect = el.getBoundingClientRect();
        const hold: DpadHold = { kind: 'dpad', cid: c.id, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, half: Math.min(rect.width, rect.height) / 2, diagonals: c.diagonals, bits: 0 };
        holds.set(e.pointerId, hold);
        moveDpad(hold, e);
      }

      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone; lostpointercapture cleans up */
      }
      requestFlush();
    }

    function zoneBusy(match: (h: Hold) => boolean): boolean {
      for (const h of holds.values()) if (match(h)) return true;
      return false;
    }

    function moveStick(h: StickHold, el: HTMLElement, e: PointerEvent): void {
      const dx = e.clientX - h.left - h.ox;
      const dy = e.clientY - h.top - h.oy;
      h.ax = stickAxes(dx, dy, h.radius, h.params);
      paintKnob(el, dx, dy, h.radius);
    }

    function moveDpad(h: DpadHold, e: PointerEvent): void {
      const next = dpadMask(e.clientX - h.cx, e.clientY - h.cy, h.half, h.diagonals);
      const added = (next & ~h.bits) !== 0;
      h.bits = next;
      paintDpad(h.cid, next);
      if (added) {
        haptic();
        latchPress();
      }
    }

    function playMove(e: PointerEvent): void {
      const h = holds.get(e.pointerId);
      if (!h || h.kind === 'btn') return;
      const el = elems.get(h.cid);
      if (!el) return;
      if (h.kind === 'stick') moveStick(h, el, e);
      else moveDpad(h, e);
      requestFlush();
    }

    function endHold(h: Hold): void {
      if (h.kind === 'btn') {
        const n = (fingers.get(h.cid) ?? 0) - 1;
        if (n > 0) fingers.set(h.cid, n);
        else fingers.delete(h.cid);
        paintButton(h.cid);
        syncTurbo();
      } else if (h.kind === 'stick') {
        const el = elems.get(h.cid);
        if (el) resetStickVisual(el);
        const t = now();
        if (!h.click && t - h.downAt <= DOUBLE_TAP_MS) lastTapEnd.set(h.cid, t);
      } else {
        paintDpad(h.cid, 0);
      }
    }

    function playEnd(e: PointerEvent): void {
      const h = holds.get(e.pointerId);
      if (!h) return;
      holds.delete(e.pointerId);
      endHold(h);
      requestFlush();
    }

    /** Release every control. Does not send anything by itself. */
    function releaseAll(): void {
      latch = null;
      holds.clear();
      fingers.clear();
      latched.clear();
      lastTapEnd.clear();
      syncTurbo();
      for (const el of fieldEl.querySelectorAll('.is-down')) {
        el.classList.remove('is-down');
        if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', 'false');
      }
      for (const el of fieldEl.querySelectorAll<HTMLElement>('.ctl-stick')) resetStickVisual(el);
    }

    /** Safety release: drop everything and tell the host right now (rAF may never run again, e.g. page hidden). */
    function neutralise(): void {
      releaseAll();
      flushNow();
    }

    // ---- Sending ----
    let ws: WebSocket | null = null;
    let welcomed = false;
    let lastSent: Pad | null = null;
    let lastFrameTs: number | null = null;
    let rafId = 0;
    let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

    function canSend(): boolean {
      return ws !== null && ws.readyState === WS_OPEN && welcomed;
    }

    function sendFrame(frame: object): boolean {
      if (!ws) return false;
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        return false;
      }
      armKeepalive();
      return true;
    }

    /** A keepalive is due 500 ms after the last frame of any kind, and then every 500 ms of silence. */
    function armKeepalive(): void {
      if (keepaliveTimer !== null) clearTimeout(keepaliveTimer);
      keepaliveTimer = setTimeout(() => {
        keepaliveTimer = null;
        if (canSend()) sendFrame({ t: 'k' });
      }, KEEPALIVE_MS);
    }

    function stopKeepalive(): void {
      if (keepaliveTimer !== null) clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }

    function sendPad(pad: Pad): void {
      if (sendFrame({ t: 's', b: pad.b, lt: pad.lt, rt: pad.rt, lx: pad.lx, ly: pad.ly, rx: pad.rx, ry: pad.ry })) lastSent = pad;
    }

    function requestFlush(): void {
      if (rafId === 0 && !destroyed) rafId = requestAnimationFrame(onFrame);
    }

    function onFrame(ts: number): void {
      rafId = 0;
      if (!canSend()) {
        latch = null; // the welcome handler sends the current state
        return;
      }
      if (lastFrameTs !== null && ts - lastFrameTs < MIN_FRAME_MS) {
        requestFlush();
        return;
      }
      const pad = readPad();
      const pressed = latch;
      latch = null;
      // A press and its release can land between two frames (a janky main thread delivers both events in one task).
      // Send the pressed state first so the host sees it for one frame; the release follows on the next frame.
      if (pressed && !coversPress(pad, pressed) && !samePad(lastSent, pressed)) {
        sendPad(pressed);
        lastFrameTs = ts;
        requestFlush();
        return;
      }
      if (samePad(lastSent, pad)) return;
      sendPad(pad);
      lastFrameTs = ts;
    }

    /** Send the current state immediately if it differs from what the host has. Bypasses the frame throttle. */
    function flushNow(): void {
      if (!canSend()) return;
      const pad = readPad();
      if (!samePad(lastSent, pad)) sendPad(pad);
    }

    // ---- Connection ----
    const number = (() => {
      const stored = Number.parseInt(storageGet(NAME_KEY) ?? '', 10);
      if (Number.isInteger(stored) && stored >= 10 && stored <= 99) return stored;
      const fresh = 10 + Math.floor(Math.random() * 90);
      storageSet(NAME_KEY, String(fresh));
      return fresh;
    })();
    const name = playerName(navigator.userAgent, navigator.maxTouchPoints ?? 0, number);
    let attempt = 0;
    let everDropped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function render(): void {
      const text = statusText(phase, slot);
      statusEl.textContent = text;
      strip.dataset['state'] = phase;
      const blocked = phase === 'notoken' || phase === 'full' || phase === 'kicked';
      const layoutFailed = !blocked && layoutState === 'failed';
      noticeEl.hidden = !(blocked || layoutFailed);
      noticeText.textContent = blocked ? text : layoutFailed ? 'Cannot load your layout' : '';
      retryBtn.hidden = !(phase === 'full' || layoutFailed);
      const usable = !blocked && layoutState === 'ready';
      editBtn.hidden = !usable || mode === 'edit';
      layoutPick.hidden = !usable || mode === 'edit' || !store || store.layouts.length < 2;
    }

    function setPhase(next: Phase): void {
      phase = next;
      render();
    }

    function connect(): void {
      if (destroyed || !token || phase === 'full' || phase === 'kicked') return;
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
      sock.onopen = () => {
        if (sock !== ws) return;
        try {
          sock.send(JSON.stringify({ t: 'hello', name }));
        } catch {
          /* the close event follows */
        }
      };
      sock.onmessage = (ev: MessageEvent) => {
        if (sock !== ws) return;
        const msg = parseServerMessage(ev.data);
        if (!msg) return;
        if (msg.t === 'welcome') {
          welcomed = true;
          slot = msg.slot;
          attempt = 0;
          everDropped = false;
          lastSent = null;
          setPhase('connected');
          flushNow();
        } else {
          // 'full' and 'kicked' are final: no reconnect until the user asks (full) or the host re-adds the phone.
          releaseAll();
          setPhase(msg.t);
          sock.close();
        }
      };
      sock.onclose = () => {
        if (sock !== ws) return;
        ws = null;
        welcomed = false;
        slot = null;
        lastSent = null;
        stopKeepalive();
        releaseAll();
        if (phase === 'full' || phase === 'kicked') return;
        everDropped = true;
        setPhase('retrying');
        scheduleReconnect();
      };
      // onerror needs no handling: a failed socket always fires close next.
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

    /** Come back to the foreground (or the network returned): do not wait out the backoff. */
    function reconnectNow(): void {
      if (destroyed || !token || phase === 'full' || phase === 'kicked' || welcomed) return;
      if (ws && ws.readyState === 0) return; // an attempt is already in flight
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
        const res = await fetch(path + '?t=' + encodeURIComponent(token), init);
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
      syncField(true);
      renderPicker();
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

    // ---- Saving ----
    let saveState: SaveState = 'idle';
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let savedHideTimer: ReturnType<typeof setTimeout> | null = null;
    let saving = false;
    let resave = false;
    let lastError = '';

    const SAVE_TEXT: Record<SaveState, string> = { idle: '', saving: 'Saving…', saved: 'Saved on the host PC', error: 'Not saved, retry' };

    function setSave(next: SaveState): void {
      saveState = next;
      if (savedHideTimer !== null) clearTimeout(savedHideTimer);
      savedHideTimer = null;
      const text = SAVE_TEXT[next];
      saveEl.textContent = text;
      saveEl.hidden = next === 'idle';
      saveRetry.hidden = next !== 'error';
      panelSave.textContent = text;
      panelSave.hidden = next === 'idle';
      panelSave.disabled = next !== 'error';
      panelSave.title = next === 'error' ? lastError : '';
      saveRetry.title = next === 'error' ? lastError : '';
      if (next === 'saved') {
        savedHideTimer = setTimeout(() => {
          savedHideTimer = null;
          if (saveState === 'saved') {
            saveEl.hidden = true;
          }
        }, SAVED_VISIBLE_MS);
      }
    }

    function scheduleSave(delay: number = SAVE_DEBOUNCE_MS): void {
      if (saveTimer !== null) clearTimeout(saveTimer);
      setSave('saving');
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void save();
      }, delay);
    }

    async function save(): Promise<void> {
      if (!store || destroyed) return;
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      if (saving) {
        resave = true;
        return;
      }
      saving = true;
      setSave('saving');
      const sentRev = rev;
      const r = await api('PUT', '/api/layouts', store);
      saving = false;
      if (destroyed) return;
      if (!r.ok) {
        lastError = httpMessage(r.status);
        setSave('error');
        resave = false;
        return;
      }
      if (rev === sentRev) {
        const s = coerceStore(r.body);
        if (s) adopt(s);
        setSave('saved');
      }
      if (resave || rev !== sentRev) {
        resave = false;
        if (saveTimer === null) void save();
      }
    }

    /** The host's sanitized store is the truth: show it (without touching the editor panel the user may be using). */
    function adopt(s: LayoutStore): void {
      if (!store) return;
      const layoutChanged = s.activeId !== store.activeId;
      store = s;
      if (selectedId && !activeLayout(s).controls.some((c) => c.id === selectedId)) selectedId = null;
      syncField(layoutChanged);
      renderPicker();
      render();
    }

    // ---- Edits (the only place the store changes while editing) ----
    function updateUndo(): void {
      undoBtn.disabled = history.past.length === 0;
    }

    /**
     * Replace the store with an edited one. `key` groups the many small edits of one gesture (a drag, a slider) into one undo step.
     * Edits that change structure rebuild the panel; keyed ones keep it, because rebuilding would destroy the slider under the finger.
     */
    function edit(next: LayoutStore, key: string | null = null): void {
      if (!store || next === store) return;
      const prevActive = store.activeId;
      history = recordEdit(history, store, key);
      store = next;
      rev += 1;
      const layoutChanged = next.activeId !== prevActive;
      if (layoutChanged || (selectedId && !activeLayout(next).controls.some((c) => c.id === selectedId))) selectedId = null;
      syncField(layoutChanged);
      if (key === null) {
        renderPicker();
        render();
        buildPanel();
      }
      updateUndo();
      scheduleSave();
    }

    function endEditGesture(): void {
      history = endGesture(history);
    }

    function doUndo(): void {
      if (!store) return;
      const r = undo(history);
      if (!r) return;
      const layoutChanged = r.store.activeId !== store.activeId;
      history = r.history;
      store = r.store;
      rev += 1;
      if (layoutChanged || (selectedId && !activeLayout(store).controls.some((c) => c.id === selectedId))) selectedId = null;
      syncField(layoutChanged);
      renderPicker();
      render();
      updateUndo();
      buildPanel();
      scheduleSave();
    }

    /** Preset switch from the status strip during play. */
    function switchPreset(id: string): void {
      if (!store) return;
      releaseAll();
      flushNow();
      const next = switchLayout(store, id);
      if (next === store) return;
      store = next;
      rev += 1;
      syncField(true);
      renderPicker();
      render();
      scheduleSave(400);
    }

    function renderPicker(): void {
      layoutPick.textContent = '';
      if (!store) return;
      for (const l of store.layouts) {
        const o = document.createElement('option');
        o.value = l.id;
        o.textContent = l.name;
        layoutPick.appendChild(o);
      }
      layoutPick.value = store.activeId;
    }

    // ---- Edit mode ----
    let drag: EditDrag | null = null;
    let editTimer: ReturnType<typeof setTimeout> | null = null;

    function enterEdit(): void {
      if (mode === 'edit' || layoutState !== 'ready' || !store || phase === 'notoken' || phase === 'full' || phase === 'kicked') return;
      neutralise(); // the pad stays neutral for as long as we edit: only keepalives go out
      mode = 'edit';
      document.body.classList.add('editing');
      fieldEl.classList.add('is-editing');
      history = emptyHistory();
      selectedId = null;
      tab = 'control';
      panel.hidden = false;
      setCollapsed(true); // start with just the header so the whole screen can be tapped; selecting a control opens the panel
      updateUndo();
      syncField(false);
      buildPanel();
      render();
    }

    function exitEdit(): void {
      if (mode !== 'edit') return;
      mode = 'play';
      drag = null;
      document.body.classList.remove('editing');
      fieldEl.classList.remove('is-editing');
      panel.hidden = true;
      selectedId = null;
      endEditGesture();
      syncField(false);
      render();
      if (saveState !== 'idle' && saveState !== 'saved') void save();
    }

    function setCollapsed(collapsed: boolean): void {
      panelBody.hidden = collapsed;
      panel.classList.toggle('collapsed', collapsed);
      collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      collapseBtn.textContent = collapsed ? 'Panel' : 'Hide';
    }

    /** Select a control (or nothing). The panel opens on the side away from the selected control so it never covers it. */
    function select(id: string | null): void {
      if (id === selectedId) return;
      selectedId = id;
      updateSelection();
      const c = id ? controls.get(id) : undefined;
      if (c) {
        tab = 'control';
        panel.classList.toggle('panel-left', c.x > 50);
        setCollapsed(false);
      }
      buildPanel();
    }

    function editDown(e: PointerEvent): void {
      if (drag) return;
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest<HTMLElement>('[data-cid]');
      const c = el ? controls.get(el.dataset['cid'] ?? '') : undefined;
      if (!el || !c) {
        select(null);
        return;
      }
      e.preventDefault();
      select(c.id);
      const m = fieldMetrics();
      const px = ((e.clientX - m.left) / m.w) * 100;
      const py = ((e.clientY - m.top) / m.h) * 100;
      const resizing = target?.closest('[data-handle]') !== null && target?.closest('[data-handle]') !== undefined;
      drag = { pointerId: e.pointerId, kind: resizing ? 'resize' : 'move', id: c.id, ox: c.x - px, oy: c.y - py };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* see playDown */
      }
    }

    function editMove(e: PointerEvent): void {
      if (!store || !drag || drag.pointerId !== e.pointerId) return;
      const c = controls.get(drag.id);
      if (!c) return;
      const m = fieldMetrics();
      if (drag.kind === 'move') {
        const px = ((e.clientX - m.left) / m.w) * 100;
        const py = ((e.clientY - m.top) / m.h) * 100;
        edit(moveControl(store, c.id, px + drag.ox, py + drag.oy, m.w / m.h), 'move:' + c.id);
      } else {
        const unit = m.h / 100;
        const wPct = (2 * (e.clientX - (m.left + (c.x / 100) * m.w))) / unit;
        const hPct = (2 * (e.clientY - (m.top + (c.y / 100) * m.h))) / unit;
        edit(resizeControl(store, c.id, sizeFromHandle(c, wPct, hPct), m.w / m.h), 'resize:' + c.id);
      }
    }

    function editEnd(e: PointerEvent): void {
      if (!drag || drag.pointerId !== e.pointerId) return;
      const wasResize = drag.kind === 'resize';
      drag = null;
      endEditGesture();
      if (wasResize) buildPanel(); // the size sliders must show the new size
    }

    // ---- Editor panel (DOM built with createElement only) ----
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    };

    function say(msg: string): void {
      panelMsg.textContent = msg;
    }

    function sliderRow(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
      const row = el('label', 'row');
      row.appendChild(el('span', 'row-label', label));
      const out = el('output', 'row-value', fmt(value));
      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        onInput(v);
      });
      input.addEventListener('change', endEditGesture);
      row.append(input, out);
      return row;
    }

    function checkRow(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
      const row = el('label', 'row row-check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = value;
      input.addEventListener('change', () => onChange(input.checked));
      row.append(input, el('span', 'row-label', label));
      return row;
    }

    function selectRow(label: string, options: ReadonlyArray<readonly [string, string]>, value: string, onChange: (v: string) => void): HTMLElement {
      const row = el('label', 'row');
      row.appendChild(el('span', 'row-label', label));
      const sel = el('select', 'row-select');
      for (const [v, text] of options) {
        const o = el('option', '', text);
        o.value = v;
        sel.appendChild(o);
      }
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      row.appendChild(sel);
      return row;
    }

    function textRow(label: string, value: string, maxLength: number, onCommit: (v: string) => void): HTMLElement {
      const row = el('label', 'row');
      row.appendChild(el('span', 'row-label', label));
      const input = el('input', 'row-text');
      input.type = 'text';
      input.maxLength = maxLength;
      input.value = value;
      input.autocomplete = 'off';
      input.addEventListener('change', () => onCommit(input.value));
      input.addEventListener('blur', updateUnit);
      row.appendChild(input);
      return row;
    }

    function actionButton(label: string, onClick: () => void, disabled = false, danger = false): HTMLButtonElement {
      const b = el('button', 'panel-btn' + (danger ? ' danger' : ''), label);
      b.type = 'button';
      b.disabled = disabled;
      b.addEventListener('click', onClick);
      return b;
    }

    const pct = (v: number): string => (Math.round(v * 10) / 10).toString();
    const two = (v: number): string => v.toFixed(2);

    function buildPanel(): void {
      if (mode !== 'edit') return;
      for (const t of panel.querySelectorAll<HTMLElement>('.tab')) t.setAttribute('aria-selected', t.dataset['tab'] === tab ? 'true' : 'false');
      panelContent.textContent = '';
      say('');
      if (!store) return;
      if (tab === 'control') buildControlTab();
      else if (tab === 'add') buildAddTab();
      else buildLayoutTab();
    }

    function setProp(id: string, key: string, value: unknown, gesture: boolean): void {
      if (!store) return;
      edit(patchControl(store, id, { [key]: value }), gesture ? `prop:${id}:${key}` : null);
    }

    function buildControlTab(): void {
      const c = selectedId ? controls.get(selectedId) : undefined;
      if (!c) {
        panelContent.appendChild(el('p', 'panel-hint', 'Tap a control to edit it. Drag to move, drag the corner handle to resize.'));
        return;
      }
      const id = c.id;
      const title = c.type === 'button' ? BUTTON_ARIA[c.button] : c.type === 'stick' ? (c.stick === 'left' ? 'Left' : 'Right') + ' stick' : 'D-pad';
      panelContent.appendChild(el('h3', 'panel-title', title));
      const slider = (label: string, key: string, lo: number, hi: number, step: number, value: number, fmt: (v: number) => string = pct): void => {
        panelContent.appendChild(sliderRow(label, lo, hi, step, value, fmt, (v) => setProp(id, key, v, true)));
      };
      const check = (label: string, key: string, value: boolean): void => {
        panelContent.appendChild(checkRow(label, value, (v) => setProp(id, key, v, false)));
      };
      const choice = (label: string, key: string, options: ReadonlyArray<readonly [string, string]>, value: string, rebuild = false): void => {
        panelContent.appendChild(
          selectRow(label, options, value, (v) => {
            setProp(id, key, v, false);
            if (rebuild) buildPanel();
          }),
        );
      };
      if (c.type === 'stick') {
        slider('Size', 'size', LIMITS.size.min, LIMITS.size.max, 1, c.size);
        choice('Stick', 'stick', [['left', 'Left'], ['right', 'Right']], c.stick);
        choice('Mode', 'mode', [['fixed', 'Fixed'], ['floating', 'Floating']], c.mode);
        slider('Dead zone', 'deadzone', LIMITS.deadzone.min, LIMITS.deadzone.max, 0.01, c.deadzone, two);
        slider('Sensitivity', 'sensitivity', LIMITS.sensitivity.min, LIMITS.sensitivity.max, 0.05, c.sensitivity, two);
        choice('Curve', 'curve', [['linear', 'Linear'], ['precise', 'Precise'], ['aggressive', 'Aggressive']], c.curve);
        check('Invert X', 'invertX', c.invertX);
        check('Invert Y', 'invertY', c.invertY);
        check('Double-tap = stick click', 'doubleTapClick', c.doubleTapClick);
      } else if (c.type === 'dpad') {
        slider('Size', 'size', LIMITS.size.min, LIMITS.size.max, 1, c.size);
        check('Diagonals', 'diagonals', c.diagonals);
      } else {
        choice('Button', 'button', BUTTON_NAMES.map((n) => [n, n] as const), c.button, true);
        slider('Width', 'w', LIMITS.size.min, LIMITS.size.max, 1, c.w);
        slider('Height', 'h', LIMITS.size.min, LIMITS.size.max, 1, c.h);
        choice('Shape', 'shape', [['circle', 'Circle'], ['rect', 'Rectangle'], ['pill', 'Pill']], c.shape);
        panelContent.appendChild(textRow('Label', c.label, LIMITS.labelChars, (v) => setProp(id, 'label', v, false)));
        check('Latch (tap on, tap off)', 'latch', c.latch);
        check('Turbo (rapid fire)', 'turbo', c.turbo);
        if (c.button === 'LT' || c.button === 'RT') slider('Trigger value', 'value', LIMITS.value.min, LIMITS.value.max, 1, c.value, (v) => String(Math.round(v)));
      }
      slider('Opacity', 'opacity', LIMITS.opacity.min, LIMITS.opacity.max, 0.05, c.opacity, two);
      const actions = el('div', 'panel-actions');
      actions.appendChild(
        actionButton(
          'Duplicate',
          () => {
            if (!store) return;
            const r = duplicateControl(store, id, aspect());
            if (r.id === null) return say(`At most ${LIMITS.controls} controls per layout.`);
            edit(r.store);
            select(r.id);
          },
          !canAddControl(store as LayoutStore),
        ),
      );
      actions.appendChild(
        actionButton(
          'Delete',
          () => {
            if (store) edit(deleteControl(store, id));
          },
          false,
          true,
        ),
      );
      panelContent.appendChild(actions);
    }

    function buildAddTab(): void {
      if (!store) return;
      const full = !canAddControl(store);
      let chosen: ButtonName = 'A';
      const addOne = (kind: NewKind): void => {
        if (!store) return;
        const r = addControl(store, kind, aspect());
        if (r.id === null) return say(`At most ${LIMITS.controls} controls per layout.`);
        edit(r.store);
        select(r.id);
        say('');
      };
      panelContent.appendChild(el('p', 'panel-hint', `${activeLayout(store).controls.length} of ${LIMITS.controls} controls used.`));
      const row = el('div', 'panel-actions');
      const pick = el('select', 'row-select');
      pick.setAttribute('aria-label', 'Button to add');
      for (const n of BUTTON_NAMES) {
        const o = el('option', '', BUTTON_ARIA[n]);
        o.value = n;
        pick.appendChild(o);
      }
      pick.addEventListener('change', () => {
        chosen = pick.value as ButtonName;
      });
      row.append(pick, actionButton('Add button', () => addOne(chosen), full));
      panelContent.appendChild(row);
      const row2 = el('div', 'panel-actions');
      row2.append(actionButton('Add stick', () => addOne('stick'), full), actionButton('Add d-pad', () => addOne('dpad'), full));
      panelContent.appendChild(row2);
      if (full) say(`At most ${LIMITS.controls} controls per layout.`);
    }

    let armedDelete: ReturnType<typeof setTimeout> | null = null;

    function buildLayoutTab(): void {
      if (!store) return;
      const layout = activeLayout(store);
      const s = store;
      panelContent.appendChild(
        selectRow(
          'Active layout',
          s.layouts.map((l) => [l.id, l.name] as const),
          s.activeId,
          (id) => edit(switchLayout(s, id)),
        ),
      );
      panelContent.appendChild(textRow('Name', layout.name, LIMITS.nameChars, (v) => edit(renameLayout(s, layout.id, v))));
      panelContent.appendChild(checkRow('Vibrate on button press', layout.haptics, (v) => edit(setHaptics(s, layout.id, v))));
      panelContent.appendChild(el('p', 'panel-hint', `${s.layouts.length} of ${LIMITS.layouts} layouts.`));
      const atLimit = s.layouts.length >= LIMITS.layouts;
      const grid = el('div', 'panel-actions wrap');
      grid.appendChild(actionButton('New (blank)', () => edit(newBlankLayout(s)), atLimit));
      grid.appendChild(
        actionButton(
          'New from default',
          () => {
            say('Loading the default layout…');
            void getDefaultLayout().then((def) => {
              if (!def) return say('Cannot load the default layout');
              if (store) edit(newLayoutFrom(store, def));
            });
          },
          atLimit,
        ),
      );
      grid.appendChild(actionButton('Duplicate', () => edit(duplicateLayout(s, layout.id)), atLimit));
      grid.appendChild(
        actionButton(
          'Reset to default',
          () => {
            say('Loading the default layout…');
            void getDefaultLayout().then((def) => {
              if (!def) return say('Cannot load the default layout');
              if (store) edit(resetLayout(store, activeLayout(store).id, def));
            });
          },
        ),
      );
      const del = actionButton('Delete layout', () => {
        if (!armedDelete) {
          del.textContent = 'Tap again to delete';
          armedDelete = setTimeout(() => {
            armedDelete = null;
            del.textContent = 'Delete layout';
          }, 3000);
          return;
        }
        clearTimeout(armedDelete);
        armedDelete = null;
        if (store) edit(deleteLayout(store, layout.id));
      }, s.layouts.length <= 1, true);
      grid.appendChild(del);
      panelContent.appendChild(grid);
    }

    // ---- Orientation ----
    const portraitQuery = typeof matchMedia === 'function' ? matchMedia('(orientation: portrait)') : null;
    const isPortrait = (): boolean => (portraitQuery ? portraitQuery.matches : window.innerHeight > window.innerWidth);
    portrait = isPortrait();
    function onOrientation(): void {
      updateUnit();
      const p = isPortrait();
      if (p === portrait) return;
      portrait = p;
      if (p) neutralise();
    }

    // ---- Full screen ----
    type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => Promise<void> | void };
    type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    const fsDoc = document as FsDoc;
    const fsRoot = document.documentElement as FsEl;
    const fullscreenElement = (): Element | null => document.fullscreenElement ?? fsDoc.webkitFullscreenElement ?? null;

    function paintFullscreen(): void {
      fsBtn.setAttribute('aria-label', fullscreenElement() !== null ? 'Exit full screen' : 'Enter full screen');
    }

    async function toggleFullscreen(): Promise<void> {
      try {
        if (fullscreenElement()) {
          if (typeof document.exitFullscreen === 'function') await document.exitFullscreen();
          else if (typeof fsDoc.webkitExitFullscreen === 'function') await fsDoc.webkitExitFullscreen();
          return;
        }
        if (typeof fsRoot.requestFullscreen === 'function') await fsRoot.requestFullscreen();
        else if (typeof fsRoot.webkitRequestFullscreen === 'function') await fsRoot.webkitRequestFullscreen();
        const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
        if (orientation && typeof orientation.lock === 'function') await orientation.lock('landscape');
      } catch {
        /* denied, unsupported, or the orientation lock is not allowed here: the pad still works */
      }
    }

    if (document.fullscreenEnabled || fsDoc.webkitFullscreenEnabled) {
      fsBtn.hidden = false;
      paintFullscreen();
    }

    // ---- Wake lock and the screen-timeout hint ----
    interface Sentinel {
      released?: boolean;
      release(): Promise<void>;
    }
    let sentinel: Sentinel | null = null;
    let hintShown = false;
    let hintTimer: ReturnType<typeof setTimeout> | null = null;

    function hideHint(): void {
      hintEl.hidden = true;
      if (hintTimer !== null) clearTimeout(hintTimer);
      hintTimer = null;
    }

    /** One line, once per device: the screen may turn off mid-game if the wake lock is not available. */
    function showHintOnce(): void {
      if (hintShown) return;
      hintShown = true;
      if (storageGet(HINT_KEY) === '1') return;
      storageSet(HINT_KEY, '1');
      hintEl.hidden = false;
      hintTimer = setTimeout(hideHint, HINT_VISIBLE_MS);
    }

    async function acquireWakeLock(): Promise<void> {
      const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }).wakeLock;
      if (!wl) {
        showHintOnce();
        return;
      }
      try {
        sentinel = await wl.request('screen');
      } catch {
        showHintOnce();
      }
    }

    // ---- Wiring ----
    fieldEl.addEventListener('pointerdown', (e) => (mode === 'edit' ? editDown(e) : playDown(e)), on);
    fieldEl.addEventListener('pointermove', (e) => (mode === 'edit' ? editMove(e) : playMove(e)), on);
    fieldEl.addEventListener('pointerup', (e) => (mode === 'edit' ? editEnd(e) : playEnd(e)), on);
    // A cancelled pointer (system gesture, palm rejection) is a reason to distrust everything: release all.
    fieldEl.addEventListener('pointercancel', (e) => (mode === 'edit' ? editEnd(e) : neutralise()), on);
    fieldEl.addEventListener('lostpointercapture', (e) => (mode === 'edit' ? editEnd(e) : playEnd(e)), on);

    document.addEventListener('contextmenu', (e) => e.preventDefault(), on);
    document.addEventListener('selectstart', (e) => (e.target instanceof HTMLInputElement ? undefined : e.preventDefault()), on);
    document.addEventListener('dragstart', (e) => e.preventDefault(), on);
    // iOS Safari still pinch-zooms and scrolls despite touch-action: none and user-scalable=no. The editor panel must keep scrolling.
    document.addEventListener(
      'touchmove',
      (e) => {
        if (!(e.target instanceof Element && e.target.closest('.panel-body'))) e.preventDefault();
      },
      { passive: false, signal: ac.signal },
    );
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false, signal: ac.signal });

    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') {
          neutralise();
          if (saveState === 'saving' || saveState === 'error') void save(); // best effort before the page may be frozen
        } else {
          reconnectNow();
          if (!sentinel || sentinel.released) void acquireWakeLock();
        }
      },
      on,
    );
    window.addEventListener('blur', neutralise, on);
    window.addEventListener('pagehide', neutralise, on);
    window.addEventListener('online', reconnectNow, on);
    window.addEventListener('resize', onOrientation, on);
    window.addEventListener('orientationchange', onOrientation, on);
    window.visualViewport?.addEventListener('resize', updateUnit, on);
    portraitQuery?.addEventListener('change', onOrientation, on);

    fsBtn.addEventListener('click', () => void toggleFullscreen(), on);
    document.addEventListener('fullscreenchange', paintFullscreen, on);
    document.addEventListener('webkitfullscreenchange', paintFullscreen, on);
    hintClose.addEventListener('click', hideHint, on);
    retryBtn.addEventListener(
      'click',
      () => {
        if (phase === 'full') {
          attempt = 0;
          everDropped = false;
          setPhase('connecting');
          connect();
        } else if (layoutState === 'failed') {
          void loadLayouts();
        }
      },
      on,
    );

    // The Edit button needs a deliberate 600 ms press so it cannot be hit by accident during play.
    const cancelEditHold = (): void => {
      if (editTimer !== null) clearTimeout(editTimer);
      editTimer = null;
      editBtn.classList.remove('is-arming');
    };
    editBtn.addEventListener(
      'pointerdown',
      () => {
        if (editTimer !== null) return;
        editBtn.classList.add('is-arming');
        editTimer = setTimeout(() => {
          editTimer = null;
          editBtn.classList.remove('is-arming');
          enterEdit();
        }, EDIT_HOLD_MS);
      },
      on,
    );
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) editBtn.addEventListener(type, cancelEditHold, on);
    // Keyboard and assistive technology activate with a click that has no pointer behind it (detail 0).
    editBtn.addEventListener('click', (e) => (e.detail === 0 ? enterEdit() : undefined), on);

    layoutPick.addEventListener('change', () => switchPreset(layoutPick.value), on);
    saveRetry.addEventListener('click', () => void save(), on);
    panelSave.addEventListener('click', () => void save(), on);
    doneBtn.addEventListener(
      'click',
      () => {
        exitEdit();
      },
      on,
    );
    undoBtn.addEventListener('click', doUndo, on);
    collapseBtn.addEventListener('click', () => setCollapsed(!panelBody.hidden), on);
    for (const t of panel.querySelectorAll<HTMLElement>('.tab')) {
      t.addEventListener(
        'click',
        () => {
          tab = (t.dataset['tab'] as Tab | undefined) ?? 'control';
          buildPanel();
        },
        on,
      );
    }

    updateUnit();
    render();
    if (token) {
      void acquireWakeLock();
      connect();
      void loadLayouts();
    }

    return {
      destroy(): void {
        destroyed = true;
        ac.abort();
        stopKeepalive();
        for (const t of [reconnectTimer, hintTimer, saveTimer, savedHideTimer, editTimer, armedDelete]) if (t !== null) clearTimeout(t);
        if (turboTimer !== null) clearInterval(turboTimer);
        if (rafId !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
        const sock = ws;
        ws = null;
        sock?.close();
        void sentinel?.release().catch(() => undefined);
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
      MIN_FRAME_MS,
      KEEPALIVE_MS,
      DOUBLE_TAP_MS,
      FLOATING_ZONE,
      UNDO_STEPS,
      // layout store
      coerceStore,
      activeLayout,
      newBlankLayout,
      newLayoutFrom,
      duplicateLayout,
      renameLayout,
      deleteLayout,
      switchLayout,
      cycleLayout,
      resetLayout,
      setHaptics,
      addControl,
      moveControl,
      resizeControl,
      duplicateControl,
      deleteControl,
      patchControl,
      canAddControl,
      sizeFromHandle,
      halfExtent,
      applyProps,
      // history
      emptyHistory,
      recordEdit,
      endGesture,
      undo,
      // pad maths
      stickAxes,
      limitToRadius,
      dpadMask,
      buttonMask,
      buildPad,
      samePad,
      mergePress,
      coversPress,
      isDoubleTap,
      // protocol
      backoffDelay,
      deviceLabel,
      playerName,
      wsUrl,
      parseServerMessage,
      statusText,
      httpMessage,
      boot,
    });
  } else {
    boot();
  }
})();
