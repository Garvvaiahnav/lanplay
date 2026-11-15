import { describe, expect, it } from 'vitest';
import { ALLOWED_BUTTONS, BTN, NEUTRAL_PAD, neutralPad, parseClientMessage, sanitizePlayerName } from '../../src/core/controller/protocol.js';

describe('button bits (XUSB_GAMEPAD, as used by ViGEm)', () => {
  it('matches the XInput layout', () => {
    expect(BTN.DPAD_UP).toBe(0x0001);
    expect(BTN.DPAD_DOWN).toBe(0x0002);
    expect(BTN.DPAD_LEFT).toBe(0x0004);
    expect(BTN.DPAD_RIGHT).toBe(0x0008);
    expect(BTN.START).toBe(0x0010);
    expect(BTN.BACK).toBe(0x0020);
    expect(BTN.LEFT_THUMB).toBe(0x0040);
    expect(BTN.RIGHT_THUMB).toBe(0x0080);
    expect(BTN.LEFT_SHOULDER).toBe(0x0100);
    expect(BTN.RIGHT_SHOULDER).toBe(0x0200);
    expect(BTN.GUIDE).toBe(0x0400);
    expect(BTN.A).toBe(0x1000);
    expect(BTN.B).toBe(0x2000);
    expect(BTN.X).toBe(0x4000);
    expect(BTN.Y).toBe(0x8000);
  });
  it('ALLOWED_BUTTONS is exactly the OR of all bits', () => {
    expect(ALLOWED_BUTTONS).toBe(0xf7ff & ~0); // bit 0x0800 is not a button
    expect(ALLOWED_BUTTONS & 0x0800).toBe(0);
  });
});

describe('neutral pad', () => {
  it('is all zero and never shared', () => {
    expect(NEUTRAL_PAD).toEqual({ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
    expect(neutralPad()).toEqual(NEUTRAL_PAD);
    expect(neutralPad()).not.toBe(NEUTRAL_PAD);
  });
});

describe('sanitizePlayerName', () => {
  it('trims, strips control chars, caps at 24 chars and falls back', () => {
    expect(sanitizePlayerName('  Pixel 8 ')).toBe('Pixel 8');
    expect(sanitizePlayerName('a\u0000b\u001fc')).toBe('abc');
    expect(sanitizePlayerName('x'.repeat(100))).toHaveLength(24);
    expect(sanitizePlayerName('')).toBe('Phone');
    expect(sanitizePlayerName(undefined)).toBe('Phone');
    expect(sanitizePlayerName(42)).toBe('Phone');
  });
});

describe('parseClientMessage', () => {
  it('parses hello', () => {
    expect(parseClientMessage('{"t":"hello","name":"Pixel"}')).toEqual({ t: 'hello', name: 'Pixel' });
    expect(parseClientMessage('{"t":"hello"}')).toEqual({ t: 'hello', name: 'Phone' });
  });

  it('parses a state message and clamps every field into XInput ranges', () => {
    const m = parseClientMessage('{"t":"s","b":4096,"lt":300,"rt":-5,"lx":99999,"ly":-99999,"rx":12.7,"ry":0}');
    expect(m).toEqual({ t: 's', pad: { buttons: 4096, lt: 255, rt: 0, lx: 32767, ly: -32768, rx: 13, ry: 0 } });
  });

  it('drops unknown button bits', () => {
    const m = parseClientMessage('{"t":"s","b":65535,"lt":0,"rt":0,"lx":0,"ly":0,"rx":0,"ry":0}');
    expect(m).toMatchObject({ t: 's', pad: { buttons: ALLOWED_BUTTONS } });
  });

  it('treats missing or non-numeric axes as 0 (never NaN)', () => {
    const m = parseClientMessage('{"t":"s","b":"x","lt":null,"lx":"7"}');
    expect(m).toEqual({ t: 's', pad: { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 } });
  });

  it('parses keepalive', () => {
    expect(parseClientMessage('{"t":"k"}')).toEqual({ t: 'k' });
  });

  it('rejects garbage, wrong types, oversized input and prototype tricks', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('[]')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
    expect(parseClientMessage('{"t":"exec","cmd":"calc"}')).toBeNull();
    expect(parseClientMessage('{"t":5}')).toBeNull();
    expect(parseClientMessage('{"__proto__":{"t":"s"}}')).toBeNull();
    expect(parseClientMessage('{"t":"hello","name":"' + 'x'.repeat(2000) + '"}')).toBeNull();
  });
});
