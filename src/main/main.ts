// Electron main process: CLI dispatch, security policy, window, IPC. Logic lives in src/core (tested without Electron).
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session, shell } from 'electron';
import { IPC_INVOKE_CHANNELS, LANPLAY, SECURITY } from '../contracts.js';
import type { IpcEventChannel, IpcEventMap, ServiceDeps } from '../contracts.js';
import { computeAppPaths } from '../core/paths.js';
import { NodeProcessRunner } from '../core/shared/exec.js';
import { createJsonlLogger } from '../core/shared/logger.js';
import { chooseSecretStore, JsonFileStore } from '../core/shared/stores.js';
import { CliError, defaultRole, parseCli } from './cli.js';
import type { CliOptions } from './cli.js';
import { createIpcRouter } from './ipc.js';
import { applySecurity, isAllowedAppUrl } from './security.js';
import { buildHandlers, buildServices, runDiagnosticsCli, runSelfCheckCli } from './wiring.js';
import type { Services, WiringEnv } from './wiring.js';

const APP_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIR = path.join(APP_ROOT, 'dist', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

function canWrite(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
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
const role = cli.role ?? defaultRole(process.platform);
const headless = cli.mode === 'self-check' || cli.mode === 'diagnostics' || cli.mode === 'host-setup';

if (!parsed) {
  app.exit(2);
} else if (!headless && !app.requestSingleInstanceLock({ role })) {
  // GUI and --agent share one instance: opening LanPlay while the login-item agent runs shows the window in that
  // process (no second agent fighting over port 47920). Headless modes never take the lock.
  app.quit();
} else {
  void start();
}

async function start(): Promise<void> {
  if (headless || cli.mode === 'agent') app.dock?.hide();
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
  const log = createJsonlLogger({ dir: paths.logDir, filePattern: cli.mode === 'host-setup' ? LANPLAY.elevatedLogFilePattern : LANPLAY.logFilePattern });
  log.log('info', 'main', 'start', { mode: cli.mode, role, version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch, packaged: app.isPackaged, logDirFellBack: paths.logDirFellBack, ignoredArgs: cli.ignored });
  process.on('uncaughtException', (e) => log.log('error', 'main', 'uncaught exception', { error: e.message, stack: String(e.stack).split('\n').slice(0, 8) }));
  process.on('unhandledRejection', (e) => log.log('error', 'main', 'unhandled rejection', { error: String((e as Error)?.message ?? e) }));

  const secrets = chooseSecretStore(safeStorage, paths.userData, process.platform);
  const deps: ServiceDeps = {
    log,
    paths,
    secrets,
    settings: new JsonFileStore(path.join(paths.sharedData, 'settings.json')),
    runner: new NodeProcessRunner(log.redactor),
  };
  const selfArgsPrefix = app.isPackaged ? [] : [APP_ROOT];
  const env: WiringEnv = {
    role,
    deps,
    appInfo: { name: LANPLAY.productName, version: app.getVersion(), electron: process.versions.electron ?? '', node: process.versions.node, chrome: process.versions.chrome ?? '' },
    selfExe: process.execPath,
    selfArgsPrefix,
    isPackaged: app.isPackaged,
    appRoot: APP_ROOT,
    fileExists: existsSync,
    loginItem:
      process.platform === 'win32' || process.platform === 'darwin'
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
      if (role !== 'host' || !services.host) throw new CliError('--host-setup is only for the Windows host');
      return app.exit(await services.host.runElevatedSetup(cli.handoff!, cli.result!));
    }
  } catch (e) {
    log.log('error', 'main', `${cli.mode} failed`, { error: (e as Error).message });
    process.stderr.write(`LanPlay ${cli.mode} failed: ${(e as Error).message}\n`);
    return app.exit(1);
  }

  // GUI / agent
  applySecurity(
    { app, session: session.defaultSession, openExternal: (u) => shell.openExternal(u), protocol, netFetch: (u, i) => net.fetch(u, i) },
    RENDERER_DIR,
    (msg, data) => log.log('warn', 'security', msg, data),
  );
  let win: BrowserWindow | null = null;
  const push = <E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]) => {
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

  if (services.host) {
    services.host.agent.onChange((s) => push('host:agent-state-changed', s));
    services.host.agent.start().catch((e: Error) => log.log('error', 'main', 'pair agent did not start', { error: e.message }));
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
    win.once('ready-to-show', () => win?.show());
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
    void services.host?.agent.stop();
    services.client?.discovery.stop();
  });
  if (cli.mode !== 'agent') createWindow();
  else log.log('info', 'main', 'running as background pair agent (open LanPlay to show the window)');
}

export type { Services };
