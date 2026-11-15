// Virtual Xbox 360 controllers through the ViGEmBus driver, called via ViGEmClient.dll and the `koffi` FFI package.
//
//   ViGEmBus    https://github.com/nefarius/ViGEmBus     BSD-3-Clause (kernel driver, installed by the user)
//   ViGEmClient https://github.com/nefarius/ViGEmClient  MIT          (user-mode DLL, vendored and SHA256-pinned)
//   koffi       https://github.com/Koromix/koffi         MIT          (FFI, prebuilt N-API binaries, no compile step)
//
// The C signatures and error values below were checked against include/ViGEm/Client.h and Common.h at
// ViGEmClient commit 7e471cbfeaef6d06d01b66c33b6811e071e62866 (the commit the vendored DLL was built from).
// Note the error values: VIGEM_ERROR_NONE is 0x20000000 but every failure is 0xE00000xx.
//
// koffi is required lazily, inside the backend, so importing this module (macOS, tests, the renderer-less parts of the
// main process) never loads native code. Nothing here touches the DLL until status() or createPad() is called.
// UNTESTED-ON-WINDOWS: the real ViGEmClient.dll / ViGEmBus calls. Everything else is unit-tested with an injected fake
// KoffiLike; the marshalling (struct by value, uint32 results, opaque pointers) was also exercised against a native
// stand-in library on macOS.
import { existsSync } from 'node:fs';
import { ALLOWED_BUTTONS, type PadState } from './protocol.js';

export interface VirtualPad {
  update(state: PadState): void;
  close(): void;
}

export type PadBackendStatus = { ok: true } | { ok: false; reason: 'dll-missing' | 'driver-missing' | 'error'; message: string };

export interface PadBackend {
  status(): PadBackendStatus;
  createPad(slot: number): VirtualPad;
}

/** A PadBackend that owns a native client; dispose() closes every open pad and releases the client. Idempotent. */
export interface ViGEmBackend extends PadBackend {
  dispose(): void;
}

/** A koffi type: a name such as 'uint16' / 'void *', or the object returned by koffi.struct(). */
export type KoffiTypeSpec = string | object;

/** The part of a koffi library handle this module calls. */
export interface KoffiLibraryLike {
  func(name: string, result: KoffiTypeSpec, params: readonly KoffiTypeSpec[]): (...args: unknown[]) => unknown;
}

/** The minimal subset of the `koffi` module this file uses, so tests can inject a fake. */
export interface KoffiLike {
  load(path: string): KoffiLibraryLike;
  /** Anonymous struct (koffi registers named structs globally, which would collide across backends). */
  struct(def: Record<string, string>): KoffiTypeSpec;
}

// ---------------------------------------------------------------- error codes (Client.h, enum _VIGEM_ERRORS)

export const VIGEM_ERROR_NONE = 0x20000000;
export const VIGEM_ERROR_BUS_NOT_FOUND = 0xe0000001;

const ERROR_NAMES: ReadonlyMap<number, string> = new Map([
  [0x20000000, 'VIGEM_ERROR_NONE'],
  [0xe0000001, 'VIGEM_ERROR_BUS_NOT_FOUND'],
  [0xe0000002, 'VIGEM_ERROR_NO_FREE_SLOT'],
  [0xe0000003, 'VIGEM_ERROR_INVALID_TARGET'],
  [0xe0000004, 'VIGEM_ERROR_REMOVAL_FAILED'],
  [0xe0000005, 'VIGEM_ERROR_ALREADY_CONNECTED'],
  [0xe0000006, 'VIGEM_ERROR_TARGET_UNINITIALIZED'],
  [0xe0000007, 'VIGEM_ERROR_TARGET_NOT_PLUGGED_IN'],
  [0xe0000008, 'VIGEM_ERROR_BUS_VERSION_MISMATCH'],
  [0xe0000009, 'VIGEM_ERROR_BUS_ACCESS_FAILED'],
  [0xe0000010, 'VIGEM_ERROR_CALLBACK_ALREADY_REGISTERED'],
  [0xe0000011, 'VIGEM_ERROR_CALLBACK_NOT_FOUND'],
  [0xe0000012, 'VIGEM_ERROR_BUS_ALREADY_CONNECTED'],
  [0xe0000013, 'VIGEM_ERROR_BUS_INVALID_HANDLE'],
  [0xe0000014, 'VIGEM_ERROR_XUSB_USERINDEX_OUT_OF_RANGE'],
  [0xe0000015, 'VIGEM_ERROR_INVALID_PARAMETER'],
  [0xe0000016, 'VIGEM_ERROR_NOT_SUPPORTED'],
  [0xe0000017, 'VIGEM_ERROR_WINAPI'],
  [0xe0000018, 'VIGEM_ERROR_TIMED_OUT'],
  [0xe0000019, 'VIGEM_ERROR_IS_DISPOSING'],
]);

