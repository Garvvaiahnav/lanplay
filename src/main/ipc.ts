// IPC router: validates every renderer payload (the renderer is untrusted) and wraps replies in IpcEnvelope.
// Pure (no Electron import) so it is unit-tested directly.
import { IPC_INVOKE_CHANNELS } from '../contracts.js';
import type { IpcEnvelope, IpcInvokeChannel, IpcRequest, IpcResponse, Redactor, SettingsPane } from '../contracts.js';
import { settingsUrl } from '../core/host/mac/permissions-mac.js';

export class IpcValidationError extends Error {}

type Validator<C extends IpcInvokeChannel> = (raw: unknown) => IpcRequest<C>;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const none = (raw: unknown): void => {
  if (raw !== undefined && raw !== null) throw new IpcValidationError('this call takes no arguments');
};
const str = (o: Record<string, unknown>, k: string, re: RegExp, max: number): string => {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !re.test(v)) throw new IpcValidationError(`invalid ${k}`);
  return v;
};
const bool = (o: Record<string, unknown>, k: string): boolean => {
  if (typeof o[k] !== 'boolean') throw new IpcValidationError(`invalid ${k}`);
  return o[k] as boolean;
};
const obj = (raw: unknown): Record<string, unknown> => {
  if (!isObj(raw)) throw new IpcValidationError('payload must be an object');
  return raw;
};
const HOST_ID = /^[\x21-\x7e]{1,200}$/;

export const IPC_VALIDATORS: { [C in IpcInvokeChannel]: Validator<C> } = {
  'app:info': none,
  'app:role-set': (raw) => {
    const r = obj(raw).role;
    if (r !== 'client' && r !== 'host') throw new IpcValidationError('invalid role');
    return { role: r };
  },
  'update:check': none,
  'client:system-info': none,
  'client:discover-start': none,
  'client:discover-stop': none,
  'client:add-manual-host': (raw) => ({ address: str(obj(raw), 'address', /^[^\s/\\@?#]+$/, 253) }),
  'client:settings-get': none,
  'client:settings-set': (raw) => obj(raw) as never, // shape is clamped by normalizeStreamSettings in the handler
  'client:pair': (raw) => ({ hostId: str(obj(raw), 'hostId', HOST_ID, 200) }),
  'client:stream-start': (raw) => {
    const o = obj(raw);
    if (!isObj(o.settings)) throw new IpcValidationError('invalid settings');
    return { hostId: str(o, 'hostId', HOST_ID, 200), settings: o.settings as never };
  },
  'client:stream-stop': (raw) => ({ hostId: str(obj(raw), 'hostId', HOST_ID, 200) }),
  'host:setup-status': none,
  'host:setup-run': none,
  'host:open-settings': (raw) => {
    const pane = obj(raw).pane;
    // The same table main opens links from, so a pane that passes here always has a deep link.
    if (settingsUrl(pane) === null) throw new IpcValidationError('invalid pane');
    return { pane: pane as SettingsPane };
  },
  'host:confirm-input': (raw) => ({ ok: bool(obj(raw), 'ok') }),
  'host:sunshine-restart': none,
  'host:agent-state': none,
  'host:agent-set-auto-approve': (raw) => ({ on: bool(obj(raw), 'on') }),
  'host:agent-decide': (raw) => {
    const o = obj(raw);
    return { requestId: str(o, 'requestId', /^[0-9a-fA-F-]{8,64}$/, 64), approve: bool(o, 'approve') };
  },
  'host:devices-list': none,
  'host:devices-revoke': (raw) => ({ uuid: str(obj(raw), 'uuid', /^[0-9A-Za-z-]{1,64}$/, 64) }),
  'host:controllers-state': none,
  'host:controllers-set-enabled': (raw) => ({ on: bool(obj(raw), 'on') }),
  'host:controllers-kick': (raw) => ({ id: str(obj(raw), 'id', /^[0-9a-f]{16}$/, 16) }),
  'host:controllers-new-link': none,
  'host:controllers-setup': none,
  'selfcheck:run': none,
  'diagnostics:collect': none,
  'diagnostics:reveal': (raw) => ({ zipPath: str(obj(raw), 'zipPath', /^[^\0]+$/, 4096) }),
};

export type IpcHandlers = { [C in IpcInvokeChannel]?: (req: IpcRequest<C>) => Promise<IpcResponse<C>> };

export interface IpcRouter {
  dispatch(channel: string, raw: unknown): Promise<IpcEnvelope<unknown>>;
}

export function createIpcRouter(handlers: IpcHandlers, redactor: Redactor, onError?: (channel: string, err: unknown) => void): IpcRouter {
  return {
    async dispatch(channel, raw) {
      if (!(IPC_INVOKE_CHANNELS as readonly string[]).includes(channel)) return { ok: false, error: { code: 'unknown-channel', message: 'Unknown request.' } };
      const c = channel as IpcInvokeChannel;
      const handler = handlers[c] as ((req: unknown) => Promise<unknown>) | undefined;
      if (!handler) return { ok: false, error: { code: 'wrong-role', message: 'This action is not available on this computer.' } };
      let req: unknown;
      try {
        req = (IPC_VALIDATORS[c] as (r: unknown) => unknown)(raw);
      } catch (e) {
        return { ok: false, error: { code: 'bad-request', message: (e as Error).message } };
      }
      try {
        const value = await handler(req);
        return { ok: true, value };
      } catch (e) {
        onError?.(channel, e);
        // Message only (no stack, no paths with secrets), redacted.
        const message = redactor.redact((e as Error)?.message ?? String(e)).slice(0, 1000);
        return { ok: false, error: { code: 'failed', message } };
      }
    },
  };
}
