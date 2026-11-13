// Sandboxed preload: exposes window.lanplay (LanPlayPreloadApi) with a strict channel allow-list.
// A sandboxed preload may only require('electron'), so the allow-lists are inlined here; tests/main/preload.test.ts
// checks they equal IPC_INVOKE_CHANNELS / IPC_EVENT_CHANNELS in src/contracts.ts.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcEnvelope, LanPlayPreloadApi } from '../contracts.js';

const INVOKE_CHANNELS: readonly string[] = [
  'app:info',
  'client:system-info',
  'client:discover-start',
  'client:discover-stop',
  'client:add-manual-host',
  'client:settings-get',
  'client:settings-set',
  'client:pair',
  'client:stream-start',
  'client:stream-stop',
  'host:setup-status',
  'host:setup-run',
  'host:agent-state',
  'host:agent-set-auto-approve',
  'host:agent-decide',
  'host:devices-list',
  'host:devices-revoke',
  'selfcheck:run',
  'diagnostics:collect',
  'diagnostics:reveal',
];

const EVENT_CHANNELS: readonly string[] = ['client:hosts-updated', 'client:pair-progress', 'client:stream-state', 'host:setup-progress', 'host:agent-state-changed'];

const api = {
  async invoke(channel: string, ...req: unknown[]): Promise<unknown> {
    if (!INVOKE_CHANNELS.includes(channel)) throw new Error(`Blocked IPC channel: ${String(channel)}`);
    if (req.length > 1) throw new Error('Too many arguments');
    const env = (await ipcRenderer.invoke(channel, req[0])) as IpcEnvelope<unknown>;
    if (!env || typeof env !== 'object') throw new Error('Bad reply from the app');
    if (env.ok) return env.value;
    const err = new Error(env.error?.message ?? 'Failed');
    (err as Error & { code?: string }).code = env.error?.code;
    throw err;
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`Blocked IPC event: ${String(channel)}`);
    if (typeof listener !== 'function') throw new Error('listener must be a function');
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
} as unknown as LanPlayPreloadApi;

contextBridge.exposeInMainWorld('lanplay', api);
