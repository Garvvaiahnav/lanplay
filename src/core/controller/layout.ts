// Phone-controller layouts and presets (pure). The phone page edits them; the host stores them per phone IP and serves them back.
// Everything that arrives from a phone goes through sanitizeStore(): it never throws, clamps every number, drops what it does not
// know and always returns a usable store. Coordinates: x and y are the control CENTER in percent of the screen width / height
// (0..100); size, w and h are percent of the screen HEIGHT, so a control keeps its shape on any phone.

export const DEFAULT_LAYOUT_ID = 'default';

export const LIMITS = Object.freeze({
  layouts: 20,
  controls: 40,
  nameChars: 32,
  labelChars: 6,
  /** Largest stored JSON per phone (bytes); the HTTP layer enforces it before parsing. */
  maxStoreBytes: 256 * 1024,
  size: { min: 4, max: 80 },
  deadzone: { min: 0, max: 0.5 },
  sensitivity: { min: 0.25, max: 3 },
  opacity: { min: 0.1, max: 1 },
  value: { min: 1, max: 255 },
} as const);

export const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'START', 'BACK', 'L3', 'R3'] as const;
export type ButtonName = (typeof BUTTON_NAMES)[number];
export const CURVES = ['linear', 'precise', 'aggressive'] as const;
export type Curve = (typeof CURVES)[number];
export const SHAPES = ['circle', 'rect', 'pill'] as const;
export type Shape = (typeof SHAPES)[number];

interface BaseControl {
  id: string;
  x: number;
  y: number;
  opacity: number;
}
export interface StickControl extends BaseControl {
  type: 'stick';
  stick: 'left' | 'right';
  size: number;
  /** fixed = base stays where it is; floating = base appears under the first touch inside the control area. */
  mode: 'fixed' | 'floating';
  /** Radial dead zone as a fraction of the stick radius. */
  deadzone: number;
  /** Output scale; > 1 reaches full deflection earlier. */
  sensitivity: number;
  curve: Curve;
  invertX: boolean;
  invertY: boolean;
  /** Double tap on the stick presses L3 (left) or R3 (right). */
  doubleTapClick: boolean;
}
export interface DpadControl extends BaseControl {
  type: 'dpad';
  size: number;
  diagonals: boolean;
}
export interface ButtonControl extends BaseControl {
  type: 'button';
  button: ButtonName;
  w: number;
  h: number;
  shape: Shape;
  label: string;
  /** Tap to hold, tap again to release. */
  latch: boolean;
  /** Rapid fire (about 10 presses a second) while held. */
  turbo: boolean;
  /** Trigger value 1..255 sent for LT / RT (ignored for other buttons). */
  value: number;
}
export type Control = StickControl | DpadControl | ButtonControl;

export interface Layout {
  id: string;
  name: string;
  /** Short vibration on button press (where the phone supports it). */
  haptics: boolean;
  controls: Control[];
}
export interface LayoutStore {
  version: 1;
  activeId: string;
  layouts: Layout[];
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const text = (v: unknown, max: number, fallback: string): string => {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max).trim();
  return s || fallback;
};
const ID_OK = /^[A-Za-z0-9_-]{1,40}$/;
const cleanId = (v: unknown): string => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) : '');
/** A safe id that is not in `used` (and records it). */
function uniqueId(v: unknown, fallback: string, used: Set<string>): string {
  let base = cleanId(v);
  if (!ID_OK.test(base)) base = fallback;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
  used.add(id);
  return id;
}

const pos = (v: unknown): number => round(clamp(v, 0, 100, 50), 2);
const dim = (v: unknown, fallback: number): number => round(clamp(v, LIMITS.size.min, LIMITS.size.max, fallback), 2);

