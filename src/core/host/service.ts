// HostService: setup (non-elevated parent + elevated child), pair agent, self-check.
import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_STEP_ORDER, LANPLAY, SUNSHINE, SunshineApiError } from '../../contracts.js';
import type {
  HostService,
  HostSetupHandoff,
  HostSetupResult,
  HostSetupStatus,
  HostStepContext,
  KeyValueStore,
  PairAgent,
  SecretKey,
  SecretStore,
  SelfCheckReport,
  ServiceDeps,
  StepRecord,
  SunshineClient,
  SunshineClientOptions,
} from '../../contracts.js';
import { localDateStamp } from '../shared/logger.js';
import { httpGet, tcpProbe, tlsPinCheck, udpQuery } from '../shared/netprobe.js';
import { JsonFileStore } from '../shared/stores.js';
import { timedStep } from '../shared/steprec.js';
import { LanPairAgent } from './agent.js';
import type { PairAgentExtraOptions } from './agent.js';
import { runPs } from './ps.js';
import { certFingerprint256, createSunshineClient } from './sunshine-client.js';
import { createHostSteps, ELEVATED_STEP_IDS, USER_STEP_IDS } from './steps.js';
import type { HostStepsEnv } from './steps.js';
import { quoteWindowsArg } from './winargs.js';
import { sha256File, SUNSHINE_MSI_NAME } from './vendor.js';

export const LAST_SETUP_KEY = 'host.lastSetup';
/** LanPlay.exe path the firewall rules were created for (the program-bound rules stop matching when the folder moves). */
export const SETUP_EXE_KEY = 'host.setupExe';
export const PINNED_CERT_NAME = 'sunshine-cert.pem';

export interface HostServiceExtras {
  /** LanPlay.exe (process.execPath). */
  selfExe: string;
  /** Extra argv before our flags (dev: [appPath]); packaged: []. */
  selfArgsPrefix: readonly string[];
  /** app.getLoginItemSettings / setLoginItemSettings wrapper. */
  loginItem: { get(): boolean; set(on: boolean): void } | null;
  /** process.env.SystemRoot (default C:\Windows). */
  systemRoot: string;
  /** Override agent options (tests). */
  agentPort?: number;
  agentExtra?: PairAgentExtraOptions;
  localIdentity?: () => { hostName: string; addresses: string[] };
  /** Override where handoff/result files go (default os.tmpdir(): user-private). */
  tempDir?: string;
  /** Test hooks. */
  stepsEnv?: Partial<HostStepsEnv>;
  now?: () => number;
}

export function defaultLocalIdentity(): { hostName: string; addresses: string[] } {
  const addresses: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) addresses.push(a.address);
  return { hostName: os.hostname(), addresses };
}

/** Secret store holding only the handoff password (elevated child). */
class HandoffSecrets implements SecretStore {
  constructor(private readonly pw: string) {}
  async get(_k: SecretKey) {
    return this.pw;
  }
  async set() {
    /* the elevated child never persists secrets */
  }
  async delete() {
    /* noop */
  }
  backend(): 'file-0600' {
    return 'file-0600';
  }
}

/**
 * Lazily builds a pinned SunshineClient on each call: the cert copy and password may appear only after setup ran.
 */
