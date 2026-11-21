// Electron main process: CLI dispatch, security policy, window, IPC. Logic lives in src/core (tested without Electron).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, screen, session, shell } from 'electron';
import { IPC_INVOKE_CHANNELS, LANPLAY, SECURITY } from '../contracts.js';
import type { IpcEventChannel, IpcEventMap, Role, ServiceDeps } from '../contracts.js';
import { StreamMenuController } from '../core/client/stream-menu.js';
import { CONTROLLER_PORT, ControllerService } from '../core/controller/service.js';
import { runControllerSetup } from '../core/controller/setup.js';
import { createPadBackendFor } from '../core/controller/backend.js';
import { isPrivateAddress } from '../core/shared/ipnet.js';
import { computeAppPaths } from '../core/paths.js';
import { NodeProcessRunner } from '../core/shared/exec.js';
import { createJsonlLogger, resolveLogLevel } from '../core/shared/logger.js';
import { chooseSecretStore, JsonFileStore } from '../core/shared/stores.js';
import { CliError, parseCli, readStoredRole, resolveRole } from './cli.js';
import type { CliOptions } from './cli.js';
import { createIpcRouter } from './ipc.js';
import { applySecurity, isAllowedAppUrl } from './security.js';
import { createStreamMenuWindow } from './stream-menu-window.js';
import { createUpdates } from './updates.js';
import { buildHandlers, buildServices, createPollWhileActive, localAddresses, releaseMacHost, runDiagnosticsCli, runSelfCheckCli } from './wiring.js';
import type { Services, WiringEnv } from './wiring.js';

