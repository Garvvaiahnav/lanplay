// MacHostService: the macOS sibling of WindowsHostService (docs/MAC-HOST-DESIGN.md 2.6). Setup runs in-process, as the
// user: no elevation, no handoff file.
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { LANPLAY, MAC_HOST_STEP_ORDER, SUNSHINE_MAC } from '../../../contracts.js';
import type { HostSetupStatus, HostStepContext, HostStepId, InternetHostState, KeyValueStore, Logger, PairAgent, ProcessRunner, SelfCheckReport, ServiceDeps, StepRecord } from '../../../contracts.js';
import { tcpProbe, tlsPinCheck } from '../../shared/netprobe.js';
import { JsonFileStore } from '../../shared/stores.js';
import { INTERNET_KEY, LanPairAgent } from '../agent.js';
import type { PairAgentExtraOptions } from '../agent.js';
import { defaultLocalIdentity, generateAdminPassword, LAST_SETUP_KEY, LazySunshineClient, PINNED_CERT_NAME, probeAgent } from '../common.js';
import { internetAddresses } from '../service.js';
import type { PlatformHostService } from '../service.js';
import { certFingerprint256, createSunshineClient } from '../sunshine-client.js';
import { SUNSHINE_MAC_DMG_SHA256, SUNSHINE_MAC_VERSION } from '../vendor.js';
import { bootoutArgv, parseLaunchctlPrint, plistPath, printArgv } from './launchd.js';
import { createMacHostSteps, INPUT_CONFIRMED_KEY } from './steps-mac.js';
import type { MacStepsEnv, MacStepsOptions } from './steps-mac.js';
import { bundledSunshineApp, parseInstalledJson, sunshinePaths } from './sunshine-mac.js';

export interface MacHostServiceExtras {
  /** LanPlay's own executable (process.execPath) and the argv before `--agent` (dev: [appPath]; packaged: []). */
  selfExe: string;
  selfArgsPrefix: readonly string[];
  home: string;
  uid: number;
  /** For the "macOS 14+ on Apple Silicon" check; see macosMajorFromDarwin. */
  macOS: { major: number; arch: string };
  /** Override where Sunshine.app is bundled (tests). */
  bundledApp?: string;
  agentPort?: number;
  agentExtra?: PairAgentExtraOptions;
  localIdentity?: () => { hostName: string; addresses: string[] };
  /** Test hooks. */
  stepsEnv?: Partial<MacStepsEnv>;
  /** os.networkInterfaces (tests). */
  networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  now?: () => number;
}

/**
 * Steps whose state changes without LanPlay doing anything: after the Screen Recording grant, System Settings offers
 * "Quit & Reopen", and launchd (KeepAlive) starts the quit Sunshine again.
 */
const AFTER_PERMISSION_STEPS: readonly HostStepId[] = ['mac-launch-agent', 'mac-screen-recording'];
const AFTER_PERMISSION_APPLY: readonly HostStepId[] = ['web-ui', 'api-auth'];
const RESTART_STEPS: readonly HostStepId[] = ['mac-install', 'config', 'mac-launch-agent', 'mac-screen-recording', 'web-ui', 'api-auth'];

/** Steps whose failure means the internet switch did not take effect (the conf was not written, or Sunshine did not come back). */
const SWITCH_STEPS: readonly HostStepId[] = ['config', 'mac-launch-agent'];

const MAX_LOG_BYTES = 256 * 1024;

/** Packaged: resources/vendor/Sunshine.app. Development: vendor/sunshine-macos-arm64/Sunshine.app (what fetch-vendor makes). */
export function locateBundledSunshine(resources: string, exists: (p: string) => boolean = existsSync): string {
  const packaged = bundledSunshineApp(resources);
  const dev = path.posix.join(resources, 'vendor', 'sunshine-macos-arm64', SUNSHINE_MAC.appName);
  return exists(packaged) || !exists(dev) ? packaged : dev;
}

