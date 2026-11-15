// Role wiring shared by the GUI and the headless CLI modes. No Electron import: main.ts injects what it needs.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LANPLAY, SUNSHINE, SUNSHINE_MAC } from '../contracts.js';
import type { AppInfo, ClientService, DiagnosticsService, HostSetupStatus, IpcEventChannel, IpcEventMap, Role, SelfCheckReport, ServiceDeps } from '../contracts.js';
import { createMacClientService } from '../core/client/service.js';
import { clientDiagnosticsFiles, macSystemInfo, winClientSystemInfo } from '../core/client/diagnostics-client.js';
import { moonlightLogDir } from '../core/client/platform.js';
import { writeStoredRole } from '../core/client/role.js';
import { moonlightCandidates } from '../core/client/moonlight.js';
import { createDiagnosticsService, readTailText } from '../core/diagnostics.js';
import { hostDiagnosticsFiles, hostListeners, hostSystemInfo } from '../core/host/diagnostics-host.js';
import { hostDiagnosticsFilesMac, hostListenersMac } from '../core/host/mac/diagnostics-host-mac.js';
import { macosMajorFromDarwin, settingsUrl } from '../core/host/mac/permissions-mac.js';
import { createMacHostService, locateBundledSunshine, teardownMacHost } from '../core/host/mac/service-mac.js';
import type { MacHostService } from '../core/host/mac/service-mac.js';
import type { ControllerService } from '../core/controller/service.js';
import { createWindowsHostService, LazySunshineClient, PINNED_CERT_NAME } from '../core/host/service.js';
import type { PlatformHostService } from '../core/host/service.js';
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
  /** Defaults to process.platform (tests pass 'win32'). */
  platform?: NodeJS.Platform;
  /** Windows role choice (from resolveRole). Absent = role is fixed. */
  roleChoice?: { canChoose: boolean; stored: boolean };
  /** Relaunch the app with --role <role> (main: app.relaunch + app.exit). */
  relaunch?: (role: Role) => void;
  /** Phone controllers (host role only); main builds it because it needs Electron paths and the elevated setup. */
  controllers?: ControllerService | null;
  /** Opens a URL in the default handler (main: shell.openExternal). The macOS host screen uses it for System Settings. */
  openExternal?: (url: string) => Promise<void>;
  /** The user's home folder and uid, for the macOS LaunchAgents. Default: the real ones (tests pass a temp folder). */
  home?: string;
  uid?: number;
}

/** WindowsHostService predates PlatformHostService and has no Sunshine-update notion, so that method is optional here. */
export type WiredHostService = Omit<PlatformHostService, 'pendingSunshineUpdate'> & Partial<Pick<PlatformHostService, 'pendingSunshineUpdate'>>;

/** What only the macOS host service can do; the Windows one has no equivalent. */
export type MacHostControls = Pick<MacHostService, 'confirmInput' | 'restartSunshine'>;

export interface Services {
  client: ClientService | null;
  host: WiredHostService | null;
  /** The same object as `host` on a Mac host; absent everywhere else. */
  macHost?: MacHostControls | null;
  controllers: ControllerService | null;
  diagnostics: DiagnosticsService;
  selfCheck: () => Promise<SelfCheckReport>;
  resolvedPaths: Record<string, unknown>;
}

export function findMoonlight(env: WiringEnv): string | null {
  const devVendor = env.isPackaged ? null : path.join(env.appRoot, 'vendor');
  const list = moonlightCandidates(env.deps.paths.vendorDir, devVendor, env.platform ?? process.platform, process.env);
  return list.find((p) => env.fileExists(p)) ?? null;
}

/** Hosting needs Windows, or an Apple Silicon Mac on a macOS version Sunshine's audio capture supports. */
export function hostSupported(platform: NodeJS.Platform, arch: string, osRelease: string): boolean {
  if (platform === 'win32') return true;
  return platform === 'darwin' && arch === 'arm64' && (macosMajorFromDarwin(osRelease) ?? 0) >= SUNSHINE_MAC.minMacOS;
}

const macHome = (env: WiringEnv) => env.home ?? os.homedir();
const macUid = (env: WiringEnv) => env.uid ?? process.getuid?.() ?? 0;

/** Switching a Mac to the client role must leave no Sunshine or pair agent behind (see teardownMacHost). */
export async function releaseMacHost(env: Pick<WiringEnv, 'role' | 'platform' | 'deps' | 'home' | 'uid'>): Promise<void> {
  if ((env.platform ?? process.platform) !== 'darwin' || env.role !== 'client') return;
  await teardownMacHost({ runner: env.deps.runner, log: env.deps.log, home: macHome(env as WiringEnv), uid: macUid(env as WiringEnv) });
}