const APP_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIR = path.join(APP_ROOT, 'dist', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const MENU_PRELOAD = path.join(__dirname, '..', 'preload', 'menu-preload.js');

/** Real write test: on Windows accessSync(W_OK) only looks at the read-only attribute, not at the folder's ACL. */
function canWrite(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(): CliOptions | null {
  try {
    return parseCli(process.argv.slice(app.isPackaged ? 1 : 2));
  } catch (e) {
    process.stderr.write(`LanPlay: ${(e as Error).message}\n`);
    return null;
  }
}
const parsed = parseArgs();
const cli: CliOptions = parsed ?? { mode: 'gui', role: null, out: null, handoff: null, result: null, json: false, ignored: [] };
// Effective role is resolved in start() once the shared settings store is readable (--role flag > stored 'app.role' > platform default).
let role: Role = cli.role ?? (process.platform === 'win32' ? 'host' : 'client');
const headless = cli.mode === 'self-check' || cli.mode === 'diagnostics' || cli.mode === 'host-setup';

if (!parsed) {
  app.exit(2);
} else if (!headless && !app.requestSingleInstanceLock({ role: cli.role })) {
  // GUI and --agent share one instance: opening LanPlay while the login-item agent runs shows the window in that
  // process (no second agent fighting over port 47920). Headless modes never take the lock.
  app.quit();
} else {
  void start();
}

async function start(): Promise<void> {
  if (headless || cli.mode === 'agent') app.dock?.hide();
  if (headless) app.disableHardwareAcceleration();
  // The elevated child must not touch the user's Chromium profile (cache files owned by an elevated token).
  if (cli.mode === 'host-setup') app.setPath('userData', path.join(app.getPath('temp'), 'LanPlay-elevated'));
  await app.whenReady();

  const paths = computeAppPaths({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    userData: app.getPath('userData'),
    desktop: app.getPath('desktop'),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: APP_ROOT,
    canWrite,
  });
  const settings = new JsonFileStore(path.join(paths.sharedData, 'settings.json'));
  // The elevated setup child is only ever started by the host role.
  const resolved = cli.mode === 'host-setup' ? resolveRole({ flag: cli.role ?? 'host', stored: null, platform: process.platform }) : resolveRole({ flag: cli.role, stored: readStoredRole(settings), platform: process.platform });
  role = resolved.role;
  const log = createJsonlLogger({ dir: paths.logDir, filePattern: cli.mode === 'host-setup' ? LANPLAY.elevatedLogFilePattern : LANPLAY.logFilePattern, minLevel: resolveLogLevel(app.isPackaged, process.env) });
  log.log('info', 'main', 'start', { mode: cli.mode, role, roleSource: resolved.source, version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch, packaged: app.isPackaged, logDirFellBack: paths.logDirFellBack, ignoredArgs: cli.ignored });
  process.on('uncaughtException', (e) => log.log('error', 'main', 'uncaught exception', { error: e.message, stack: String(e.stack).split('\n').slice(0, 8) }));
  process.on('unhandledRejection', (e) => log.log('error', 'main', 'unhandled rejection', { error: String((e as Error)?.message ?? e) }));

  const secrets = chooseSecretStore(safeStorage, paths.userData, process.platform);
  const deps: ServiceDeps = {
    log,
    paths,
    secrets,
    settings,
    runner: new NodeProcessRunner(log.redactor),
  };
  const selfArgsPrefix = app.isPackaged ? [] : [APP_ROOT];
  // Phone controllers: host role only. Virtual Xbox pads need Windows (ViGEmBus); elsewhere the backend just reports it is unavailable.
  const controllers =
    role === 'host'
      ? new ControllerService({
          backend: createPadBackendFor(process.platform, { vigemDllPath: path.join(paths.vendorDir, 'ViGEmClient.dll') }),
          layoutsDir: path.join(paths.userData, 'controller-layouts'),
          uiDir: path.join(APP_ROOT, 'dist', 'controller-ui'),
          port: CONTROLLER_PORT,
          settings,
          localAddresses: () => localAddresses().filter((a) => isPrivateAddress(a)),
          isAllowedAddress: (a) => isPrivateAddress(a),
          log: (level, msg, data) => log.log(level, 'controllers', msg, data),
          // The driver and firewall setup is a Windows UAC flow.
          runSetup:
            process.platform === 'win32'
              ? () =>
                  runControllerSetup({
                    runner: deps.runner,
                    redactor: log.redactor,
                    systemRoot: process.env.SystemRoot || process.env.windir || 'C:\\Windows',
                    psDir: paths.psDir,
                    installerPath: path.join(paths.vendorDir, 'ViGEmBus_1.22.0_x64_x86_arm64.exe'),
                    selfExe: process.execPath,
                    port: CONTROLLER_PORT,
                  })
              : async () => ({ ok: false, message: 'Phone controllers need Windows.' }),
        })
      : null;
  const env: WiringEnv = {
    controllers,
    role,
    deps,
    appInfo: { name: LANPLAY.productName, version: app.getVersion(), electron: process.versions.electron ?? '', node: process.versions.node, chrome: process.versions.chrome ?? '' },
    selfExe: process.execPath,
    selfArgsPrefix,
    isPackaged: app.isPackaged,
    appRoot: APP_ROOT,
    fileExists: existsSync,
    platform: process.platform,
    // A Mac that has nothing stored is not asked (needsChoice is Windows-only), so for it "stored" is true.
    roleChoice: { canChoose: resolved.canChoose, stored: resolved.source !== 'default' || !resolved.needsChoice },
    relaunch: (r) => {
      log.log('info', 'main', 'relaunching with new role', { role: r });
      const args = process.argv.slice(1).filter((a, i, all) => a !== '--role' && all[i - 1] !== '--role' && !a.startsWith('--role='));
      app.relaunch({ args: [...args, '--role', r] });
      app.exit(0);
    },
    openExternal: (url) => shell.openExternal(url),
    // The Mac host starts at login through its own LaunchAgents, not through Electron's login item.
    loginItem:
      process.platform === 'win32'
        ? {
            get: () => app.getLoginItemSettings({ path: process.execPath, args: [...selfArgsPrefix, '--agent'] }).openAtLogin,
            set: (on) => app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [...selfArgsPrefix, '--agent'] }),
          }
        : null,
  };
  const services = buildServices(env);
  log.log('info', 'main', 'secrets backend', { backend: secrets.backend() });

  const print = (t: string) => process.stdout.write(t + '\n');
  try {
    if (cli.mode === 'self-check') return app.exit(await runSelfCheckCli(services, paths.logDir, print));
    if (cli.mode === 'diagnostics') return app.exit(await runDiagnosticsCli(services, cli.out, print));
    if (cli.mode === 'host-setup') {
      if (role !== 'host' || !services.host || process.platform !== 'win32') throw new CliError('--host-setup is only for the Windows host');
      return app.exit(await services.host.runElevatedSetup(cli.handoff!, cli.result!));
    }
  } catch (e) {
    log.log('error', 'main', `${cli.mode} failed`, { error: (e as Error).message });
    process.stderr.write(`LanPlay ${cli.mode} failed: ${(e as Error).message}\n`);
    return app.exit(1);
  }

  // A Mac switched to the client role must not keep a Sunshine or pair agent running (or starting at login).
  const releaseMac = async () => {
    try {
      await releaseMacHost(env);
    } catch (e) {
      log.log('warn', 'main', 'could not remove the Mac host LaunchAgents', { error: (e as Error).message });
    }
  };
  // The background agent may be the very process the LaunchAgent started: it must be released before it decides to exit.
  // The window is not: it opens first and the two launchctl calls run behind it.
  if (cli.mode === 'agent') await releaseMac();

  // A Windows PC switched to the client role keeps its old --agent login item: nothing to run in the background.
  if (cli.mode === 'agent' && role === 'client') {
    log.log('info', 'main', '--agent ignored: this computer is a client');
    return app.exit(0);
  }

  // GUI / agent
  let streamMenu: StreamMenuController | null = null;
  const updates = createUpdates({
    app,
    net,
    dialog,
    stageDir: path.join(paths.userData, 'updates'),
    mode: cli.mode === 'agent' ? 'agent' : 'gui',
    isStreaming: () => streamMenu?.activeHostId() != null,
    log: (level, msg, data) => log.log(level, 'update', msg, data),
  });
  // A verified update downloaded earlier is installed first: the installer starts and this process exits.
  if (updates.applyStagedAtLaunch()) return;
  env.checkForUpdates = updates.checkNow; // `env` is built before the updater, which needs the stream menu
  applySecurity(
    { app, session: session.defaultSession, openExternal: (u) => shell.openExternal(u), protocol, netFetch: (u, i) => net.fetch(u, i) },
    RENDERER_DIR,
    (msg, data) => log.log('warn', 'security', msg, data),
  );
  let win: BrowserWindow | null = null;
  let startupLogged = false;
  let menuPoll: ReturnType<typeof createPollWhileActive> | null = null;
  const push = <E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]) => {
    // The in-stream menu follows the same stream-state events the window gets (including streams it restarts itself).
    if (channel === 'client:stream-state') {
      streamMenu?.onStreamState(payload as IpcEventMap['client:stream-state']);
      menuPoll?.sync();
    }
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const router = createIpcRouter(buildHandlers(env, services, push, (p) => shell.showItemInFolder(p)), log.redactor, (channel, err) =>
    log.log('warn', 'ipc', `${channel} failed`, { error: (err as Error)?.message ?? String(err) }),
  );
  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      const url = event.senderFrame?.url ?? '';
      if (!isAllowedAppUrl(url, RENDERER_DIR)) {
        log.log('warn', 'ipc', 'rejected IPC from unexpected frame', { channel, url });
        return { ok: false, error: { code: 'forbidden', message: 'Forbidden' } };
      }
      return router.dispatch(channel, raw);
    });
  }

  if (controllers) {
    controllers.onChange((st) => push('host:controllers-changed', st));
    // Left on at the last run: phones can connect again without opening the window (also in the background --agent mode).
    void controllers.init();
  }
  if (services.host) {
    services.host.agent.onChange((s) => push('host:agent-state-changed', s));
    const auto = services.host.agentAutoStart();
    if (auto.start) services.host.agent.start().catch((e: Error) => log.log('error', 'main', 'pair agent did not start', { error: e.message }));
    else {
      log.log('info', 'main', 'pair agent not started yet', { reason: auto.reason ?? null });
      services.host.agentIdle(auto.reason);
    }
  }

  const createWindow = () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 980,
      height: 760,
      minWidth: 720,
      minHeight: 560,
      show: false,
      title: LANPLAY.productName,
      backgroundColor: '#111318',
      webPreferences: { ...SECURITY.webPreferences, preload: PRELOAD },
    });
    win.once('ready-to-show', () => {
      win?.show();
      if (!startupLogged) {
        startupLogged = true;
        const created = process.getCreationTime?.() ?? null;
        log.log('info', 'main', 'startup-ms', { ms: Math.round(created === null ? process.uptime() * 1000 : Date.now() - created) });
      }
    });
    win.on('closed', () => {
      win = null;
    });
    void win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  };

  app.on('second-instance', () => createWindow());
  app.on('activate', () => createWindow());
  app.on('window-all-closed', () => {
    // Host keeps running in the background so the pair agent stays reachable; client quits.
    if (role === 'client') app.quit();
  });
  app.on('before-quit', () => {
    void controllers?.shutdown();
    void services.host?.agent.stop();
    services.client?.discovery.stop();
  });
  // Client only: move the cursor into a screen corner while streaming to get Close / Change settings / Reconnect.
  if (services.client) {
    const client = services.client;
    const menuWindow = createStreamMenuWindow({
      rendererDir: RENDERER_DIR,
      preload: MENU_PRELOAD,
      onChoose: (a) => void streamMenu?.choose(a).catch((e: Error) => log.log('error', 'stream-menu', `${a} failed`, { error: e.message })),
      onClosed: () => streamMenu?.menuClosed(),
      warn: (msg, data) => log.log('warn', 'stream-menu', msg, data),
    });
    const ctl = new StreamMenuController({
      getCursor: () => screen.getCursorScreenPoint(),
      getDisplays: () => screen.getAllDisplays().map((d) => d.bounds),
      now: () => Date.now(),
      openMenu: (display) => menuWindow.open(display),
      closeMenu: () => menuWindow.close(),
      stopStream: (hostId) => client.stopStream(hostId),
      startStream: (hostId) => client.startStream(hostId, client.getSettings(), (st) => push('client:stream-state', st)),
      showMainWindow: () => createWindow(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    streamMenu = ctl;
    // The cursor is only watched while a stream is starting or running; an idle app has no timer.
    menuPoll = createPollWhileActive({ tick: () => ctl.tick(), pollMs: ctl.pollMs, isActive: () => ctl.activeHostId() !== null });
  }

  updates.start();
  if (cli.mode !== 'agent') {
    createWindow();
    void releaseMac();
  } else log.log('info', 'main', 'running as background pair agent (open LanPlay to show the window)');
}

export type { Services };
