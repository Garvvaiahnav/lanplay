// Role wiring shared by the GUI and the headless CLI modes. No Electron import: main.ts injects what it needs.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LANPLAY, SUNSHINE } from '../contracts.js';
import type { AppInfo, ClientService, DiagnosticsService, HostService, IpcEventChannel, IpcEventMap, Role, SelfCheckReport, ServiceDeps } from '../contracts.js';
import { createMacClientService } from '../core/client/service.js';
import { clientDiagnosticsFiles, macSystemInfo } from '../core/client/diagnostics-client.js';
import { moonlightCandidates } from '../core/client/moonlight.js';
import { createDiagnosticsService } from '../core/diagnostics.js';
import { hostDiagnosticsFiles, hostListeners, hostSystemInfo } from '../core/host/diagnostics-host.js';
import { createWindowsHostService, LazySunshineClient, PINNED_CERT_NAME } from '../core/host/service.js';
import type { WindowsHostService } from '../core/host/service.js';
import type { IpcHandlers } from './ipc.js';

export interface WiringEnv {
  role: Role;
  deps: ServiceDeps;
  appInfo: { name: string; version: string; electron: string; node: string; chrome: string };
  selfExe: string;
  selfArgsPrefix: readonly string[];
  isPackaged: boolean;
  appRoot: string;
  loginItem: { get(): boolean; set(on: boolean): void } | null;
  fileExists: (p: string) => boolean;
}

export interface Services {
  client: ClientService | null;
  host: WindowsHostService | null;
  diagnostics: DiagnosticsService;
  selfCheck: () => Promise<SelfCheckReport>;
  resolvedPaths: Record<string, unknown>;
}

export function findMoonlight(env: WiringEnv): string | null {
  const devVendor = env.isPackaged ? null : path.join(env.appRoot, 'vendor');
  const list = moonlightCandidates(env.deps.paths.vendorDir, devVendor);
  return list.find((p) => env.fileExists(p)) ?? null;
}

export function buildServices(env: WiringEnv): Services {
  const { deps } = env;
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  let client: ClientService | null = null;
  let host: WindowsHostService | null = null;
  const resolvedPaths: Record<string, unknown> = { selfExe: env.selfExe, role: env.role, systemRoot: env.role === 'host' ? systemRoot : null };
  if (env.role === 'client') {
    const ml = findMoonlight(env);
    resolvedPaths.moonlight = ml;
    client = createMacClientService(deps, { moonlightBinary: ml });
  } else {
    host = createWindowsHostService(deps, { selfExe: env.selfExe, selfArgsPrefix: env.selfArgsPrefix, loginItem: env.loginItem, systemRoot });
    resolvedPaths.bundledMsi = path.join(deps.paths.vendorDir, SUNSHINE.msiAsset);
    resolvedPaths.pinnedCert = path.join(deps.paths.sharedData, PINNED_CERT_NAME);
    resolvedPaths.psDir = deps.paths.psDir;
  }
  const selfCheck = () => (client ? client.selfCheck() : host!.selfCheck());
  const diagnostics = createDiagnosticsService({
    role: env.role,
    paths: deps.paths,
    redactor: deps.log.redactor,
    app: env.appInfo,
    selfCheck,
    resolvedPaths,
    system: async () => {
      if (env.role === 'host') return hostSystemInfo({ runner: deps.runner, redactor: deps.log.redactor, paths: deps.paths, systemRoot });
      return macSystemInfo(deps.runner);
    },
    ...(env.role === 'host' ? { listeners: () => hostListeners({ runner: deps.runner, redactor: deps.log.redactor, paths: deps.paths, systemRoot }) } : {}),
    extraFiles: async () => {
      if (env.role === 'client') return clientDiagnosticsFiles();
      const certPath = path.join(deps.paths.sharedData, PINNED_CERT_NAME);
      return hostDiagnosticsFiles({
        runner: deps.runner,
        redactor: deps.log.redactor,
        paths: deps.paths,
        systemRoot,
        selfExe: env.selfExe,
        sunshine: new LazySunshineClient(certPath, () => deps.secrets.get('sunshine-admin-password'), (r) => deps.log.rest(r)),
        pinnedCertPath: certPath,
      });
    },
  });
  return { client, host, diagnostics, selfCheck, resolvedPaths };
}