export class LazySunshineClient implements SunshineClient {
  constructor(
    private readonly certPath: string,
    private readonly getPassword: () => Promise<string | null>,
    private readonly onCall: SunshineClientOptions['onCall'],
    private readonly baseUrl = `https://127.0.0.1:${SUNSHINE.webUiPort}`,
  ) {}
  private async client(): Promise<SunshineClient> {
    let pem: string;
    try {
      pem = readFileSync(this.certPath, 'utf8');
    } catch {
      throw new SunshineApiError(`LanPlay setup has not finished: no pinned Sunshine certificate at ${this.certPath}`, null, 'network');
    }
    const pw = await this.getPassword();
    if (!pw) throw new SunshineApiError('LanPlay setup has not finished: no stored Sunshine admin password', null, 'auth');
    const o: SunshineClientOptions = { baseUrl: this.baseUrl, username: LANPLAY.sunshineAdminUser, getPassword: async () => pw, pinnedCertPem: pem, timeoutMs: 10_000 };
    if (this.onCall) o.onCall = this.onCall;
    return createSunshineClient(o);
  }
  async getPendingPairings() {
    return (await this.client()).getPendingPairings();
  }
  async submitPin(r: { pairingId: string; pin: string; name: string }) {
    return (await this.client()).submitPin(r);
  }
  async cancelPairing(id: string) {
    return (await this.client()).cancelPairing(id);
  }
  async listClients() {
    return (await this.client()).listClients();
  }
  async unpairClient(uuid: string) {
    return (await this.client()).unpairClient(uuid);
  }
  async getVersion() {
    return (await this.client()).getVersion();
  }
  async getLogsTail(n: number) {
    return (await this.client()).getLogsTail(n);
  }
}