/** Symbolic name of a VIGEM_ERROR value (unknown values keep their hex code). */
export function vigemErrorName(code: number): string {
  const known = ERROR_NAMES.get(code >>> 0);
  return known ?? `VIGEM_ERROR_UNKNOWN(0x${(code >>> 0).toString(16).toUpperCase()})`;
}

function vigemError(fn: string, code: number): Error {
  return new Error(`${fn} failed: ${vigemErrorName(code)}`);
}

// ---------------------------------------------------------------- XUSB_REPORT

/** XUSB_REPORT (Common.h): { USHORT wButtons; BYTE bLeftTrigger, bRightTrigger; SHORT sThumbLX, sThumbLY, sThumbRX, sThumbRY }. */
export interface XusbReport {
  wButtons: number;
  bLeftTrigger: number;
  bRightTrigger: number;
  sThumbLX: number;
  sThumbLY: number;
  sThumbRX: number;
  sThumbRY: number;
}

const XUSB_REPORT_DEF: Record<string, string> = {
  wButtons: 'uint16',
  bLeftTrigger: 'uint8',
  bRightTrigger: 'uint8',
  sThumbLX: 'int16',
  sThumbLY: 'int16',
  sThumbRX: 'int16',
  sThumbRY: 'int16',
};

function toInt(v: unknown, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.min(hi, Math.max(lo, Math.round(v))) + 0; // + 0 turns -0 into 0
}

/** A button bitmask is not a magnitude: an out-of-range value is garbage (press nothing), not "all buttons". */
function toButtons(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const n = Math.trunc(v);
  return n < 0 || n > 0xffff ? 0 : n & ALLOWED_BUTTONS;
}

/**
 * Converts a PadState into a valid XUSB_REPORT whatever it contains: non-numbers, NaN and Infinity become 0, triggers are
 * clamped to 0..255, sticks to -32768..32767 (up and right positive, which is the XInput convention the driver expects),
 * and only the 15 real XUSB_GAMEPAD button bits survive (a bitmask outside 0..0xFFFF is dropped entirely). A non-object yields the neutral report.
 */
export function toXusbReport(state: PadState): XusbReport {
  const s = (typeof state === 'object' && state !== null ? state : {}) as Partial<Record<keyof PadState, unknown>>;
  return {
    wButtons: toButtons(s.buttons),
    bLeftTrigger: toInt(s.lt, 0, 255),
    bRightTrigger: toInt(s.rt, 0, 255),
    sThumbLX: toInt(s.lx, -32768, 32767),
    sThumbLY: toInt(s.ly, -32768, 32767),
    sThumbRX: toInt(s.rx, -32768, 32767),
    sThumbRY: toInt(s.ry, -32768, 32767),
  };
}

const neutralReport = (): XusbReport => ({ wButtons: 0, bLeftTrigger: 0, bRightTrigger: 0, sThumbLX: 0, sThumbLY: 0, sThumbRX: 0, sThumbRY: 0 });

// ---------------------------------------------------------------- native bindings