/** The last `maxBytes` of a log file; null when it cannot be opened. */
export function readLogTail(file: string, maxBytes = MAX_LOG_BYTES): string | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export class MacHostService implements PlatformHostService {
  readonly agent: PairAgent;
  private readonly lanAgent: LanPairAgent;
  private readonly status: KeyValueStore;
  private readonly now: () => number;
  /** setupStatus() re-probes while the user grants permissions; it must not run alongside a setup. */
  private busy = false;
  private internetError: string | undefined;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly x: MacHostServiceExtras,
  ) {
    this.now = x.now ?? Date.now;
    this.status = deps.settings;
    const sunshine = new LazySunshineClient(path.join(deps.paths.sharedData, PINNED_CERT_NAME), () => deps.secrets.get('sunshine-admin-password'), (r) => deps.log.rest(r));
    this.lanAgent = new LanPairAgent(
      {
        port: x.agentPort ?? LANPLAY.agentPort,
        sunshine,
        log: deps.log.child('agent'),
        settings: deps.settings,
        localIdentity: x.localIdentity ?? defaultLocalIdentity,
      },
      { ledger: new JsonFileStore(path.join(deps.paths.sharedData, 'paired-devices.json')), ...(x.agentExtra ?? {}) },
    );
    this.agent = this.lanAgent;
  }

  agentIdle(reason: string | undefined): void {
    this.lanAgent.setIdleReason(reason);
  }

  /** Unlike Windows there is no firewall rule to wait for: the agent starts once setup ran, which also wrote its login item. */
  agentAutoStart(): { start: boolean; reason?: string } {
    const last = this.status.get<HostSetupStatus | null>(LAST_SETUP_KEY, null);
    return last?.lastRunAt ? { start: true } : { start: false, reason: 'It starts after setup: press "Set up this Mac" above first.' };
  }

  /** Cheap and synchronous (one small file): the host screen asks on every status refresh. */
  pendingSunshineUpdate(): { installed: string; bundled: string } | null {
    const text = this.stepsEnv(async () => null).readText(sunshinePaths(this.deps.paths.sharedData, this.deps.paths.logDir).installedJson);
    const installed = text === null ? null : parseInstalledJson(text);
    if (!installed || (installed.version === SUNSHINE_MAC_VERSION && installed.dmgSha256 === SUNSHINE_MAC_DMG_SHA256)) return null;
    return { installed: installed.version, bundled: SUNSHINE_MAC_VERSION };
  }

  /* ---------- plumbing ---------- */
  private internetOn(): boolean {
    return this.status.get<boolean>(INTERNET_KEY, false) === true;
  }

  private stepsEnv(getPassword: () => Promise<string | null>): MacStepsEnv {
    const base: MacStepsEnv = {
      fileExists: (p) => existsSync(p),
      readText: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
      writeText: (p, t) => writeFileSync(p, t, 'utf8'),
      copyFile: (a, b) => copyFileSync(a, b),
      mkdirp: (d) => void mkdirSync(d, { recursive: true }),
      remove: (p) => rmSync(p, { recursive: true, force: true }),
      rename: (a, b) => renameSync(a, b),
      fileBornMs: (p) => {
        try {
          return statSync(p).birthtimeMs;
        } catch {
          return null;
        }
      },
      readLog: (p) => readLogTail(p),
      home: this.x.home,
      uid: this.x.uid,
      selfExe: this.x.selfExe,
      selfArgsPrefix: this.x.selfArgsPrefix,
      bundledApp: this.x.bundledApp ?? locateBundledSunshine(this.deps.paths.resources),
      macOS: this.x.macOS,
      settings: this.status,
      getPassword,
      createSunshineClient,
      tcpProbe,
      tlsPinCheck,
      fingerprint: certFingerprint256,
      agentProbe: () => probeAgent(this.agent),
      internet: this.internetOn(),
      now: this.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    return { ...base, ...(this.x.stepsEnv ?? {}) };
  }

  /** The Windows-only fields (MSI, PowerShell folder, SystemRoot) mean nothing here. */
  private ctx(): HostStepContext {
    return {
      runner: this.deps.runner,
      log: this.deps.log.child('host'),
      paths: this.deps.paths,
      bundledMsiPath: '',
      psDir: '',
      systemRoot: '',
      secrets: this.deps.secrets,
      install: null,
      isAdmin: false,
    };
  }

  private steps(opts?: MacStepsOptions) {
    return createMacHostSteps(
      this.stepsEnv(() => this.deps.secrets.get('sunshine-admin-password')),
      opts,
    );
  }

  private save(st: HostSetupStatus): HostSetupStatus {
    this.status.set(LAST_SETUP_KEY, st);
    return st;
  }

  /** Replaces the records of the steps that ran again, keeping the others (and the order) of the last run. */
  private merge(last: HostSetupStatus, recs: StepRecord[]): HostSetupStatus {
    const steps = [...last.steps];
    for (const r of recs) {
      const i = steps.findIndex((s) => s.stepId === r.stepId);
      if (i >= 0) steps[i] = r;
      else steps.push(r);
    }
    steps.sort((a, b) => MAC_HOST_STEP_ORDER.indexOf(a.stepId as HostStepId) - MAC_HOST_STEP_ORDER.indexOf(b.stepId as HostStepId));
    return { ...last, ok: steps.every((s) => s.status !== 'fail'), steps };
  }

  /* ---------- HostService ---------- */
  async setupStatus(): Promise<HostSetupStatus> {
    const last = this.status.get<HostSetupStatus | null>(LAST_SETUP_KEY, null);
    if (!last) return { lastRunAt: null, ok: false, steps: [], install: null, isAdmin: false };
    // The host screen polls this while the user switches Sunshine on in System Settings. Sunshine only notices after a
    // restart ("Quit & Reopen" there, which launchd follows), so the steps that depend on it are looked at again.
    if (this.busy || last.steps.find((s) => s.stepId === 'mac-screen-recording')?.status !== 'fail') return { ...last, isAdmin: false };
    const ctx = this.ctx();
    const steps = this.steps();
    const recs: StepRecord[] = [];
    for (const id of AFTER_PERMISSION_STEPS) recs.push(await steps.find((s) => s.id === id)!.probe(ctx));
    if (recs.every((r) => r.status !== 'fail')) {
      // Applied rather than probed: the first run never got as far as pinning the certificate. Both are safe to repeat.
      for (const id of AFTER_PERMISSION_APPLY) recs.push(await steps.find((s) => s.id === id)!.apply(ctx));
    }
    const changed = recs.some((r) => {
      const old = last.steps.find((s) => s.stepId === r.stepId);
      return !old || old.status !== r.status || old.message !== r.message;
    });
    return { ...(changed ? this.save(this.merge(last, recs)) : last), isAdmin: false };
  }

  async runSetup(onProgress: (s: StepRecord) => void): Promise<HostSetupStatus> {
    this.busy = true;
    try {
      const log = this.deps.log.child('setup');
      let pw = await this.deps.secrets.get('sunshine-admin-password');
      if (!pw) {
        pw = generateAdminPassword();
        await this.deps.secrets.set('sunshine-admin-password', pw);
        log.log('info', 'setup', 'generated a new Sunshine admin password', { backend: this.deps.secrets.backend() });
      }
      log.redactor.addSecret(pw);

      const ctx = this.ctx();
      const steps: StepRecord[] = [];
      for (const step of createMacHostSteps(this.stepsEnv(async () => pw))) {
        if (step.id === 'agent-listening' && !this.agent.getState().listening) {
          try {
            await this.agent.start();
          } catch (e) {
            log.log('error', 'setup', 'agent start failed', { error: (e as Error).message });
          }
        }
        const rec = await step.apply(ctx);
        this.deps.log.step(rec);
        onProgress(rec);
        steps.push(rec);
      }
      const ok = steps.every((s) => s.status !== 'fail');
      log.log(ok ? 'info' : 'warn', 'setup', `setup finished: ${ok ? 'OK' : 'FAILED'}`, { failed: steps.filter((s) => s.status === 'fail').map((s) => s.stepId) });
      return this.save({ lastRunAt: new Date(this.now()).toISOString(), ok, steps, install: ctx.install, isAdmin: false });
    } finally {
      this.busy = false;
    }
  }

  /** There is no elevated child on macOS: `--host-setup` is rejected before it gets here. */
  async runElevatedSetup(): Promise<number> {
    this.deps.log.child('elevated').log('warn', 'elevated', 'not used on macOS: setup runs as the user');
    return 2;
  }

  /** "I did this" under Accessibility (ok=false takes it back). LanPlay cannot read that grant, so the answer is stored. */
  async confirmInput(ok: boolean): Promise<HostSetupStatus> {
    this.status.set(INPUT_CONFIRMED_KEY, ok);
    const last = this.status.get<HostSetupStatus | null>(LAST_SETUP_KEY, null);
    if (!last) return this.setupStatus();
    const rec = await this.steps().find((s) => s.id === 'mac-input')!.probe(this.ctx());
    return { ...this.save(this.merge(last, [rec])), isAdmin: false };
  }

  /** After an update brought a newer Sunshine, or when Sunshine misbehaves: steps 2, 3, 5 to 7 of setup, restarting even if nothing changed. */
  async restartSunshine(): Promise<HostSetupStatus> {
    return this.runRestartSteps({ restart: true });
  }

  private async runRestartSteps(opts: MacStepsOptions, onProgress?: (s: StepRecord) => void): Promise<HostSetupStatus> {
    this.busy = true;
    try {
      const ctx = this.ctx();
      const recs: StepRecord[] = [];
      for (const step of this.steps(opts).filter((s) => RESTART_STEPS.includes(s.id))) {
        const rec = await step.apply(ctx);
        this.deps.log.step(rec);
        onProgress?.(rec);
        recs.push(rec);
      }
      const last = this.status.get<HostSetupStatus | null>(LAST_SETUP_KEY, null) ?? { lastRunAt: null, ok: false, steps: [], install: null, isAdmin: false };
      return { ...this.save({ ...this.merge(last, recs), install: ctx.install ?? last.install }), isAdmin: false };
    } finally {
      this.busy = false;
    }
  }

  async getInternet(): Promise<InternetHostState> {
    const st: InternetHostState = { enabled: this.internetOn(), ...internetAddresses((this.x.networkInterfaces ?? os.networkInterfaces)()) };
    if (this.internetError) st.lastError = this.internetError;
    return st;
  }

  /**
   * Saves the switch, then rewrites sunshine.conf (UPnP, IPv6) and lets the config step restart Sunshine when the file
   * changed. There is no firewall rule on macOS. When a step fails the switch goes back to where it was, and a failed
   * enable runs the steps once more with the switch off (best effort) so the file does not keep UPnP and IPv6 on.
   */
  async setInternet(on: boolean, onProgress: (s: StepRecord) => void): Promise<InternetHostState> {
    const was = this.internetOn();
    this.status.set(INTERNET_KEY, on === true);
    this.internetError = undefined;
    try {
      const st = await this.runRestartSteps({}, onProgress);
      const failed = st.steps.find((r) => r.status === 'fail' && SWITCH_STEPS.includes(r.stepId as HostStepId));
      if (failed) {
        this.status.set(INTERNET_KEY, was);
        this.internetError = failed.message;
      }
    } catch (e) {
      this.status.set(INTERNET_KEY, was);
      this.internetError = (e as Error).message;
    }
    if (on === true && !was && this.internetError !== undefined) {
      try {
        const back = await this.runRestartSteps({});
        const again = back.steps.find((r) => r.status === 'fail' && SWITCH_STEPS.includes(r.stepId as HostStepId));
        if (again) this.internetError = `${this.internetError} Turning the settings back off also failed: ${again.message}`;
      } catch (e) {
        this.internetError = `${this.internetError} Turning the settings back off also failed: ${(e as Error).message}`;
      }
    }
    return this.getInternet();
  }

  async selfCheck(): Promise<SelfCheckReport> {
    const t0 = this.now();
    const startedAt = new Date(t0).toISOString();
    const ctx = this.ctx();
    const steps: StepRecord[] = [];
    for (const step of this.steps()) {
      // Independent probes: one failure never stops the next one.
      const rec = await step.probe(ctx);
      this.deps.log.step({ ...rec, stepId: `selfcheck:${rec.stepId}` });
      steps.push(rec);
    }
    return { role: 'host', startedAt, durationMs: this.now() - t0, ok: steps.every((s) => s.status !== 'fail'), steps };
  }
}

