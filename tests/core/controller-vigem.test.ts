import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BTN, neutralPad, type PadState } from '../../src/core/controller/protocol.js';
import {
  createViGEmBackend,
  toXusbReport,
  vigemErrorName,
  VIGEM_ERROR_BUS_NOT_FOUND,
  VIGEM_ERROR_NONE,
  type KoffiLike,
} from '../../src/core/controller/vigem.js';

const NO_FREE_SLOT = 0xe0000002;
const REMOVAL_FAILED = 0xe0000004;
const BUS_ACCESS_FAILED = 0xe0000009;
const INVALID_TARGET = 0xe0000003;

type Call = { fn: string; args: unknown[] };

/** A fake koffi + ViGEmClient.dll that records every call; `results` overrides what a function returns. */
function makeFake() {
  const calls: Call[] = [];
  const declared: Array<{ name: string; result: unknown; params: unknown[] }> = [];
  const structDefs: Array<Record<string, string>> = [];
  const loads: string[] = [];
  let nextHandle = 1;
  const results: Record<string, (args: unknown[]) => unknown> = {};
  const defaults: Record<string, (args: unknown[]) => unknown> = {
    vigem_alloc: () => ({ handle: `client${nextHandle++}` }),
    vigem_connect: () => VIGEM_ERROR_NONE,
    vigem_target_x360_alloc: () => ({ handle: `target${nextHandle++}` }),
    vigem_target_add: () => VIGEM_ERROR_NONE,
    vigem_target_x360_update: () => VIGEM_ERROR_NONE,
    vigem_target_remove: () => VIGEM_ERROR_NONE,
    vigem_target_free: () => undefined,
    vigem_disconnect: () => undefined,
    vigem_free: () => undefined,
  };
  const koffi: KoffiLike = {
    load(p) {
      loads.push(p);
      return {
        func(name, result, params) {
          declared.push({ name, result, params: [...params] });
          return (...args: unknown[]) => {
            calls.push({ fn: name, args });
            return (results[name] ?? defaults[name]!)(args);
          };
        },
      };
    },
    struct(def) {
      structDefs.push(def);
      return { structOf: def };
    },
  };
  const names = () => calls.map((c) => c.fn);
  return { koffi, calls, declared, structDefs, loads, results, names };
}

const DLL = 'C:\\app\\resources\\vendor\\ViGEmClient.dll';
const mk = (f: ReturnType<typeof makeFake>, exists = true) => createViGEmBackend({ dllPath: DLL, koffi: f.koffi, exists: () => exists });
const pad = (p: Partial<PadState> = {}): PadState => ({ ...neutralPad(), ...p });
const reportArg = (c: Call) => c.args[2] as Record<string, number>;