type Handle = unknown; // PVIGEM_CLIENT / PVIGEM_TARGET: opaque pointers, null when NULL

interface Bindings {
  alloc(): Handle;
  connect(client: Handle): number;
  targetX360Alloc(): Handle;
  targetAdd(client: Handle, target: Handle): number;
  targetX360Update(client: Handle, target: Handle, report: XusbReport): number;
  targetRemove(client: Handle, target: Handle): number;
  targetFree(target: Handle): void;
  disconnect(client: Handle): void;
  free(client: Handle): void;
}

/** Binds the nine functions this module needs, with the exact signatures from Client.h. */
function bind(koffi: KoffiLike, dllPath: string): Bindings {
  const lib = koffi.load(dllPath);
  const report = koffi.struct(XUSB_REPORT_DEF);
  const ptr = 'void *'; // PVIGEM_CLIENT / PVIGEM_TARGET are pointers to incomplete structs: opaque to us
  const f = (name: string, result: KoffiTypeSpec, params: KoffiTypeSpec[]) => lib.func(name, result, params);
  const alloc = f('vigem_alloc', ptr, []); //                                       PVIGEM_CLIENT vigem_alloc(void)
  const connect = f('vigem_connect', 'uint32', [ptr]); //                           VIGEM_ERROR vigem_connect(PVIGEM_CLIENT)
  const x360Alloc = f('vigem_target_x360_alloc', ptr, []); //                       PVIGEM_TARGET vigem_target_x360_alloc(void)
  const add = f('vigem_target_add', 'uint32', [ptr, ptr]); //                       VIGEM_ERROR vigem_target_add(PVIGEM_CLIENT, PVIGEM_TARGET)
  const update = f('vigem_target_x360_update', 'uint32', [ptr, ptr, report]); //    VIGEM_ERROR vigem_target_x360_update(PVIGEM_CLIENT, PVIGEM_TARGET, XUSB_REPORT) by value
  const remove = f('vigem_target_remove', 'uint32', [ptr, ptr]); //                 VIGEM_ERROR vigem_target_remove(PVIGEM_CLIENT, PVIGEM_TARGET)
  const targetFree = f('vigem_target_free', 'void', [ptr]); //                      void vigem_target_free(PVIGEM_TARGET)
  const disconnect = f('vigem_disconnect', 'void', [ptr]); //                       void vigem_disconnect(PVIGEM_CLIENT)
  const free = f('vigem_free', 'void', [ptr]); //                                   void vigem_free(PVIGEM_CLIENT)
  return {
    alloc: () => alloc(),
    connect: (c) => Number(connect(c)) >>> 0,
    targetX360Alloc: () => x360Alloc(),
    targetAdd: (c, t) => Number(add(c, t)) >>> 0,
    targetX360Update: (c, t, r) => Number(update(c, t, r)) >>> 0,
    targetRemove: (c, t) => Number(remove(c, t)) >>> 0,
    targetFree: (t) => void targetFree(t),
    disconnect: (c) => void disconnect(c),
    free: (c) => void free(c),
  };
}