export function buildServices(env: WiringEnv): Services {
  const { deps } = env;
  const platform = env.platform ?? process.platform;
  const mac = platform === 'darwin';
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  let client: ClientService | null = null;
  let host: WiredHostService | null = null;
  let macHost: MacHostService | null = null;
  const resolvedPaths: Record<string, unknown> = { selfExe: env.selfExe, role: env.role, systemRoot: env.role === 'host' && !mac ? systemRoot : null };
  if (env.role === 'client') {
    const ml = findMoonlight(env);
    resolvedPaths.moonlight = ml;
    client = createMacClientService(deps, { moonlightBinary: ml, platform });
  } else if (mac) {
    macHost = createMacHostService(deps, {
      selfExe: env.selfExe,
      selfArgsPrefix: env.selfArgsPrefix,
      home: macHome(env),
      uid: macUid(env),
      macOS: { major: macosMajorFromDarwin(os.release()) ?? 0, arch: process.arch },
    });
    host = macHost;
    resolvedPaths.bundledSunshine = locateBundledSunshine(deps.paths.resources);
    resolvedPaths.pinnedCert = path.join(deps.paths.sharedData, PINNED_CERT_NAME);
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
    secrets: async () => {
      const pw = await deps.secrets.get('sunshine-admin-password');
      return pw ? [pw] : [];
    },
    // The elevated setup helper always logs under %ProgramData%\LanPlay\logs, even when this session fell back.
    ...(env.role === 'host' && !mac ? { extraLogDirs: [path.join(deps.paths.sharedData, 'logs')] } : {}),
    system: async () => {
      if (env.role === 'host' && !mac) return hostSystemInfo({ runner: deps.runner, redactor: deps.log.redactor, paths: deps.paths, systemRoot });
      return platform === 'win32' ? winClientSystemInfo() : macSystemInfo(deps.runner);
    },
    ...(env.role === 'host'
      ? { listeners: () => (mac ? hostListenersMac({ runner: deps.runner }) : hostListeners({ runner: deps.runner, redactor: deps.log.redactor, paths: deps.paths, systemRoot })) }
      : {}),
    extraFiles: async () => {
      if (env.role === 'client') return clientDiagnosticsFiles(moonlightLogDir(platform));
      const certPath = path.join(deps.paths.sharedData, PINNED_CERT_NAME);
      const sunshine = new LazySunshineClient(certPath, () => deps.secrets.get('sunshine-admin-password'), (r) => deps.log.rest(r));
      if (mac) {
        return hostDiagnosticsFilesMac({
          runner: deps.runner,
          redactor: deps.log.redactor,
          paths: deps.paths,
          fs: { exists: env.fileExists, readTail: readTailText },
          sunshine,
          home: macHome(env),
          uid: macUid(env),
        });
      }
      return hostDiagnosticsFiles({
        runner: deps.runner,
        redactor: deps.log.redactor,
        paths: deps.paths,
        systemRoot,
        selfExe: env.selfExe,
        sunshine,
        pinnedCertPath: certPath,
      });
    },
  });
  return { client, host, macHost, controllers: env.role === 'host' ? (env.controllers ?? null) : null, diagnostics, selfCheck, resolvedPaths };
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
    hostSupported: hostSupported(process.platform, process.arch, os.release()),
    canChooseRole: env.roleChoice?.canChoose ?? false,
    roleStored: env.roleChoice?.stored ?? true,
  });
  const common: IpcHandlers = {
    'app:info': appInfo,
    'app:role-set': async ({ role }) => {
      if (!env.roleChoice?.canChoose) throw new Error('The role of this computer cannot be changed here.');
      const r = writeStoredRole(env.deps.settings, role);
      env.deps.log.log('info', 'main', 'role chosen', { role: r, running: env.role });
      env.roleChoice = { ...env.roleChoice, stored: true };
      if (r === env.role) return { relaunching: false };
      // Let the IPC reply reach the renderer before the process exits.
      setTimeout(() => env.relaunch?.(r), 300);
      return { relaunching: true };
    },
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
  // The Mac host screen offers "Restart Sunshine" when the bundled copy is newer than the installed one.
  const withUpdate = async (status: Promise<HostSetupStatus>): Promise<HostSetupStatus> => ({ ...(await status), sunshineUpdate: h.pendingSunshineUpdate?.() ?? null });
  const macHandlers = (m: MacHostControls): IpcHandlers => ({
    'host:open-settings': async ({ pane }) => {
      // The validator checked the name already; the URL still comes from main's own table, never from the renderer.
      const url = settingsUrl(pane);
      if (!url) throw new Error('Unknown settings pane.');
      if (!env.openExternal) throw new Error('System Settings cannot be opened from here.');
      await env.openExternal(url);
    },
    'host:confirm-input': ({ ok }) => withUpdate(m.confirmInput(ok)),
    'host:sunshine-restart': () => once('sunshine-restart', () => withUpdate(m.restartSunshine())),
  });
  return {
    ...common,
    'host:setup-status': () => withUpdate(h.setupStatus()),
    'host:setup-run': () => once('setup', () => withUpdate(h.runSetup((rec) => push('host:setup-progress', rec)))),
    ...(s.macHost ? macHandlers(s.macHost) : {}),
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
    ...(s.controllers ? controllerHandlers(s.controllers) : {}),
  };
}

function controllerHandlers(c: ControllerService): IpcHandlers {
  return {
    'host:controllers-state': async () => c.state(),
    'host:controllers-set-enabled': ({ on }) => c.setEnabled(on),
    'host:controllers-kick': async ({ id }) => c.kick(id),
    'host:controllers-new-link': () => c.newLink(),
    'host:controllers-setup': () => c.setup(),
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
