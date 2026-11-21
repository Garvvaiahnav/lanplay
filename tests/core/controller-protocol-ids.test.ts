import { describe, expect, it } from 'vitest';
import { parseClientMessage, sanitizePhoneId } from '../../src/core/controller/protocol.js';

const ID = 'a1B2c3D4e5F6g7H8';

describe('phone id in hello', () => {
  it('accepts 16..32 characters of A-Za-z0-9_-', () => {
    expect(sanitizePhoneId(ID)).toBe(ID);
    expect(sanitizePhoneId('x'.repeat(32))).toHaveLength(32);
    expect(sanitizePhoneId('a_b-c_d-e_f-g_h-')).toBe('a_b-c_d-e_f-g_h-');
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'short', 'x'.repeat(15), 'x'.repeat(33), 'a1B2c3D4e5F6g7H!', '../../etc/passwd/xx', 'a1B2c3D4 e5F6g7H8', 'a1B2c3D4e5F6g7H8\n', 5, null, undefined, {}, ['a1B2c3D4e5F6g7H8']]) {
      expect(sanitizePhoneId(bad)).toBeUndefined();
    }
  });

  it('hello carries a valid id and drops an invalid one without rejecting the hello', () => {
    expect(parseClientMessage(`{"t":"hello","name":"Pixel","id":"${ID}"}`)).toEqual({ t: 'hello', name: 'Pixel', id: ID });
    expect(parseClientMessage('{"t":"hello","name":"Pixel","id":"nope"}')).toEqual({ t: 'hello', name: 'Pixel' });
    expect(parseClientMessage('{"t":"hello","name":"Pixel"}')).toEqual({ t: 'hello', name: 'Pixel' });
    expect(parseClientMessage('{"t":"hello","id":7}')).toEqual({ t: 'hello', name: 'Phone' });
  });
});

describe('ping', () => {
  it('parses an integer n unchanged', () => {
    expect(parseClientMessage('{"t":"p","n":0}')).toEqual({ t: 'p', n: 0 });
    expect(parseClientMessage('{"t":"p","n":1731000000000}')).toEqual({ t: 'p', n: 1731000000000 });
    expect(parseClientMessage('{"t":"p","n":-3}')).toEqual({ t: 'p', n: -3 });
  });

  it('rejects a missing, fractional, non-numeric or unsafe n', () => {
    for (const raw of ['{"t":"p"}', '{"t":"p","n":1.5}', '{"t":"p","n":"7"}', '{"t":"p","n":null}', '{"t":"p","n":1e300}', '{"t":"p","n":9007199254740993}']) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });
});