export function validateHandoff(v: unknown): HostSetupHandoff {
  const h = v as Partial<HostSetupHandoff> | null;
  if (!h || typeof h !== 'object') throw new Error('handoff is not an object');
  if (h.version !== 1) throw new Error('handoff version must be 1');
  if (typeof h.sunshineAdminUser !== 'string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(h.sunshineAdminUser)) throw new Error('handoff sunshineAdminUser invalid');
  if (typeof h.sunshineAdminPassword !== 'string' || h.sunshineAdminPassword.length < 16 || h.sunshineAdminPassword.length > 256 || /[\s"]/.test(h.sunshineAdminPassword)) {
    throw new Error('handoff password invalid');
  }
  if (typeof h.logDir !== 'string' || typeof h.sharedData !== 'string') throw new Error('handoff paths invalid');
  if (typeof h.createdAt !== 'string' || Number.isNaN(Date.parse(h.createdAt))) throw new Error('handoff createdAt invalid');
  return h as HostSetupHandoff;
}

export function generateAdminPassword(): string {
  // base64url may start with "-" or "_"; an argv value that looks like an option is asking for trouble, so re-roll.
  for (;;) {
    const pw = randomBytes(32).toString('base64url');
    if (/^[A-Za-z0-9]/.test(pw)) return pw;
  }
}

/**
 * The silent MSI custom action runs sunshine-setup.ps1 as LocalSystem (wxs: Execute="deferred" Impersonate="no"), so
 * its log ("$env:TEMP\Sunshine\logs\install", sunshine-setup.ps1) lands in SYSTEM's temp folder, which a normal
 * user cannot list. The elevated child copies the newest ones next to LanPlay's logs so diagnostics can include them.
 * https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/cmake/packaging/wix_resources/sunshine-installer.wxs#L55-L67
 */
export function collectSunshineInstallerLogs(systemRoot: string, userTemp: string | undefined, destDir: string, max = 3): string[] {
  const candidates = [path.join(systemRoot, 'SystemTemp'), path.join(systemRoot, 'Temp'), ...(userTemp ? [userTemp] : [])].map((t) => path.join(t, 'Sunshine', 'logs', 'install'));
  const found: Array<{ p: string; m: number }> = [];
  for (const dir of candidates) {
    try {
      for (const n of readdirSync(dir)) {
        const p = path.join(dir, n);
        const st = statSync(p);
        if (st.isFile()) found.push({ p, m: st.mtimeMs });
      }
    } catch {
      /* folder absent or unreadable */
    }
  }
  const out: string[] = [];
  for (const f of found.sort((a, b) => b.m - a.m).slice(0, max)) {
    try {
      mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, `sunshine-install-${path.basename(f.p).replace(/[^A-Za-z0-9._-]/g, '_')}`);
      copyFileSync(f.p, dest);
      out.push(dest);
    } catch {
      /* best effort */
    }
  }
  return out;
}

export class WindowsHostService implements HostService {
  readonly agent: PairAgent;
  private readonly lanAgent: LanPairAgent;
  private readonly certPath: string;
  private readonly status: KeyValueStore;
  private readonly now: () => number;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly x: HostServiceExtras,
  ) {
    this.now = x.now ?? Date.now;
    // path (not path.win32): these are real files opened by Node; on Windows path === path.win32.
    this.certPath = path.join(deps.paths.sharedData, PINNED_CERT_NAME);
    this.status = deps.settings;
    const sunshine = new LazySunshineClient(this.certPath, () => deps.secrets.get('sunshine-admin-password'), (r) => deps.log.rest(r));
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

  /** Tell the UI why the agent is deliberately not listening yet (see agentAutoStart). */
  agentIdle(reason: string | undefined): void {
    this.lanAgent.setIdleReason(reason);
  }

  /* ---------- plumbing ---------- */
  private stepsEnv(getPassword: () => Promise<string | null>, userSession: boolean): HostStepsEnv {
    const base: HostStepsEnv = {
      fileExists: (p) => existsSync(p),
      readText: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
      writeText: (p, t) => {
        // The config folder is created by upstream's migrate-config.bat; that custom action has Return="ignore".
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, t, 'utf8');
      },
      collectInstallerLogs: () => collectSunshineInstallerLogs(this.x.systemRoot, process.env.TEMP, this.deps.paths.logDir),
      copyFile: (a, b) => {
        mkdirSync(path.dirname(b), { recursive: true });
        copyFileSync(a, b);
      },
      sha256File,
      getPassword,
      createSunshineClient,
      tcpProbe,
      tlsPinCheck,
      fingerprint: certFingerprint256,
      pinnedCertPath: this.certPath,
      selfExe: this.x.selfExe,
      loginItem: userSession ? this.x.loginItem : null,
      agentProbe: userSession ? () => this.probeAgent() : null,
      now: this.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    return { ...base, ...(this.x.stepsEnv ?? {}) };
  }

  private ctx(secrets: SecretStore, isAdmin: boolean): HostStepContext {
    return {
      runner: this.deps.runner,
      log: this.deps.log.child('host'),
      paths: this.deps.paths,
      bundledMsiPath: path.join(this.deps.paths.vendorDir, SUNSHINE_MSI_NAME),
      psDir: this.deps.paths.psDir,
      systemRoot: this.x.systemRoot,
      secrets,
      install: null,
      isAdmin,
    };
  }

  async probeAgent(): Promise<{ http: boolean; udp: boolean; detail: string }> {
    const port = this.agent.getState().port || LANPLAY.agentPort;
    let http = false;
    let detail = '';
    try {
      const r = await httpGet('127.0.0.1', port, '/v1/info', 3000);
      http = r.status === 200;
      detail = `GET /v1/info -> ${r.status} ${r.body.slice(0, 200)}`;
    } catch (e) {
      detail = `GET /v1/info failed: ${(e as Error).message}`;
    }
    const u = await udpQuery('127.0.0.1', port, LANPLAY.agentDiscoveryMagic, 1500);
    const udp = Boolean(u && u.includes(LANPLAY.agentDiscoveryMagic));
    if (!udp) detail += '; UDP discovery: no reply';
    return { http, udp, detail };
  }

  private async isAdmin(): Promise<boolean> {
    const r = await runPs<{ isAdmin: boolean }>({ runner: this.deps.runner, systemRoot: this.x.systemRoot, psDir: this.deps.paths.psDir, redactor: this.deps.log.redactor }, 'test-admin', {}, 30_000, []);
    return Boolean(r.ok && r.json?.isAdmin);
  }

  private steps(ids: readonly string[], env: HostStepsEnv) {
    return createHostSteps(env).filter((s) => ids.includes(s.id));
  }

  private save(st: HostSetupStatus): HostSetupStatus {
    this.status.set(LAST_SETUP_KEY, st);
    this.status.set(SETUP_EXE_KEY, this.x.selfExe);
    return st;
  }

  /**
   * Should the pair agent start listening when the app launches?
   * Not before setup ran for THIS LanPlay.exe: listening without the program-bound allow rule makes Windows show its
   * "allow access?" firewall prompt, and dismissing that prompt creates a Block rule that silently breaks pairing.
   * Setup itself always starts the agent after the firewall step.
   */
  agentAutoStart(): { start: boolean; reason?: string } {
    const last = this.status.get<HostSetupStatus | null>(LAST_SETUP_KEY, null);
    if (!last || !last.lastRunAt) return { start: false, reason: 'It starts after setup: press the setup button above first (it opens the Windows firewall for LanPlay).' };
    const exe = this.status.get<string | null>(SETUP_EXE_KEY, null);
    if (typeof exe === 'string' && exe.toLowerCase() !== this.x.selfExe.toLowerCase()) {
      return { start: false, reason: 'LanPlay was moved to another folder since setup. Press "Set up / Repair" so the firewall rule matches the new location.' };
    }
    return { start: true };
  }

  /* ---------- HostService ---------- */
  async setupStatus(): Promise<HostSetupStatus> {
    const last = this.status.get<HostSetupStatus | null>(LAST_SETUP_KEY, null);
    const isAdmin = await this.isAdmin().catch(() => false);
    if (!last) return { lastRunAt: null, ok: false, steps: [], install: null, isAdmin };
    return { ...last, isAdmin };
  }

  async runSetup(onProgress: (s: StepRecord) => void): Promise<HostSetupStatus> {
    const log = this.deps.log.child('setup');
    const startedAt = new Date(this.now()).toISOString();
    let pw = await this.deps.secrets.get('sunshine-admin-password');
    if (!pw) {
      pw = generateAdminPassword();
      await this.deps.secrets.set('sunshine-admin-password', pw);
      log.log('info', 'setup', 'generated a new Sunshine admin password', { backend: this.deps.secrets.backend() });
    }
    log.redactor.addSecret(pw);

    let result: HostSetupResult;
    const admin = await this.isAdmin().catch(() => false);
    if (admin) {
      log.log('info', 'setup', 'already elevated: running setup in-process');
      result = await this.runElevatedSteps(pw, onProgress);
    } else {
      result = await this.runViaUac(pw, onProgress);
    }

    // User-session steps: login item + agent.
    const userSteps: StepRecord[] = [];
    if (!this.agent.getState().listening) {
      try {
        await this.agent.start();
      } catch (e) {
        log.log('error', 'setup', 'agent start failed', { error: (e as Error).message });
      }
    }
    const env = this.stepsEnv(async () => pw, true);
    const ctx = this.ctx(this.deps.secrets, admin);
    ctx.install = result.install;
    for (const step of this.steps(USER_STEP_IDS, env)) {
      const rec = await step.apply(ctx);
      this.deps.log.step(rec);
      onProgress(rec);
      userSteps.push(rec);
    }
    const steps = [...result.steps.filter((s) => !USER_STEP_IDS.includes(s.stepId as never)), ...userSteps];
    const ok = steps.every((s) => s.status !== 'fail');
    log.log(ok ? 'info' : 'warn', 'setup', `setup finished: ${ok ? 'OK' : 'FAILED'}`, { failed: steps.filter((s) => s.status === 'fail').map((s) => s.stepId), startedAt });
    return this.save({ lastRunAt: new Date(this.now()).toISOString(), ok, steps, install: result.install, isAdmin: admin });
  }

  /** Non-elevated parent: handoff file -> invoke-elevated.ps1 -> LanPlay.exe --host-setup (UAC) -> result file. */
  private async runViaUac(pw: string, onProgress: (s: StepRecord) => void): Promise<HostSetupResult> {
    const log = this.deps.log.child('setup');
    const dir = this.x.tempDir ?? os.tmpdir();
    const tag = randomBytes(8).toString('hex');
    const handoffPath = path.join(dir, `lanplay-handoff-${tag}.json`);
    const resultPath = path.join(dir, `lanplay-result-${tag}.json`);
    const handoff: HostSetupHandoff = {
      version: 1,
      createdAt: new Date(this.now()).toISOString(),
      sunshineAdminUser: LANPLAY.sunshineAdminUser,
      sunshineAdminPassword: pw,
      logDir: this.deps.paths.logDir,
      sharedData: this.deps.paths.sharedData,
    };
    // User temp dir (%LOCALAPPDATA%\Temp) is private to this user; 0600 for POSIX tests.
    writeFileSync(handoffPath, JSON.stringify(handoff), { encoding: 'utf8', mode: 0o600 });
    const childArgs = [...this.x.selfArgsPrefix, '--host-setup', '--handoff', handoffPath, '--result', resultPath];
    const quoted = childArgs.map(quoteWindowsArg);
    const b64 = Buffer.from(JSON.stringify(quoted), 'utf8').toString('base64');
    log.log('info', 'setup', 'starting elevated setup (UAC prompt)', { exe: this.x.selfExe, argv: childArgs });

    // Live progress: tail the elevated log while the child runs.
    const elevatedLog = path.join(this.deps.paths.logDir, LANPLAY.elevatedLogFilePattern.replace('<date>', localDateStamp(new Date(this.now()))));
    const tailer = startTail(elevatedLog, (rec) => onProgress(rec));
    const commands: StepRecord['commands'] = [];
    let ps;
    try {
      ps = await runPs<{ exitCode: number | null; cancelled: boolean }>(
        { runner: this.deps.runner, systemRoot: this.x.systemRoot, psDir: this.deps.paths.psDir, redactor: this.deps.log.redactor },
        'invoke-elevated',
        { FilePath: this.x.selfExe, ArgumentListB64: b64 },
        30 * 60_000,
        commands,
      );
    } finally {
      tailer.stop();
      rmSync(handoffPath, { force: true }); // the child deletes it; make sure it never lingers
    }
    let result: HostSetupResult | null = null;
    try {
      result = JSON.parse(readFileSync(resultPath, 'utf8')) as HostSetupResult;
    } catch {
      /* handled below */
    }
    rmSync(resultPath, { force: true });
    if (result && result.version === 1 && Array.isArray(result.steps)) return result;

    const cancelled = Boolean(ps.json?.cancelled);
    const rec = await timedStep('admin', 'Running as administrator', async (s) => {
      s.commands.push(...commands);
      s.data.invokeElevated = ps.json;
      if (cancelled) return { status: 'fail', message: 'The Windows admin prompt was cancelled. Click "Set up this PC" again and choose Yes.' };
      return {
        status: 'fail',
        message: `The elevated setup did not produce a result (${ps.error ?? `exit code ${String(ps.json?.exitCode)}`}). Its log is ${elevatedLog}.`,
      };
    });
    this.deps.log.step(rec);
    onProgress(rec);
    return { version: 1, ok: false, steps: [rec], install: null, certFingerprint256: null };
  }

  /** The elevated work itself (in-process when already admin, or inside --host-setup). */
  private async runElevatedSteps(pw: string, onProgress: (s: StepRecord) => void): Promise<HostSetupResult> {
    const env = this.stepsEnv(async () => pw, false);
    const ctx = this.ctx(new HandoffSecrets(pw), true);
    const steps: StepRecord[] = [];
    for (const step of this.steps(ELEVATED_STEP_IDS, env)) {
      const rec = await step.apply(ctx);
      this.deps.log.step(rec);
      onProgress(rec);
      steps.push(rec);
      if (step.id === 'admin' && rec.status === 'fail') {
        ctx.isAdmin = false;
      }
    }
    let fp: string | null = null;
    try {
      fp = certFingerprint256(readFileSync(this.certPath, 'utf8'));
    } catch {
      fp = null;
    }
    return { version: 1, ok: steps.every((s) => s.status !== 'fail'), steps, install: ctx.install, certFingerprint256: fp };
  }

  async runElevatedSetup(handoffPath: string, resultPath: string): Promise<number> {
    const log = this.deps.log.child('elevated');
    let handoff: HostSetupHandoff;
    try {
      const raw = readFileSync(handoffPath, 'utf8');
      rmSync(handoffPath, { force: true }); // contains the password: delete immediately
      handoff = validateHandoff(JSON.parse(raw));
    } catch (e) {
      rmSync(handoffPath, { force: true });
      log.log('error', 'elevated', 'cannot read handoff', { error: (e as Error).message, handoffPath });
      const rec = await timedStep('admin', 'Running as administrator', async () => ({ status: 'fail', message: `Elevated setup could not read its handoff file: ${(e as Error).message}` }));
      writeResult(resultPath, { version: 1, ok: false, steps: [rec], install: null, certFingerprint256: null });
      return 2;
    }
    log.redactor.addSecret(handoff.sunshineAdminPassword);
    log.log('info', 'elevated', 'elevated setup started', { pid: process.pid, logDir: handoff.logDir, sharedData: handoff.sharedData });
    const result = await this.runElevatedSteps(handoff.sunshineAdminPassword, () => undefined);
    writeResult(resultPath, result);
    log.log(result.ok ? 'info' : 'warn', 'elevated', `elevated setup finished: ${result.ok ? 'OK' : 'FAILED'}`);
    return result.ok ? 0 : 1;
  }

  async selfCheck(): Promise<SelfCheckReport> {
    const t0 = this.now();
    const startedAt = new Date(t0).toISOString();
    const env = this.stepsEnv(() => this.deps.secrets.get('sunshine-admin-password'), true);
    const ctx = this.ctx(this.deps.secrets, false);
    const steps: StepRecord[] = [];
    for (const step of createHostSteps(env).sort((a, b) => HOST_STEP_ORDER.indexOf(a.id) - HOST_STEP_ORDER.indexOf(b.id))) {
      // Independent probes: one failure never stops the next one.
      const rec = await step.probe(ctx);
      this.deps.log.step({ ...rec, stepId: `selfcheck:${rec.stepId}` });
      steps.push(rec);
    }
    return { role: 'host', startedAt, durationMs: this.now() - t0, ok: steps.every((s) => s.status !== 'fail'), steps };
  }
}

function writeResult(file: string, r: HostSetupResult): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(r), 'utf8');
  } catch {
    /* the parent reports "no result" */
  }
}

/** Polls a JSONL file for new `step` entries. */
export function startTail(file: string, onStep: (r: StepRecord) => void, intervalMs = 500): { stop(): void } {
  let pos = 0;
  try {
    pos = statSync(file).size;
  } catch {
    pos = 0;
  }
  let buf = '';
  const tick = () => {
    try {
      const size = statSync(file).size;
      if (size < pos) pos = 0;
      if (size === pos) return;
      const fd = openSync(file, 'r');
      try {
        const b = Buffer.alloc(size - pos);
        readSync(fd, b, 0, b.length, pos);
        pos = size;
        buf += b.toString('utf8');
      } finally {
        closeSync(fd);
      }
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        try {
          const e = JSON.parse(l) as { step?: StepRecord };
          if (e.step) onStep(e.step);
        } catch {
          /* partial line */
        }
      }
    } catch {
      /* file not there yet */
    }
  };
  const t = setInterval(tick, intervalMs);
  return {
    stop() {
      clearInterval(t);
      tick();
    },
  };
}

export function createWindowsHostService(deps: ServiceDeps, x: HostServiceExtras): WindowsHostService {
  return new WindowsHostService(deps, x);
}