export function createMacHostService(deps: ServiceDeps, x: MacHostServiceExtras): MacHostService {
  return new MacHostService(deps, x);
}

/**
 * Role switched to client: nothing of the host may keep running or start at login. Boots out both LaunchAgents and
 * deletes their plists. The Sunshine copy, its config and its pairings stay, so switching back needs no new permissions.
 */
export async function teardownMacHost(d: { runner: ProcessRunner; log: Logger; home: string; uid: number }): Promise<void> {
  for (const label of [SUNSHINE_MAC.launchdLabel, SUNSHINE_MAC.agentLaunchdLabel]) {
    // First: when this is `LanPlay --agent` started by dev.lanplay.agent, its bootout ends this very process.
    rmSync(plistPath(d.home, label), { force: true });
    const print = printArgv(d.uid, label);
    const printed = await d.runner.run({ file: print.file, args: print.args, timeoutMs: 15_000 });
    if (parseLaunchctlPrint(printed.stdout).loaded) {
      const out = bootoutArgv(d.uid, label);
      const r = await d.runner.run({ file: out.file, args: out.args, timeoutMs: 30_000 });
      if (r.exitCode !== 0) d.log.log('warn', 'host', `launchctl bootout ${label} failed`, { exitCode: r.exitCode, stderr: r.stderr.trim().slice(0, 200) });
    }
  }
}