/** Backend failure that carries the status reason it maps to. */
class BackendFailure extends Error {
  constructor(
    readonly reason: 'dll-missing' | 'driver-missing' | 'error',
    message: string,
  ) {
    super(message);
    this.name = 'BackendFailure';
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function requireKoffi(): KoffiLike {
  // Lazy on purpose: loading koffi dlopen()s a native addon.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('koffi') as KoffiLike;
}

export interface ViGEmBackendOptions {
  /** Absolute path of ViGEmClient.dll (x64). */
  dllPath: string;
  /** Test seam; defaults to the real `koffi` package, required on first use. */
  koffi?: KoffiLike;
  /** Test seam; defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
}

export function createViGEmBackend(o: ViGEmBackendOptions): ViGEmBackend {
  const exists = o.exists ?? existsSync;
  let bindings: Bindings | null = null;
  let client: Handle = null;
  let connected = false;
  let disposed = false;
  const pads = new Set<VirtualPad>();

  /** Loads the DLL and connects one shared client, once. Throws BackendFailure; nothing is cached on failure except the loaded library. */
  function ensureConnected(): Bindings {
    if (disposed) throw new BackendFailure('error', 'the ViGEm backend was disposed');
    if (connected && bindings) return bindings;
    if (!exists(o.dllPath)) throw new BackendFailure('dll-missing', `ViGEmClient.dll was not found at ${o.dllPath}`);
    if (!bindings) {
      try {
        bindings = bind(o.koffi ?? requireKoffi(), o.dllPath);
      } catch (e) {
        throw new BackendFailure('error', `could not load ViGEmClient.dll: ${errMsg(e)}`);
      }
    }
    const b = bindings;
    const c = b.alloc();
    if (c === null || c === undefined) throw new BackendFailure('error', 'vigem_alloc returned NULL (out of memory)');
    const code = b.connect(c);
    if (code !== VIGEM_ERROR_NONE) {
      // Do not leak a half-open client; a later call (for example after the driver got installed) starts over.
      try {
        b.disconnect(c);
        b.free(c);
      } catch {
        /* nothing more to do */
      }
      if (code === VIGEM_ERROR_BUS_NOT_FOUND) {
        throw new BackendFailure('driver-missing', `the ViGEmBus driver is not installed or not running (${vigemErrorName(code)})`);
      }
      throw new BackendFailure('error', `vigem_connect failed: ${vigemErrorName(code)}`);
    }
    client = c;
    connected = true;
    return b;
  }

  return {
    status(): PadBackendStatus {
      try {
        ensureConnected();
        return { ok: true };
      } catch (e) {
        if (e instanceof BackendFailure) return { ok: false, reason: e.reason, message: e.message };
        return { ok: false, reason: 'error', message: errMsg(e) };
      }
    },

    createPad(slot: number): VirtualPad {
      // The slot is only a label for diagnostics: the bus assigns the real XInput user index itself.
      if (!Number.isInteger(slot) || slot < 0) throw new RangeError(`invalid pad slot: ${String(slot)}`);
      const b = ensureConnected();
      const target = b.targetX360Alloc();
      if (target === null || target === undefined) throw new Error(`vigem_target_x360_alloc returned NULL (slot ${slot})`);
      const code = b.targetAdd(client, target); // blocks until the virtual device is operational
      if (code !== VIGEM_ERROR_NONE) {
        b.targetFree(target);
        throw vigemError(`vigem_target_add (slot ${slot})`, code);
      }

      let closed = false;
      const send = (report: XusbReport): void => {
        const rc = b.targetX360Update(client, target, report);
        if (rc !== VIGEM_ERROR_NONE) throw vigemError(`vigem_target_x360_update (slot ${slot})`, rc);
      };
      const pad: VirtualPad = {
        update(state: PadState): void {
          if (closed) return;
          send(toXusbReport(state));
        },
        close(): void {
          if (closed) return;
          closed = true;
          pads.delete(pad);
          try {
            send(neutralReport()); // release anything the game still sees as held, best effort
          } catch {
            /* the bus may already be gone; removal below reports the real problem */
          }
          const rc = b.targetRemove(client, target);
          if (rc !== VIGEM_ERROR_NONE) {
            // The client keeps a pointer to a plugged-in target, so freeing it now would leave that dangling: leak it instead.
            throw vigemError(`vigem_target_remove (slot ${slot})`, rc);
          }
          b.targetFree(target);
        },
      };
      pads.add(pad);
      return pad;
    },

    dispose(): void {
      if (disposed) return;
      for (const pad of [...pads]) {
        try {
          pad.close();
        } catch {
          /* keep tearing down */
        }
      }
      disposed = true;
      if (connected && bindings) {
        try {
          bindings.disconnect(client);
          bindings.free(client);
        } catch {
          /* nothing more to do */
        }
      }
      client = null;
      connected = false;
    },
  };
}
