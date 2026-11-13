import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { IpcEventChannel, IpcEventMap, IpcInvokeChannel, LanPlayPreloadApi } from '../../src/contracts.js';

export const RENDERER_DIR = join(__dirname, '..', '..', 'src', 'renderer');
export const SCRIPT_ORDER = ['dom', 'model', 'client', 'host', 'app'] as const;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type LP = any;

let compiled: Map<string, string> | null = null;

/** Compile the renderer exactly like `tsc -p tsconfig.json` does (full program, so namespace aliases resolve). */
function compileRenderer(): Map<string, string> {
  if (compiled) return compiled;
  const out = new Map<string, string>();
  const root = join(__dirname, '..', '..');
  const cfg = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const files = SCRIPT_ORDER.map((n) => join(RENDERER_DIR, n + '.ts'));
  const program = ts.createProgram(files, { ...parsed.options, noEmit: false, sourceMap: false, outDir: join(root, '.tmp-ui-out') });
  program.emit(undefined, (fileName, text) => {
    out.set(fileName.replace(/^.*[\\/]/, '').replace(/\.js$/, ''), text);
  });
  compiled = out;
  return out;
}

export function loadRenderer(): LP {
  const g = globalThis as Record<string, unknown>;
  g['__LANPLAY_NO_AUTOSTART__'] = true;
  (g['window'] as Record<string, unknown>)['__LANPLAY_NO_AUTOSTART__'] = true;
  const js = compileRenderer();
  for (const name of SCRIPT_ORDER) {
    const text = js.get(name);
    if (!text) throw new Error('renderer script did not compile: ' + name);
    // strict-mode indirect eval would keep `var LP` private to the eval; the browser's classic script is global.
    (0, eval)(text.replace(/^"use strict";/, ''));
  }
  return g['LP'];
}

type Handler = (req: unknown) => unknown | Promise<unknown>;

export interface FakeApi extends LanPlayPreloadApi {
  calls: Array<{ channel: string; req: unknown }>;
  handlers: Record<string, Handler>;
  emit<E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]): void;
  called(channel: string): Array<unknown>;
}

export function fakeApi(handlers: Record<string, Handler>): FakeApi {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const api = {
    calls: [] as FakeApi['calls'],
    handlers,
    async invoke(channel: IpcInvokeChannel, ...req: unknown[]) {
      api.calls.push({ channel, req: req[0] });
      const h = api.handlers[channel];
      if (!h) throw new Error('no handler for ' + channel);
      return h(req[0]);
    },
    on(channel: string, cb: (p: unknown) => void) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(cb);
      return () => listeners.get(channel)!.delete(cb);
    },
    emit(channel: string, payload: unknown) {
      for (const cb of listeners.get(channel) ?? []) cb(payload);
    },
    called(channel: string) {
      return api.calls.filter((c) => c.channel === channel).map((c) => c.req);
    },
  };
  return api as unknown as FakeApi;
}

/** Let pending promise callbacks run (works with fake timers too). */
export async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

export function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error('missing element: ' + sel);
  return el;
}

export function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === text);
  if (!b) throw new Error('missing button: ' + text + ' in ' + (root as HTMLElement).textContent?.slice(0, 200));
  return b as HTMLButtonElement;
}

export const HOST_A = { id: 'uid-a', name: 'GAMING-PC', addresses: ['192.168.1.20'], preferredAddress: '192.168.1.20', sources: ['mdns'], httpPort: 47989, agentReachable: true, paired: true, lastSeen: '2026-01-01T00:00:00Z' } as const;
export const HOST_B = { id: 'addr:192.168.1.30', name: '192.168.1.30', addresses: ['192.168.1.30'], preferredAddress: '192.168.1.30', sources: ['manual'], httpPort: 47989, agentReachable: true, paired: false, lastSeen: '2026-01-01T00:00:00Z' } as const;

export const DEFAULTS = { presetId: 'balanced', resolution: '1440p', fps: 120, bitrateMbps: 80, advancedBitrate: false, codec: 'auto', audio: 'stereo', displayMode: 'fullscreen', vsync: false, framePacing: true, appName: 'Desktop' } as const;
