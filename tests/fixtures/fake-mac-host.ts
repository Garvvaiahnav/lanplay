// A fake Mac for macOS host-step tests: an in-memory disk plus a ProcessRunner that behaves like launchctl, ditto,
// codesign, Sunshine (--creds) and socketfilterfw. Every change LanPlay makes through its env or through a process is
// appended to `timeline`, so tests can assert both "nothing was changed" and "X happened before Y".
import type { ExecRequest, ExecResult, ProcessRunner } from '../../src/contracts.js';
import type { MacStepsEnv } from '../../src/core/host/mac/steps-mac.js';
import { SUNSHINE_MAC_TEAM_ID, SUNSHINE_MAC_VERSION } from '../../src/core/host/vendor.js';
import { SUNSHINE_TEST_CERT } from './mock-sunshine.js';

export const HOME = '/Users/me';
export const SHARED = `${HOME}/Library/Application Support/LanPlay`;
export const LOGS = `${HOME}/Library/Logs/LanPlay`;
export const RESOURCES = '/Applications/LanPlay.app/Contents/Resources';
export const BUNDLED = `${RESOURCES}/vendor/Sunshine.app`;
export const SELF_EXE = '/Applications/LanPlay.app/Contents/MacOS/LanPlay';
export const SUNSHINE_APP = `${SHARED}/sunshine/Sunshine.app`;
export const SUNSHINE_BIN = `${SUNSHINE_APP}/Contents/MacOS/Sunshine`;
export const SUNSHINE_LOG = `${LOGS}/sunshine.log`;
export const SUNSHINE_PLIST = `${HOME}/Library/LaunchAgents/dev.lanplay.sunshine.plist`;
export const AGENT_PLIST = `${HOME}/Library/LaunchAgents/dev.lanplay.agent.plist`;

export const DENIED_LOG = [
  '[2026-11-16 10:01:12.331]: Info: Sunshine version: 2026.914.233613',
  '[2026-11-16 10:01:12.402]: Fatal: No screen capture permission!',
  '[2026-11-16 10:01:12.402]: Error: Platform failed to initialize',
  '',
].join('\n');