export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

export function buildHandlers(
  env: WiringEnv,
  s: Services,
  push: <E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]) => void,
  reveal: (zipPath: string) => void,
): IpcHandlers {
  const revealable = new Set<string>();
  // One run at a time for long operations (double clicks share the running promise).
  const inflight = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const cur = inflight.get(key) as Promise<T> | undefined;
    if (cur) return cur;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  const appInfo = async (): Promise<AppInfo> => ({
    role: env.role,
    version: env.appInfo.version,
    platform: process.platform,
    arch: process.arch,
    logFile: env.deps.log.currentFile(),
    hostName: os.hostname(),
    localAddresses: localAddresses(),
  });
  const common: IpcHandlers = {
    'app:info': appInfo,
    'selfcheck:run': () => once('selfcheck', () => s.selfCheck()),
    'diagnostics:collect': async () => {
      const r = await once('diagnostics', () => s.diagnostics.collect());
      revealable.add(r.zipPath);
      env.deps.log.log('info', 'main', 'diagnostics written', { zipPath: r.zipPath, bytes: r.bytes });
      return r;
    },
    'diagnostics:reveal': async ({ zipPath }) => {
      if (!revealable.has(zipPath)) throw new Error('Only a diagnostics file created in this session can be shown.');
      reveal(zipPath);
    },
  };
  const c = s.client;
  if (c) {
    return {
      ...common,
      'client:system-info': () => c.systemInfo(),
      'client:discover-start': async () => {
        c.discovery.start((hosts) => push('client:hosts-updated', hosts));
        return c.discovery.list();
      },
      'client:discover-stop': async () => c.discovery.stop(),
      'client:add-manual-host': ({ address }) => c.discovery.addManual(address),
      'client:settings-get': async () => c.getSettings(),
      'client:settings-set': async (st) => c.setSettings(st),
      'client:pair': ({ hostId }) => once(`pair:${hostId}`, () => c.pair(hostId, (p) => push('client:pair-progress', p))),
      'client:stream-start': ({ hostId, settings }) => c.startStream(hostId, settings, (st) => push('client:stream-state', st)),
      'client:stream-stop': ({ hostId }) => c.stopStream(hostId),
    };
  }
  const h = s.host!;
  return {
    ...common,
    'host:setup-status': () => h.setupStatus(),
    'host:setup-run': () => once('setup', () => h.runSetup((rec) => push('host:setup-progress', rec))),
    'host:agent-state': async () => h.agent.getState(),
    'host:agent-set-auto-approve': async ({ on }) => {
      await h.agent.setAutoApprove(on);
      return h.agent.getState();
    },
    'host:agent-decide': async ({ requestId, approve }) => {
      await h.agent.decide(requestId, approve);
      return h.agent.getState();
    },
    'host:devices-list': () => h.agent.listDevices(),
    'host:devices-revoke': async ({ uuid }) => {
      await h.agent.revoke(uuid);
      return h.agent.listDevices();
    },
  };
}

/** --self-check: JSON to stdout AND to a file next to the logs (Windows GUI exes have no console). */
export async function runSelfCheckCli(s: Services, logDir: string, print: (t: string) => void): Promise<number> {
  const rep = await s.selfCheck();
  const text = JSON.stringify(rep, null, 2);
  try {
    mkdirSync(logDir, { recursive: true });
    const f = path.join(logDir, `selfcheck-${rep.startedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(f, text, 'utf8');
    print(text);
    print(`\nSelf-check ${rep.ok ? 'PASSED' : 'FAILED'} (${rep.steps.filter((x) => x.status === 'fail').length} failed). Saved to ${f}`);
  } catch {
    print(text);
  }
  return rep.ok ? 0 : 1;
}

export async function runDiagnosticsCli(s: Services, out: string | null, print: (t: string) => void): Promise<number> {
  const r = await s.diagnostics.collect(out ?? undefined);
  print(r.zipPath);
  return 0;
}

export const AGENT_PORT = LANPLAY.agentPort;