function sanitizeControl(raw: unknown, index: number, used: Set<string>): Control | null {
  if (!isObj(raw)) return null;
  const base = (fallbackId: string) => ({
    id: uniqueId(raw['id'], fallbackId, used),
    x: pos(raw['x']),
    y: pos(raw['y']),
    opacity: round(clamp(raw['opacity'], LIMITS.opacity.min, LIMITS.opacity.max, 0.8), 2),
  });
  switch (raw['type']) {
    case 'stick': {
      const stick = pick(raw['stick'], ['left', 'right'] as const, 'left');
      return {
        ...base(`stick-${index}`),
        type: 'stick',
        stick,
        size: dim(raw['size'], 36),
        mode: pick(raw['mode'], ['fixed', 'floating'] as const, 'fixed'),
        deadzone: round(clamp(raw['deadzone'], LIMITS.deadzone.min, LIMITS.deadzone.max, 0.1), 3),
        sensitivity: round(clamp(raw['sensitivity'], LIMITS.sensitivity.min, LIMITS.sensitivity.max, 1), 3),
        curve: pick(raw['curve'], CURVES, 'linear'),
        invertX: bool(raw['invertX'], false),
        invertY: bool(raw['invertY'], false),
        doubleTapClick: bool(raw['doubleTapClick'], true),
      };
    }
    case 'dpad':
      return { ...base(`dpad-${index}`), type: 'dpad', size: dim(raw['size'], 26), diagonals: bool(raw['diagonals'], true) };
    case 'button': {
      if (!BUTTON_NAMES.includes(raw['button'] as ButtonName)) return null;
      const button = raw['button'] as ButtonName;
      return {
        ...base(`btn-${button.toLowerCase()}-${index}`),
        type: 'button',
        button,
        w: dim(raw['w'], 14),
        h: dim(raw['h'], 14),
        shape: pick(raw['shape'], SHAPES, 'circle'),
        label: text(raw['label'], LIMITS.labelChars, button),
        latch: bool(raw['latch'], false),
        turbo: bool(raw['turbo'], false),
        value: Math.round(clamp(raw['value'], LIMITS.value.min, LIMITS.value.max, 255)),
      };
    }
    default:
      return null;
  }
}

function sanitizeLayout(raw: unknown, index: number, usedLayoutIds: Set<string>): Layout | null {
  if (!isObj(raw)) return null;
  const id = uniqueId(raw['id'], `layout-${index + 1}`, usedLayoutIds);
  const usedControlIds = new Set<string>();
  const controls: Control[] = [];
  const list = Array.isArray(raw['controls']) ? raw['controls'] : [];
  for (let i = 0; i < list.length && controls.length < LIMITS.controls; i++) {
    const c = sanitizeControl(list[i], i, usedControlIds);
    if (c) controls.push(c);
  }
  return { id, name: text(raw['name'], LIMITS.nameChars, `Layout ${index + 1}`), haptics: bool(raw['haptics'], true), controls };
}

/** Standard Xbox arrangement for a landscape phone. */
export function defaultLayout(): Layout {
  const btn = (button: ButtonName, x: number, y: number, w: number, h: number, shape: Shape, label?: string): Raw => ({ id: `btn-${button.toLowerCase()}`, type: 'button', button, x, y, w, h, shape, ...(label ? { label } : {}) });
  const raw = {
    id: DEFAULT_LAYOUT_ID,
    name: 'Xbox',
    haptics: true,
    controls: [
      btn('LT', 9, 10, 17, 11, 'rect'),
      btn('LB', 9, 24, 17, 11, 'rect'),
      btn('RT', 91, 10, 17, 11, 'rect'),
      btn('RB', 91, 24, 17, 11, 'rect'),
      { id: 'stick-left', type: 'stick', stick: 'left', x: 15, y: 66, size: 40 },
      { id: 'dpad', type: 'dpad', x: 37, y: 82, size: 26 },
      { id: 'stick-right', type: 'stick', stick: 'right', x: 63, y: 82, size: 30 },
      btn('Y', 85, 46, 14, 14, 'circle'),
      btn('X', 77, 61, 14, 14, 'circle'),
      btn('B', 93, 61, 14, 14, 'circle'),
      btn('A', 85, 76, 14, 14, 'circle'),
      btn('BACK', 44, 12, 12, 7, 'pill', 'Back'),
      btn('START', 56, 12, 12, 7, 'pill', 'Start'),
    ],
  };
  return sanitizeLayout(raw, 0, new Set()) as Layout;
}

export function defaultStore(): LayoutStore {
  return { version: 1, activeId: DEFAULT_LAYOUT_ID, layouts: [defaultLayout()] };
}

/** Never throws; always returns a valid store (the default one for anything unusable). */
export function sanitizeStore(input: unknown): LayoutStore {
  if (!isObj(input)) return defaultStore();
  const used = new Set<string>();
  const layouts: Layout[] = [];
  const list = Array.isArray(input['layouts']) ? input['layouts'] : [];
  for (let i = 0; i < list.length && layouts.length < LIMITS.layouts; i++) {
    const l = sanitizeLayout(list[i], i, used);
    if (l) layouts.push(l);
  }
  if (layouts.length === 0) return defaultStore();
  const wanted = cleanId(input['activeId']);
  const activeId = layouts.some((l) => l.id === wanted) ? wanted : (layouts[0] as Layout).id;
  return { version: 1, activeId, layouts };
}