const infoPlist = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n</dict>\n</plist>\n`;

const ok = (stdout = '', exitCode = 0, stderr = ''): ExecResult => ({ exitCode, signal: null, stdout, stderr, durationMs: 1, timedOut: false });

export class FakeMacHost implements ProcessRunner {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  /** Creation time of files written by a (fake) Sunshine start; other files count as created long ago. */
  readonly born = new Map<string, number>();
  readonly calls: ExecRequest[] = [];
  /** Every change, in order: "write <p>", "copy <a> -> <b>", "mkdir <p>", "remove <p>", "run <file> <argv>". */
  readonly timeline: string[] = [];

  macOS = { major: 26, arch: 'arm64' };
  /** Team that signed each app bundle, by path. */
  readonly teams = new Map<string, string>([[BUNDLED, SUNSHINE_MAC_TEAM_ID]]);
  /** Bundles whose seal is broken (codesign --verify fails). */
  readonly brokenSeal = new Set<string>();
  dittoFails = false;

  /** Screen Recording granted to Sunshine. */
  screenPermission = false;
  /** Something else (a Sunshine run by hand) holds the Sunshine ports. */
  foreignListener = false;
  firewall: 'off' | 'on' | 'block-all' = 'off';
  /** Password the last `--creds` run stored. */
  credsSet: string | null = null;

  loaded = false;
  pid: number | null = null;
  lastExit: number | null = null;
  /** The plist launchd read at bootstrap time. */
  loadedDefinition: string | null = null;
  private nextPid = 4000;

  constructor() {
    this.seedBundle();
  }

  private seedBundle(): void {
    this.dirs.add(BUNDLED);
    this.files.set(`${BUNDLED}/Contents/MacOS/Sunshine`, 'MACHO');
    this.files.set(`${BUNDLED}/Contents/Info.plist`, infoPlist(SUNSHINE_MAC_VERSION));
    this.files.set(`${BUNDLED}/Contents/Frameworks/libqt.dylib`, 'LIB');
  }

  /** What an earlier LanPlay left behind: an older copy with a file the new version no longer ships. */
  seedOldCopy(version: string): void {
    this.dirs.add(SUNSHINE_APP);
    this.files.set(SUNSHINE_BIN, 'OLD-MACHO');
    this.files.set(`${SUNSHINE_APP}/Contents/Frameworks/removed-in-new-version.dylib`, 'STALE');
    this.teams.set(SUNSHINE_APP, SUNSHINE_MAC_TEAM_ID);
    this.files.set(`${SHARED}/sunshine/installed.json`, JSON.stringify({ version, dmgSha256: 'old', teamId: SUNSHINE_MAC_TEAM_ID, copiedAt: '2026-01-01T00:00:00.000Z' }));
  }

  /* ---------- disk (what MacStepsEnv gets) ---------- */
  exists = (f: string): boolean => this.files.has(f) || this.dirs.has(f) || [...this.files.keys()].some((k) => k.startsWith(f + '/'));

  fs(): Pick<MacStepsEnv, 'fileExists' | 'readText' | 'writeText' | 'copyFile' | 'mkdirp' | 'remove' | 'fileBornMs' | 'readLog' | 'rename'> {
    return {
      fileExists: this.exists,
      readText: (f) => this.files.get(f) ?? null,
      writeText: (f, t) => {
        this.timeline.push(`write ${f}`);
        this.files.set(f, t);
      },
      copyFile: (a, b) => {
        this.timeline.push(`copy ${a} -> ${b}`);
        this.files.set(b, this.files.get(a)!);
      },
      mkdirp: (d) => {
        if (this.exists(d)) return;
        this.timeline.push(`mkdir ${d}`);
        this.dirs.add(d);
      },
      remove: (f) => {
        if (!this.exists(f)) return;
        this.timeline.push(`remove ${f}`);
        this.files.delete(f);
        this.dirs.delete(f);
        for (const k of [...this.files.keys()]) if (k.startsWith(f + '/')) this.files.delete(k);
        for (const d of [...this.dirs]) if (d.startsWith(f + '/')) this.dirs.delete(d);
        this.teams.delete(f);
      },
      rename: (from, to) => {
        if (this.exists(to)) throw new Error(`EEXIST: ${to}`);
        this.timeline.push(`rename ${from} -> ${to}`);
        for (const [k, v] of [...this.files]) {
          if (k === from || k.startsWith(from + '/')) {
            this.files.delete(k);
            this.files.set(to + k.slice(from.length), v);
          }
        }
        if (this.dirs.delete(from)) this.dirs.add(to);
        if (this.teams.has(from)) this.teams.set(to, this.teams.get(from)!);
        this.teams.delete(from);
      },
      fileBornMs: (f) => (this.files.has(f) ? (this.born.get(f) ?? 0) : null),
      readLog: (f) => this.files.get(f) ?? null,
    };
  }

  /** Changes LanPlay made (everything on the timeline except read-only process runs). */
  get changes(): string[] {
    return this.timeline.filter((e) => !e.startsWith('run ') || !this.isReadOnlyRun(e));
  }
  private isReadOnlyRun(e: string): boolean {
    return /^run \/bin\/launchctl print |^run \/usr\/bin\/codesign |socketfilterfw/.test(e);
  }

  /* ---------- the network ---------- */
  get listening(): boolean {
    return this.pid !== null;
  }
  tcpProbe = async (_h: string, _port: number): Promise<boolean> => this.listening || this.foreignListener;

  /* ---------- Sunshine under launchd ---------- */
  /** Every Sunshine start (also `--creds`) renames sunshine.log away and opens a new one. */
  writeLog(text: string): void {
    this.files.set(SUNSHINE_LOG, text);
    this.born.set(SUNSHINE_LOG, Date.now());
  }
  /** Like the real one: without the grant Sunshine logs the refusal and keeps running, web UI included (main.cpp). */
  private start(): void {
    this.pid = ++this.nextPid;
    this.lastExit = null;
    this.writeLog(this.screenPermission ? '[2026-11-16 10:02:00.000]: Info: Sunshine version: 2026.914.233613\n[2026-11-16 10:02:01.000]: Info: Configuration UI available at [https://localhost:47990]\n' : DENIED_LOG);
    this.files.set(`${SHARED}/sunshine/credentials/cacert.pem`, SUNSHINE_TEST_CERT);
  }
  /** launchd's KeepAlive: a job that exited is started again (after ThrottleInterval, which tests skip). */
  tick(): void {
    if (this.loaded && this.pid === null) this.start();
  }
  /** The user switches Sunshine on. A running Sunshine does not notice until it starts again. */
  grantScreenRecording(): void {
    this.screenPermission = true;
  }
  /** System Settings' "Quit & Reopen" after a grant: Sunshine quits, launchd starts it again. */
  quitAndReopen(): void {
    this.pid = null;
    this.lastExit = 0;
    this.tick();
  }

  verbs(): string[] {
    return this.calls.filter((c) => c.file === '/bin/launchctl').map((c) => c.args[0]!);
  }

  /* ---------- processes ---------- */
  async run(req: ExecRequest): Promise<ExecResult> {
    this.calls.push(req);
    const line = `run ${req.file} ${req.args.join(' ')}`;
    this.timeline.push(line);
    switch (req.file) {
      case '/bin/launchctl':
        return this.launchctl(req.args);
      case '/usr/bin/ditto':
        return this.ditto(req.args[0]!, req.args[1]!);
      case '/usr/bin/codesign':
        return this.codesign(req.args);
      case SUNSHINE_BIN:
        return this.sunshine(req.args);
      case '/usr/libexec/ApplicationFirewall/socketfilterfw': {
        const text = { off: 'Firewall is disabled. (State = 0)', on: 'Firewall is enabled. (State = 1)', 'block-all': 'Firewall is blocking all non-essential incoming connections. (State = 2)' }[this.firewall];
        return ok(text + '\n');
      }
      default:
        return { exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, spawnError: `ENOENT: ${req.file}` };
    }
  }

  private launchctl(args: readonly string[]): ExecResult {
    const [verb, ...rest] = args;
    switch (verb) {
      case 'print':
        return this.loaded ? ok(this.printText()) : ok('', 113, 'Could not find service');
      case 'bootstrap': {
        if (this.loaded) return ok('', 5, 'Bootstrap failed: 5: Input/output error');
        const plist = this.files.get(rest[1]!);
        if (plist === undefined) return ok('', 5, 'Bootstrap failed: 5: Input/output error');
        this.loaded = true;
        this.loadedDefinition = plist;
        this.start();
        return ok();
      }
      case 'bootout':
        if (!this.loaded) return ok('', 3, 'Boot-out failed: 3: No such process');
        this.loaded = false;
        this.pid = null;
        this.loadedDefinition = null;
        return ok();
      case 'kickstart': {
        if (!this.loaded) return ok('', 113, 'Could not find service');
        const kill = rest[0] === '-k';
        if (this.pid !== null && !kill) return ok();
        this.pid = null;
        this.start();
        return ok();
      }
      default:
        return ok('', 64, 'usage');
    }
  }

  private printText(): string {
    return [
      'gui/501/dev.lanplay.sunshine = {',
      '\tactive count = 1',
      `\tstate = ${this.pid !== null ? 'running' : 'not running'}`,
      ...(this.pid !== null ? [`\tpid = ${this.pid}`] : []),
      `\tlast exit code = ${this.lastExit === null ? '(never exited)' : String(this.lastExit)}`,
      '}',
      '',
    ].join('\n');
  }

  private ditto(from: string, to: string): ExecResult {
    if (this.dittoFails) return ok('', 1, 'ditto: copy failed');
    // ditto onto an existing folder MERGES: files already there stay. That is why LanPlay removes the old copy first.
    this.dirs.add(to);
    for (const [k, v] of [...this.files]) if (k.startsWith(from + '/')) this.files.set(to + k.slice(from.length), v);
    this.teams.set(to, this.teams.get(from) ?? '');
    return ok();
  }

  private codesign(args: readonly string[]): ExecResult {
    const app = args[args.length - 1]!;
    if (args[0] === '--verify') return this.brokenSeal.has(app) || !this.exists(app) ? ok('', 1, `${app}: a sealed resource is missing or invalid`) : ok();
    const team = this.teams.get(app);
    return ok('', 0, `Executable=${app}/Contents/MacOS/Sunshine\nIdentifier=dev.lizardbyte.app.Sunshine\nTeamIdentifier=${team || 'not set'}\n`);
  }

  private sunshine(args: readonly string[]): ExecResult {
    if (args[1] === '--creds' && args.length === 4) {
      this.credsSet = args[3]!;
      this.writeLog('[2026-11-16 10:01:00.000]: Info: Sunshine version: 2026.914.233613\n');
      this.files.set(`${SHARED}/sunshine/sunshine_state.json`, '{"username":"x"}');
      return ok('New credentials have been created\n');
    }
    return ok('', 1);
  }
}

export const PATHS = {
  logDir: LOGS,
  userData: SHARED,
  sharedData: SHARED,
  resources: RESOURCES,
  vendorDir: `${RESOURCES}/vendor`,
  psDir: '',
  diagnosticsOutDir: `${HOME}/Desktop`,
  logDirFellBack: false,
};
