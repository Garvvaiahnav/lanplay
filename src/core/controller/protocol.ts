// Phone-controller wire protocol (pure, no Node/Electron). The phone page sends small JSON text frames over a WebSocket;
// everything from the phone is untrusted: parseClientMessage clamps it into XInput ranges or rejects it.
//
// phone -> host
//   {"t":"hello","name":"Pixel 8"}                       first frame; the host answers with "welcome" or "full"
//   {"t":"s","b":<buttons>,"lt":0..255,"rt":0..255,"lx":..,"ly":..,"rx":..,"ry":..}   full pad state, sent on change (sticks <= ~125/s, hard cap 240/s; the host closes a socket above 300/s)
//   {"t":"k"}                                            keepalive, every ~500 ms while the state is unchanged
// host -> phone
//   {"t":"welcome","slot":1}    player number 1..4
//   {"t":"full"}                all slots taken; the socket is closed
//   {"t":"kicked"}              removed from the host screen; the socket is closed
// Stick axes use the XInput convention: right and UP are positive (sThumbLY > 0 means up).

/** XUSB_GAMEPAD button bits (Xbox 360 report). */
export const BTN = Object.freeze({
  DPAD_UP: 0x0001,
  DPAD_DOWN: 0x0002,
  DPAD_LEFT: 0x0004,
  DPAD_RIGHT: 0x0008,
  START: 0x0010,
  BACK: 0x0020,
  LEFT_THUMB: 0x0040,
  RIGHT_THUMB: 0x0080,
  LEFT_SHOULDER: 0x0100,
  RIGHT_SHOULDER: 0x0200,
  GUIDE: 0x0400,
  A: 0x1000,
  B: 0x2000,
  X: 0x4000,
  Y: 0x8000,
} as const);

export const ALLOWED_BUTTONS: number = Object.values(BTN).reduce((a, b) => a | b, 0);

export const MAX_PLAYERS = 4;
export const MAX_MESSAGE_CHARS = 512;
export const MAX_NAME_CHARS = 24;

/** One Xbox 360 report. */
export interface PadState {
  buttons: number;
  /** 0..255 */
  lt: number;
  rt: number;
  /** -32768..32767, up and right positive */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

export const NEUTRAL_PAD: Readonly<PadState> = Object.freeze({ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
export const neutralPad = (): PadState => ({ ...NEUTRAL_PAD });

export type ClientMessage = { t: 'hello'; name: string } | { t: 's'; pad: PadState } | { t: 'k' };
export type ServerMessage = { t: 'welcome'; slot: number } | { t: 'full' } | { t: 'kicked' };

export function sanitizePlayerName(v: unknown): string {
  if (typeof v !== 'string') return 'Phone';
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_CHARS).trim();
  return s || 'Phone';
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));

export function parseClientMessage(raw: string): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_CHARS) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  switch (o['t']) {
    case 'hello':
      return { t: 'hello', name: sanitizePlayerName(o['name']) };
    case 'k':
      return { t: 'k' };
    case 's':
      return {
        t: 's',
        pad: {
          buttons: Math.trunc(num(o['b'])) & ALLOWED_BUTTONS,
          lt: clamp(num(o['lt']), 0, 255),
          rt: clamp(num(o['rt']), 0, 255),
          lx: clamp(num(o['lx']), -32768, 32767),
          ly: clamp(num(o['ly']), -32768, 32767),
          rx: clamp(num(o['rx']), -32768, 32767),
          ry: clamp(num(o['ry']), -32768, 32767),
        },
      };
    default:
      return null;
  }
}