describe('importing the module', () => {
  it('does not load koffi or any native code (macOS, tests)', () => {
    const src = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'core', 'controller', 'vigem.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import[^;]*['"]koffi['"]/m);
    // the only require of koffi sits inside a function body (indented), never at module top level
    const requires = src.split('\n').filter((l) => /require\(['"]koffi['"]\)/.test(l));
    expect(requires).toHaveLength(1);
    expect(requires[0]).toMatch(/^\s{2,}/);
    const cache = createRequire(__filename).cache;
    expect(Object.keys(cache).some((k) => /[\\/]koffi[\\/]/.test(k))).toBe(false);
  });

  it('a backend whose DLL is missing never touches koffi', () => {
    const b = createViGEmBackend({ dllPath: path.join(__dirname, 'definitely-not-here', 'ViGEmClient.dll') });
    expect(b.status()).toEqual({ ok: false, reason: 'dll-missing', message: expect.stringContaining('ViGEmClient.dll') });
    expect(Object.keys(createRequire(__filename).cache).some((k) => /[\\/]koffi[\\/]/.test(k))).toBe(false);
  });
});

describe('error codes', () => {
  it('uses the real Client.h values (NONE is 0x2..., failures are 0xE...)', () => {
    expect(VIGEM_ERROR_NONE).toBe(0x20000000);
    expect(VIGEM_ERROR_BUS_NOT_FOUND).toBe(0xe0000001);
    expect(vigemErrorName(0x20000000)).toBe('VIGEM_ERROR_NONE');
    expect(vigemErrorName(0xe0000001)).toBe('VIGEM_ERROR_BUS_NOT_FOUND');
    expect(vigemErrorName(0xe0000019)).toBe('VIGEM_ERROR_IS_DISPOSING');
    expect(vigemErrorName(-0x1fffffff)).toBe('VIGEM_ERROR_BUS_NOT_FOUND'); // a signed 32-bit view of the same bits
    expect(vigemErrorName(0x1234)).toBe('VIGEM_ERROR_UNKNOWN(0x1234)');
  });
});

describe('native bindings', () => {
  it('binds exactly the nine functions with the C signatures from Client.h', () => {
    const f = makeFake();
    mk(f).createPad(1);
    expect(f.loads).toEqual([DLL]);
    const sig = (n: string) => f.declared.find((d) => d.name === n)!;
    const report = f.declared.find((d) => d.name === 'vigem_target_x360_update')!.params[2];
    expect(report).toEqual({ structOf: f.structDefs[0] });
    expect(f.declared.map((d) => [d.name, d.result, d.params.length])).toEqual([
      ['vigem_alloc', 'void *', 0],
      ['vigem_connect', 'uint32', 1],
      ['vigem_target_x360_alloc', 'void *', 0],
      ['vigem_target_add', 'uint32', 2],
      ['vigem_target_x360_update', 'uint32', 3],
      ['vigem_target_remove', 'uint32', 2],
      ['vigem_target_free', 'void', 1],
      ['vigem_disconnect', 'void', 1],
      ['vigem_free', 'void', 1],
    ]);
    for (const n of ['vigem_connect', 'vigem_target_add', 'vigem_target_remove', 'vigem_target_free', 'vigem_disconnect', 'vigem_free']) {
      expect(sig(n).params.every((p) => p === 'void *'), n).toBe(true);
    }
    expect(sig('vigem_target_x360_update').params.slice(0, 2)).toEqual(['void *', 'void *']);
  });

  it('declares XUSB_REPORT with the Common.h layout (WORD, BYTE, BYTE, SHORT x4), in that order', () => {
    const f = makeFake();
    mk(f).createPad(1);
    expect(f.structDefs).toHaveLength(1);
    expect(Object.entries(f.structDefs[0]!)).toEqual([
      ['wButtons', 'uint16'],
      ['bLeftTrigger', 'uint8'],
      ['bRightTrigger', 'uint8'],
      ['sThumbLX', 'int16'],
      ['sThumbLY', 'int16'],
      ['sThumbRX', 'int16'],
      ['sThumbRY', 'int16'],
    ]);
  });

  it('two backends never collide on a struct name (the struct is anonymous)', () => {
    const f = makeFake();
    mk(f).createPad(1);
    mk(f).createPad(1);
    expect(f.structDefs).toHaveLength(2);
  });
});

describe('lifecycle and call order', () => {
  it('connects once, then per pad: target alloc, add, update(report), neutral + remove + free on close', () => {
    const f = makeFake();
    const b = mk(f);
    const p = b.createPad(1);
    expect(f.names()).toEqual(['vigem_alloc', 'vigem_connect', 'vigem_target_x360_alloc', 'vigem_target_add']);
    const client = f.calls[0]!.fn === 'vigem_alloc' ? f.calls[1]!.args[0] : null;
    const target = f.calls[3]!.args[1];
    expect(f.calls[3]!.args[0]).toBe(client);

    p.update(pad({ buttons: BTN.A | BTN.DPAD_UP, lt: 255, rt: 7, lx: -32768, ly: 32767, rx: 100, ry: -100 }));
    const upd = f.calls[4]!;
    expect(upd.fn).toBe('vigem_target_x360_update');
    expect(upd.args[0]).toBe(client);
    expect(upd.args[1]).toBe(target);
    expect(upd.args[2]).toEqual({ wButtons: BTN.A | BTN.DPAD_UP, bLeftTrigger: 255, bRightTrigger: 7, sThumbLX: -32768, sThumbLY: 32767, sThumbRX: 100, sThumbRY: -100 });

    p.close();
    expect(f.names().slice(5)).toEqual(['vigem_target_x360_update', 'vigem_target_remove', 'vigem_target_free']);
    expect(reportArg(f.calls[5]!)).toEqual({ wButtons: 0, bLeftTrigger: 0, bRightTrigger: 0, sThumbLX: 0, sThumbLY: 0, sThumbRX: 0, sThumbRY: 0 });
    expect(f.calls[6]!.args).toEqual([client, target]);
    expect(f.calls[7]!.args).toEqual([target]);
  });

  it('shares one client between pads and gives each pad its own target', () => {
    const f = makeFake();
    const b = mk(f);
    b.createPad(1);
    b.createPad(2);
    expect(f.names().filter((n) => n === 'vigem_alloc')).toHaveLength(1);
    expect(f.names().filter((n) => n === 'vigem_connect')).toHaveLength(1);
    const targets = f.calls.filter((c) => c.fn === 'vigem_target_add').map((c) => c.args[1]);
    expect(targets).toHaveLength(2);
    expect(targets[0]).not.toBe(targets[1]);
  });

  it('close() is idempotent and update() after close is a no-op', () => {
    const f = makeFake();
    const p = mk(f).createPad(1);
    p.close();
    const n = f.calls.length;
    p.close();
    p.update(pad({ buttons: BTN.B }));
    expect(f.calls).toHaveLength(n);
    expect(f.names().filter((x) => x === 'vigem_target_remove')).toHaveLength(1);
    expect(f.names().filter((x) => x === 'vigem_target_free')).toHaveLength(1);
  });

  it('closing one pad leaves the others working', () => {
    const f = makeFake();
    const b = mk(f);
    const a = b.createPad(1);
    const c = b.createPad(2);
    a.close();
    const before = f.calls.length;
    c.update(pad({ buttons: BTN.X }));
    expect(f.calls).toHaveLength(before + 1);
    expect(f.calls.at(-1)!.fn).toBe('vigem_target_x360_update');
  });

  it('dispose() closes open pads (neutral, remove, free), then disconnects and frees the client; it is idempotent', () => {
    const f = makeFake();
    const b = mk(f);
    const p = b.createPad(1);
    b.dispose();
    expect(f.names().slice(4)).toEqual(['vigem_target_x360_update', 'vigem_target_remove', 'vigem_target_free', 'vigem_disconnect', 'vigem_free']);
    const n = f.calls.length;
    b.dispose();
    p.update(pad({ buttons: BTN.A }));
    p.close();
    expect(f.calls).toHaveLength(n);
    expect(() => b.createPad(1)).toThrow(/disposed/);
    expect(b.status()).toEqual({ ok: false, reason: 'error', message: expect.stringContaining('disposed') });
  });

  it('dispose() without ever connecting touches nothing', () => {
    const f = makeFake();
    const b = mk(f);
    b.dispose();
    expect(f.calls).toHaveLength(0);
  });

  it('rejects an invalid slot before touching the driver', () => {
    const f = makeFake();
    const b = mk(f);
    for (const s of [-1, 1.5, NaN, Infinity]) expect(() => b.createPad(s)).toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });
});

describe('status()', () => {
  it('dll-missing when the file does not exist (koffi is not even loaded)', () => {
    const f = makeFake();
    const s = mk(f, false).status();
    expect(s).toMatchObject({ ok: false, reason: 'dll-missing' });
    expect(f.loads).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('ok connects once and keeps the client for createPad (no leaked probe client)', () => {
    const f = makeFake();
    const b = mk(f);
    expect(b.status()).toEqual({ ok: true });
    expect(b.status()).toEqual({ ok: true });
    b.createPad(1);
    expect(f.names().filter((n) => n === 'vigem_alloc')).toHaveLength(1);
    expect(f.names().filter((n) => n === 'vigem_connect')).toHaveLength(1);
    expect(f.names()).not.toContain('vigem_disconnect');
  });

  it('driver-missing on VIGEM_ERROR_BUS_NOT_FOUND, frees the probe client, and recovers once the driver is installed', () => {
    const f = makeFake();
    f.results['vigem_connect'] = () => VIGEM_ERROR_BUS_NOT_FOUND;
    const b = mk(f);
    expect(b.status()).toMatchObject({ ok: false, reason: 'driver-missing', message: expect.stringContaining('VIGEM_ERROR_BUS_NOT_FOUND') });
    expect(f.names()).toEqual(['vigem_alloc', 'vigem_connect', 'vigem_disconnect', 'vigem_free']);
    expect(f.calls[2]!.args[0]).toBe(f.calls[1]!.args[0]);
    expect(f.calls[3]!.args[0]).toBe(f.calls[1]!.args[0]);
    expect(() => b.createPad(1)).toThrow(/VIGEM_ERROR_BUS_NOT_FOUND/);

    delete f.results['vigem_connect']; // the user installed ViGEmBus meanwhile
    expect(b.status()).toEqual({ ok: true });
    expect(f.loads).toEqual([DLL]); // the library is bound once
    expect(() => b.createPad(1)).not.toThrow();
  });

  it('error for any other connect failure, with the symbolic name', () => {
    const f = makeFake();
    f.results['vigem_connect'] = () => BUS_ACCESS_FAILED;
    expect(mk(f).status()).toMatchObject({ ok: false, reason: 'error', message: expect.stringContaining('VIGEM_ERROR_BUS_ACCESS_FAILED') });
  });

  it('error when the DLL or koffi cannot be loaded, or alloc returns NULL', () => {
    const throwing: KoffiLike = {
      load: () => {
        throw new Error('The specified module could not be found');
      },
      struct: () => ({}),
    };
    expect(createViGEmBackend({ dllPath: DLL, koffi: throwing, exists: () => true }).status()).toMatchObject({
      ok: false,
      reason: 'error',
      message: expect.stringContaining('could not be found'),
    });
    const f = makeFake();
    f.results['vigem_alloc'] = () => null;
    expect(mk(f).status()).toMatchObject({ ok: false, reason: 'error', message: expect.stringContaining('NULL') });
  });
});

describe('error mapping', () => {
  it('createPad throws the symbolic name and frees the target when vigem_target_add fails', () => {
    const f = makeFake();
    f.results['vigem_target_add'] = () => NO_FREE_SLOT;
    const b = mk(f);
    expect(() => b.createPad(3)).toThrow(/vigem_target_add.*VIGEM_ERROR_NO_FREE_SLOT/);
    expect(f.names().at(-1)).toBe('vigem_target_free');
    // nothing left behind: dispose has no pad to close
    b.dispose();
    expect(f.names().filter((n) => n === 'vigem_target_remove')).toHaveLength(0);
  });

  it('createPad throws when the target cannot be allocated', () => {
    const f = makeFake();
    f.results['vigem_target_x360_alloc'] = () => null;
    expect(() => mk(f).createPad(1)).toThrow(/vigem_target_x360_alloc returned NULL/);
  });

  it('update throws the symbolic name', () => {
    const f = makeFake();
    const p = mk(f).createPad(1);
    f.results['vigem_target_x360_update'] = () => INVALID_TARGET;
    expect(() => p.update(pad())).toThrow(/vigem_target_x360_update.*VIGEM_ERROR_INVALID_TARGET/);
  });

  it('close still removes the target when the neutral update fails, and stays closed', () => {
    const f = makeFake();
    const p = mk(f).createPad(1);
    f.results['vigem_target_x360_update'] = () => INVALID_TARGET;
    expect(() => p.close()).not.toThrow();
    expect(f.names().slice(-2)).toEqual(['vigem_target_remove', 'vigem_target_free']);
  });

  it('a failed removal throws, does NOT free the still-plugged target, and a second close does nothing', () => {
    const f = makeFake();
    const p = mk(f).createPad(1);
    f.results['vigem_target_remove'] = () => REMOVAL_FAILED;
    expect(() => p.close()).toThrow(/vigem_target_remove.*VIGEM_ERROR_REMOVAL_FAILED/);
    expect(f.names()).not.toContain('vigem_target_free');
    const n = f.calls.length;
    expect(() => p.close()).not.toThrow();
    expect(f.calls).toHaveLength(n);
  });

  it('a signed 32-bit result from the FFI layer still maps to the right name', () => {
    const f = makeFake();
    f.results['vigem_target_add'] = () => -0x1ffffffe; // 0xE0000002 as int32
    expect(() => mk(f).createPad(1)).toThrow(/VIGEM_ERROR_NO_FREE_SLOT/);
  });
});

describe('toXusbReport (defensive conversion)', () => {
  it('passes valid values through unchanged (1:1 with XUSB_REPORT, up positive)', () => {
    const s = pad({ buttons: BTN.Y | BTN.GUIDE | BTN.LEFT_SHOULDER, lt: 1, rt: 254, lx: 1, ly: -1, rx: 32767, ry: -32768 });
    expect(toXusbReport(s)).toEqual({ wButtons: s.buttons, bLeftTrigger: 1, bRightTrigger: 254, sThumbLX: 1, sThumbLY: -1, sThumbRX: 32767, sThumbRY: -32768 });
  });

  it('clamps out-of-range values', () => {
    const r = toXusbReport(pad({ lt: 9999, rt: -5, lx: 1e9, ly: -1e9, rx: 40000, ry: -40000 }));
    expect(r).toMatchObject({ bLeftTrigger: 255, bRightTrigger: 0, sThumbLX: 32767, sThumbLY: -32768, sThumbRX: 32767, sThumbRY: -32768 });
  });

  it('rounds fractions and turns NaN, Infinity, strings and missing fields into 0', () => {
    const garbage = { buttons: NaN, lt: '200', rt: Infinity, lx: undefined, ly: null, rx: -0.4, ry: 12.6 } as unknown as PadState;
    expect(toXusbReport(garbage)).toEqual({ wButtons: 0, bLeftTrigger: 0, bRightTrigger: 0, sThumbLX: 0, sThumbLY: 0, sThumbRX: 0, sThumbRY: 13 });
    expect(Object.is(toXusbReport(garbage).sThumbRX, 0)).toBe(true); // never -0
  });

  it('keeps only real XUSB_GAMEPAD button bits', () => {
    expect(toXusbReport(pad({ buttons: 0xffff })).wButtons).toBe(0xffff & ~0x0800); // bit 0x0800 is unused in XUSB_GAMEPAD
    expect(toXusbReport(pad({ buttons: 0x10000 | BTN.A })).wButtons).toBe(0); // out of range is garbage, not "all buttons"
    expect(toXusbReport(pad({ buttons: -1 })).wButtons).toBe(0);
    expect(toXusbReport(pad({ buttons: 3.9 })).wButtons).toBe(BTN.DPAD_UP | BTN.DPAD_DOWN); // truncated like protocol.ts, not rounded
  });

  it('a non-object is the neutral report', () => {
    const neutral = { wButtons: 0, bLeftTrigger: 0, bRightTrigger: 0, sThumbLX: 0, sThumbLY: 0, sThumbRX: 0, sThumbRY: 0 };
    expect(toXusbReport(null as unknown as PadState)).toEqual(neutral);
    expect(toXusbReport(undefined as unknown as PadState)).toEqual(neutral);
    expect(toXusbReport(7 as unknown as PadState)).toEqual(neutral);
  });

  it('update() sends the sanitized report to the driver', () => {
    const f = makeFake();
    const p = mk(f).createPad(1);
    p.update({ buttons: 0xffff, lt: 1000, rt: -1, lx: NaN, ly: 5e6, rx: 0, ry: 0 } as PadState);
    expect(reportArg(f.calls.at(-1)!)).toEqual({ wButtons: 0xffff & ~0x0800, bLeftTrigger: 255, bRightTrigger: 0, sThumbLX: 0, sThumbLY: 32767, sThumbRX: 0, sThumbRY: 0 });
  });
});
