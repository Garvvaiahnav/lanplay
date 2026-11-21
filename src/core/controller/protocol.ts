// Phone-controller wire protocol (pure, no Node/Electron). The phone page sends small JSON text frames over a WebSocket;
// everything from the phone is untrusted: parseClientMessage clamps it into XInput ranges or rejects it.
//
// phone -> host
//   {"t":"hello","name":"Pixel 8","id":"<phone id>"}     first frame; the host answers with "welcome" or "full"
//        id is optional: 16..32 characters of A-Z a-z 0-9 _ -  (anything else is dropped and the phone joins without an id).
//        The phone makes the id once, keeps it in its own storage and sends it on every connect. With an id the host
//        (1) keeps the player slot and the virtual pad for 15 s after the socket closes, so a short reconnect gets the same
//        player number and the game sees no unplug, and (2) files layouts under the id instead of the phone's IP.
//        A hello without an id still joins; its pad is released the moment the socket closes.
//        A second socket that says hello with an id that is already attached takes the slot over; the older socket is closed.
//   {"t":"s","b":<buttons>,"lt":0..255,"rt":0..255,"lx":..,"ly":..,"rx":..,"ry":..}   full pad state, sent on change (sticks <= ~125/s, hard cap 240/s; the host closes a socket above 300/s)
//   {"t":"k"}                                            keepalive, every ~500 ms while the state is unchanged
//   {"t":"p","n":<integer>}                              ping, ~1 per second; n is any safe integer the phone chooses (a counter or a timestamp)
// host -> phone
//   {"t":"welcome","slot":1}    player number 1..4 (the same number again when the id re-attached inside the grace window)
//   {"t":"full"}                all slots taken; the socket is closed
//   {"t":"kicked"}              removed from the host screen; the socket is closed
//   Close reasons (WebSocket close code 1000 unless noted; the page reads event.reason):
//     "replaced"  another socket said hello with the same phone id (a second tab of the same phone) and took the slot over; this
//                 socket is the OLD one. The page treats it as final: no automatic reconnect, it shows "Open in another tab"
//                 and a Reconnect button (which takes the slot back, and sends "replaced" to the other tab in turn).
//     "kicked"    removed from the host screen (also sent as the {"t":"kicked"} message just before)
//     "idle" (1001), "hello timeout" / "too many messages" (1008): the page reconnects with backoff as for any lost link.
//   {"t":"p","n":<integer>}     pong: the ping's n, unchanged, sent at once. Only after "welcome"; a ping before hello gets no reply.
//                               The phone measures the round trip as (now - time it sent n) and treats a missing pong as a dead link.
//                               Pings count against the 300 frames/s limit. They do not count as keepalives.
// HTTP (same origin as the page)
//   GET|PUT /api/layouts?t=<token>&id=<phone id>   layouts of that phone. id is optional; without a valid id the host falls
//        back to the old per-IP file. The first request with an id adopts the phone's old per-IP file if it exists and no
//        id file does. GET /api/default-layout?t=<token> is unchanged.
//   The token <token> is persistent: it is made once, kept in the host settings and changes only with "New link".
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

export type ClientMessage = { t: 'hello'; name: string; id?: string } | { t: 's'; pad: PadState } | { t: 'k' } | { t: 'p'; n: number };
export type ServerMessage = { t: 'welcome'; slot: number } | { t: 'full' } | { t: 'kicked' } | { t: 'p'; n: number };

const PHONE_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;

/** The phone id if it has the documented shape, otherwise undefined. */
export function sanitizePhoneId(v: unknown): string | undefined {
  return typeof v === 'string' && PHONE_ID_RE.test(v) ? v : undefined;
}

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
    case 'hello': {
      const id = sanitizePhoneId(o['id']);
      return id === undefined ? { t: 'hello', name: sanitizePlayerName(o['name']) } : { t: 'hello', name: sanitizePlayerName(o['name']), id };
    }
    case 'p': {
      const n = o['n'];
      return typeof n === 'number' && Number.isSafeInteger(n) ? { t: 'p', n } : null;
    }
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
