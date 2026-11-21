// Windows host setup steps. Every decision is made here in TypeScript; PowerShell only reports/does one thing.
// Each step: probe() is read-only (self-check), apply() is idempotent (setup). Paths: path.win32 only.
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { LANPLAY, SUNSHINE, sunshineManagedConfig, SunshineApiError } from '../../contracts.js';
import type { HostStep, HostStepContext, HostStepId, SunshineClient, SunshineClientOptions, SunshineFactsPs, SunshineInstall } from '../../contracts.js';
import { runRecorded } from '../shared/exec.js';
import { sleep, timedStep } from '../shared/steprec.js';
import type { StepOutcome, StepScratch } from '../shared/steprec.js';
import { runPs } from './ps.js';
import { mergeSunshineConf } from './sunshine-conf.js';
import { applyLogPathOverride, findNsisInstall, locateSunshine } from './sunshine-locate.js';
import { buildBatArgv, buildMsiexecArgs, system32Exe } from './winargs.js';
import { SUNSHINE_MSI_SHA256 } from './vendor.js';

const w = path.win32;

export const STEP_TITLES: Record<HostStepId, string> = {
  admin: 'Running as administrator',
  'locate-sunshine': 'Find Sunshine',
  'install-sunshine': 'Install Sunshine',
  service: 'Sunshine service (automatic, running)',
  config: 'Sunshine settings (admin page on this PC only, HEVC/AV1 auto, UPnP and IPv6 follow the internet switch)',
  credentials: 'Sunshine admin login',
  'restart-service': 'Restart Sunshine',
  'web-ui': 'Sunshine web API reachable (pinned certificate)',
  'api-auth': 'Sunshine API login works',
  'firewall-sunshine': 'Firewall rule "Sunshine"',
  'firewall-agent': 'Firewall rule "LanPlay Pair Agent"',
  'firewall-internet': `Firewall rule "${LANPLAY.internetFirewallRuleName}" (internet switch)`,
  'agent-autostart': 'Start LanPlay pair agent at login',
  'agent-listening': 'LanPlay pair agent answering',
  'mac-bundle': 'Sunshine for Mac is bundled and signed',
  'mac-install': 'Install Sunshine (private copy)',
  'mac-launch-agent': 'Sunshine runs in the background (starts at login)',
  'mac-screen-recording': 'Screen Recording allowed for Sunshine',
  'mac-input': 'Keyboard and mouse control (Accessibility)',
  'mac-audio': 'System audio',
  'mac-network': 'Local network and firewall',
};

export interface FirewallRuleFact {
  id: string;
  name: string;
  enabled: boolean;
  direction: string;
  action: string;
  profile?: string;
  protocol: string;
  localPort: string;
  remoteAddress: string;
  program: string;
  matchedBy?: string;
}

/** Everything a step needs beyond the contract's HostStepContext. Injected so tests can fake the machine. */
export interface HostStepsEnv {
  fileExists(p: string): boolean;
  readText(p: string): string | null;
  writeText(p: string, text: string): void;
  copyFile(from: string, to: string): void;
  sha256File(p: string): Promise<string>;
  /** Password for the Sunshine admin user (from the handoff in the elevated child, from SecretStore otherwise). */
  getPassword(): Promise<string | null>;
  createSunshineClient(o: SunshineClientOptions): SunshineClient;
  tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean>;
  tlsPinCheck(host: string, port: number, pem: string, timeoutMs: number): Promise<{ ok: boolean; error?: string; fingerprint256?: string }>;
  fingerprint(pem: string): string;
  /** Where the copy of cacert.pem lives (%ProgramData%\LanPlay\sunshine-cert.pem). */
  pinnedCertPath: string;
  /** LanPlay.exe (to spot firewall Block rules bound to it). */
  selfExe: string;
  /** null inside the elevated child: the login item belongs to the user session. */
  loginItem: { get(): boolean; set(on: boolean): void } | null;
  /** null inside the elevated child. */
  agentProbe: (() => Promise<{ http: boolean; udp: boolean; detail: string }>) | null;
  /** Copies upstream's installer logs (written under SYSTEM's temp by the silent MSI action) next to LanPlay's logs. Best effort. */
  collectInstallerLogs?: () => string[];
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The "Allow connections from the internet" switch (D07) for this run. Absent = off. */
  internet?: boolean;
  /** Timing knobs (tests shrink them). */
  timing?: Partial<typeof DEFAULT_TIMING>;
}

export const DEFAULT_TIMING = {
  serviceWaitMs: 30_000,
  webUiWaitMs: 60_000,
  pollMs: 1000,
  msiTimeoutMs: 15 * 60_000,
  psTimeoutMs: 60_000,
  /** api-auth during setup: Sunshine may accept TCP a moment before its API answers. */
  apiRetries: 5,
  apiRetryMs: 2000,
};

type T = typeof DEFAULT_TIMING;

function timing(env: HostStepsEnv): T {
  return { ...DEFAULT_TIMING, ...(env.timing ?? {}) };
}

/* ------------------------------------------------------------------ helpers */

async function getFacts(ctx: HostStepContext, env: HostStepsEnv, s: StepScratch): Promise<SunshineFactsPs> {
  const r = await runPs<SunshineFactsPs>(
    { runner: ctx.runner, systemRoot: ctx.systemRoot, psDir: ctx.psDir, redactor: ctx.log.redactor },
    'get-sunshine-facts',
    {},
    timing(env).psTimeoutMs,
    s.commands,
  );
  if (!r.ok || !r.json) throw new Error(`get-sunshine-facts.ps1 failed: ${r.error}`);
  const f = r.json;
  return { service: f.service ?? null, uninstallEntries: Array.isArray(f.uninstallEntries) ? f.uninstallEntries : f.uninstallEntries ? [f.uninstallEntries] : [], env: f.env ?? {} };
}

function locate(ctx: HostStepContext, env: HostStepsEnv, facts: SunshineFactsPs): SunshineInstall | null {
  const inst = locateSunshine(facts, (p) => env.fileExists(p));
  if (!inst) return null;
  const conf = env.readText(inst.configFile);
  return conf ? applyLogPathOverride(inst, conf) : inst;
}

function installData(inst: SunshineInstall | null): Record<string, unknown> {
  return inst ? { install: { ...inst } } : { install: null };
}

const sc = (ctx: HostStepContext) => system32Exe(ctx.systemRoot, 'sc.exe');

async function serviceState(ctx: HostStepContext, env: HostStepsEnv, s: StepScratch) {
  return (await getFacts(ctx, env, s)).service;
}

async function waitForService(ctx: HostStepContext, env: HostStepsEnv, s: StepScratch, want: 'Running' | 'Stopped'): Promise<string> {
  const t = timing(env);
  const deadline = env.now() + t.serviceWaitMs;
  let last = 'unknown';
  for (;;) {
    const svc = await serviceState(ctx, env, s);
    last = svc ? svc.state : 'missing';
    if (last === want) return last;
    if (env.now() >= deadline) return last;
    await env.sleep(t.pollMs);
  }
}

function needInstall(ctx: HostStepContext): StepOutcome | null {
  return ctx.install ? null : { status: 'fail', message: 'Blocked: Sunshine was not found or installed (see "Find Sunshine" / "Install Sunshine").' };
}

function needAdmin(ctx: HostStepContext): StepOutcome | null {
  return ctx.isAdmin ? null : { status: 'fail', message: 'Needs administrator rights. Click "Set up this PC" and accept the Windows prompt.' };
}

async function readPinnedPem(env: HostStepsEnv, ctx: HostStepContext): Promise<{ pem: string | null; from: string }> {
  const copy = env.readText(env.pinnedCertPath);
  if (copy) return { pem: copy, from: env.pinnedCertPath };
  if (ctx.install) {
    const orig = env.readText(ctx.install.certFile);
    if (orig) return { pem: orig, from: ctx.install.certFile };
  }
  return { pem: null, from: env.pinnedCertPath };
}

function explainApiError(e: unknown): string {
  if (e instanceof SunshineApiError) {
    switch (e.kind) {
      case 'redirect-welcome':
        return 'Sunshine has no admin user yet: the "Sunshine admin login" step did not take effect. Run setup again.';
      case 'auth':
        return 'Sunshine rejected LanPlay\'s admin password (someone changed it in the Sunshine web UI?). Run setup again to reset it.';
      case 'tls-pin-mismatch':
        return 'Sunshine\'s certificate is not the one LanPlay pinned (cacert.pem changed). Run setup again to re-pin it.';
      case 'forbidden-origin':
        return 'Sunshine refused the request origin (origin_web_ui_allowed). Run setup again to rewrite sunshine.conf.';
      default:
        return `Sunshine API error (${e.kind}): ${e.message}`;
    }
  }
  return `Sunshine API error: ${(e as Error)?.message ?? String(e)}`;
}

async function firewallRules(ctx: HostStepContext, env: HostStepsEnv, s: StepScratch, names: string[], program?: string): Promise<FirewallRuleFact[]> {
  const params: Record<string, string | readonly string[]> = { Names: names };
  if (program) params.Program = program;
  const r = await runPs<{ rules: FirewallRuleFact[] | FirewallRuleFact }>(
    { runner: ctx.runner, systemRoot: ctx.systemRoot, psDir: ctx.psDir, redactor: ctx.log.redactor },
    'get-firewall-rules',
    params,
    timing(env).psTimeoutMs,
    s.commands,
  );
  if (!r.ok || !r.json) throw new Error(`get-firewall-rules.ps1 failed: ${r.error}`);
  const rules = r.json.rules;
  return Array.isArray(rules) ? rules : rules ? [rules] : [];
}

const allowsInbound = (r: FirewallRuleFact) => r.enabled && /^inbound$/i.test(r.direction) && /^allow$/i.test(r.action);
const hasProto = (rules: FirewallRuleFact[], proto: string) => rules.some((r) => allowsInbound(r) && r.protocol.toUpperCase().split(',').includes(proto));

export function evaluateSunshineFirewall(rules: FirewallRuleFact[]): { ok: boolean; missing: string[] } {
  const named = rules.filter((r) => r.name === SUNSHINE.firewallRuleName);
  const missing = ['TCP', 'UDP'].filter((p) => !hasProto(named, p));
  return { ok: missing.length === 0, missing };
}

export function evaluateAgentFirewall(rules: FirewallRuleFact[], port: number): { ok: boolean; problems: string[]; blockRules: FirewallRuleFact[] } {
  const named = rules.filter((r) => r.name === LANPLAY.agentFirewallRuleName && r.matchedBy !== 'program');
  const problems: string[] = [];
  for (const proto of ['TCP', 'UDP']) {
    const r = named.find((x) => x.protocol.toUpperCase() === proto);
    if (!r) problems.push(`${proto} rule missing`);
    else {
      if (!allowsInbound(r)) problems.push(`${proto} rule is not an enabled inbound Allow rule`);
      if (!r.localPort.split(',').map((x) => x.trim()).includes(String(port))) problems.push(`${proto} rule port is ${r.localPort || 'none'}, expected ${port}`);
      if (!/localsubnet/i.test(r.remoteAddress)) problems.push(`${proto} rule remote address is "${r.remoteAddress}", expected LocalSubnet`);
    }
  }
  const blockRules = rules.filter((r) => r.matchedBy === 'program' && r.enabled && /^inbound$/i.test(r.direction) && /^block$/i.test(r.action));
  return { ok: problems.length === 0, problems, blockRules };
}

/** Does a Windows firewall port list ("47984,47989,48010" or "47998-48000", as get-firewall-rules prints it) cover every port in `want`? */
export function portListCovers(localPort: string, want: readonly number[]): boolean {
  const have: Array<[number, number]> = [];
  for (const tok of localPort.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(tok);
    if (m) have.push([Number(m[1]), Number(m[2] ?? m[1])]);
  }
  return want.every((p) => have.some(([a, b]) => p >= a && p <= b));
}

/** Ports the internet rule opens: Sunshine's HTTPS, HTTP and RTSP on TCP; video, control and audio on UDP. */
export const INTERNET_TCP_PORTS: readonly number[] = Object.freeze([SUNSHINE.httpsPort, SUNSHINE.httpPort, SUNSHINE.rtspPort]);
export const INTERNET_UDP_PORTS: readonly number[] = SUNSHINE.udpPorts;
const udpRange = `${Math.min(...INTERNET_UDP_PORTS)}-${Math.max(...INTERNET_UDP_PORTS)}`;

export function evaluateInternetFirewall(rules: FirewallRuleFact[], on: boolean): { ok: boolean; problems: string[] } {
  const named = rules.filter((r) => r.name === LANPLAY.internetFirewallRuleName && r.matchedBy !== 'program');
  if (!on) return named.length === 0 ? { ok: true, problems: [] } : { ok: false, problems: [`${named.length} rule(s) named "${LANPLAY.internetFirewallRuleName}" still exist while the internet switch is off`] };
  const problems: string[] = [];
  for (const [proto, ports] of [['TCP', INTERNET_TCP_PORTS], ['UDP', INTERNET_UDP_PORTS]] as const) {
    const r = named.find((x) => x.protocol.toUpperCase() === proto);
    if (!r) problems.push(`${proto} rule missing`);
    else {
      if (!allowsInbound(r)) problems.push(`${proto} rule is not an enabled inbound Allow rule`);
      if (!portListCovers(r.localPort, ports)) problems.push(`${proto} rule ports are ${r.localPort || 'none'}, expected ${ports.join(', ')}`);
      if (!/^any$/i.test(r.remoteAddress.trim())) problems.push(`${proto} rule remote address is "${r.remoteAddress}", expected Any`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Non-secret certificate facts for diagnostics (helps if Electron's BoringSSL treats Sunshine's cert differently). */
export function certSummary(pem: string): Record<string, unknown> {
  try {
    const c = new X509Certificate(pem);
    return { subject: c.subject, issuer: c.issuer, serialNumber: c.serialNumber, validFrom: c.validFrom, validTo: c.validTo, ca: c.ca, keyType: c.publicKey.asymmetricKeyType ?? null };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Compare dotted numeric versions ("2026.914.233613", "v2025.628.4510"). null when either side has no number. */
export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  const parts = (v: string | undefined) => (String(v ?? '').match(/\d+/g) ?? []).map(Number);
  const x = parts(a);
  const y = parts(b);
  if (x.length === 0 || y.length === 0) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Sunshine log lines that mean "no usable video encoder or display" (the web API still answers, so only the log shows it):
 *  - video.cpp probe_encoders: BOOST_LOG(fatal) "Unable to find display or encoder during startup."
 *    and BOOST_LOG(error) "Couldn't find any working encoder matching [<name>]"
 *    https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/video.cpp
 *  - main.cpp: BOOST_LOG(error) "Video failed to find working encoder"
 *    https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/main.cpp
 * (The line "Testing for available encoders, this may generate errors. You can safely ignore those errors." and the
 * per-encoder "Encoder [x] failed" lines are normal and are NOT matched.)
 */
export const NO_ENCODER_RE = /Unable to find display or encoder during startup|Video failed to find working encoder|Couldn't find any working encoder matching/;

/* ------------------------------------------------------------------ steps */

export function createHostSteps(env: HostStepsEnv): HostStep[] {
  const mk = (id: HostStepId, needsAdmin: boolean, probe: (ctx: HostStepContext, s: StepScratch) => Promise<StepOutcome>, apply: (ctx: HostStepContext, s: StepScratch) => Promise<StepOutcome>): HostStep => ({
    id,
    title: STEP_TITLES[id],
    needsAdmin,
    probe: (ctx) => timedStep(id, STEP_TITLES[id], (s) => probe(ctx, s), env.now),
    apply: (ctx) => timedStep(id, STEP_TITLES[id], (s) => apply(ctx, s), env.now),
  });

  const adminCheck = async (ctx: HostStepContext, s: StepScratch): Promise<StepOutcome> => {
    const r = await runPs<{ isAdmin: boolean; userName?: string }>(
      { runner: ctx.runner, systemRoot: ctx.systemRoot, psDir: ctx.psDir, redactor: ctx.log.redactor },
      'test-admin',
      {},
      timing(env).psTimeoutMs,
      s.commands,
    );
    if (!r.ok || !r.json) return { status: 'fail', message: `Could not check admin rights: ${r.error}` };
    ctx.isAdmin = r.json.isAdmin === true;
    s.data.userName = r.json.userName ?? null;
    return ctx.isAdmin ? { status: 'pass', message: 'Running elevated.' } : { status: 'warn', message: 'Not elevated (fine for the app; setup asks for admin rights once).' };
  };

  const locateStep = async (ctx: HostStepContext, s: StepScratch, forApply: boolean): Promise<StepOutcome> => {
    const facts = await getFacts(ctx, env, s);
    s.data.service = facts.service;
    s.data.uninstallEntries = facts.uninstallEntries;
    s.data.env = facts.env;
    const nsis = findNsisInstall(facts);
    if (nsis) {
      ctx.install = null;
      return {
        status: 'fail',
        message: `An old Sunshine installer (NSIS, "${nsis.uninstallString}") is installed. Upstream says to uninstall it first: Windows Settings > Apps > Sunshine > Uninstall, then run setup again. Your Sunshine settings in the config folder are kept.`,
      };
    }
    ctx.install = locate(ctx, env, facts);
    Object.assign(s.data, installData(ctx.install));
    if (ctx.install) {
      const where = `Found at ${ctx.install.root} (via ${ctx.install.foundVia}${ctx.install.version ? `, version ${ctx.install.version}` : ''}).`;
      if (compareVersions(ctx.install.version, SUNSHINE.version) === -1) {
        return {
          status: 'warn',
          message: `${where} This Sunshine is older than the ${SUNSHINE.version} LanPlay was built for and is kept as it is. If pairing fails: Windows Settings > Apps > Sunshine > Uninstall, then run setup again so LanPlay installs ${SUNSHINE.version}.`,
        };
      }
      return { status: 'pass', message: where };
    }
    return forApply ? { status: 'pass', message: 'Sunshine is not installed yet; the next step installs it.' } : { status: 'warn', message: 'Sunshine is not installed. Click "Set up this PC".' };
  };

  return [
    mk('admin', false, adminCheck, async (ctx, s) => {
      const out = await adminCheck(ctx, s);
      return out.status === 'warn' ? { status: 'fail', message: 'Setup is not running elevated. Accept the Windows admin prompt and try again.' } : out;
    }),

    mk('locate-sunshine', false, (ctx, s) => locateStep(ctx, s, false), (ctx, s) => locateStep(ctx, s, true)),

    mk(
      'install-sunshine',
      true,
      async (ctx) => (ctx.install ? { status: 'pass', message: `Installed at ${ctx.install.root}.` } : { status: 'fail', message: 'Sunshine is not installed.' }),
      async (ctx, s) => {
        if (ctx.install) return { status: 'skip', message: `Already installed at ${ctx.install.root}; not reinstalling.` };
        const a = needAdmin(ctx);
        if (a) return a;
        s.data.msi = ctx.bundledMsiPath;
        if (!env.fileExists(ctx.bundledMsiPath)) return { status: 'fail', message: `The bundled Sunshine installer is missing: ${ctx.bundledMsiPath}. Re-extract the LanPlay zip.` };
        const sha = await env.sha256File(ctx.bundledMsiPath);
        s.data.msiSha256 = sha;
        if (sha !== SUNSHINE_MSI_SHA256) return { status: 'fail', message: `The bundled installer does not match its pinned SHA256 (got ${sha}). Not installing. Re-download LanPlay.` };
        const logPath = w.join(ctx.paths.logDir, `msiexec-${new Date(env.now()).toISOString().replace(/[:.]/g, '-')}.log`);
        s.data.msiLog = logPath;
        const { file, args } = buildMsiexecArgs(ctx.systemRoot, ctx.bundledMsiPath, logPath);
        const res = await runRecorded(ctx.runner, { file, args, timeoutMs: timing(env).msiTimeoutMs }, ctx.log.redactor, s.commands);
        s.data.msiExitCode = res.exitCode;
        try {
          s.data.installerLogs = env.collectInstallerLogs?.() ?? [];
        } catch (e) {
          s.data.installerLogs = `not copied: ${(e as Error).message}`;
        }
        if (res.exitCode === 1618) return { status: 'fail', message: 'Another installation is running (msiexec 1618). Wait for it to finish, then run setup again.' };
        if (res.exitCode !== 0 && res.exitCode !== 3010) {
          return { status: 'fail', message: `msiexec failed with exit code ${res.exitCode ?? res.spawnError ?? 'none'}${res.timedOut ? ' (timed out)' : ''}. The installer log is ${logPath} (included in diagnostics).` };
        }
        const facts = await getFacts(ctx, env, s);
        ctx.install = locate(ctx, env, facts);
        Object.assign(s.data, installData(ctx.install));
        if (!ctx.install) return { status: 'fail', message: `msiexec reported success (${res.exitCode}) but Sunshine still cannot be found. See ${logPath}.` };
        return { status: res.exitCode === 3010 ? 'warn' : 'pass', message: `Installed at ${ctx.install.root}${res.exitCode === 3010 ? ' (Windows wants a restart later)' : ''}.` };
      },
    ),

    mk(
      'service',
      true,
      async (ctx, s) => {
        const svc = await serviceState(ctx, env, s);
        s.data.service = svc;
        if (!svc) return { status: 'fail', message: `Windows service "${SUNSHINE.windowsServiceName}" does not exist.` };
        const problems = [];
        if (!/^auto/i.test(svc.startMode)) problems.push(`start mode is ${svc.startMode} (want Auto)`);
        if (svc.state !== 'Running') problems.push(`state is ${svc.state} (want Running)`);
        return problems.length ? { status: 'fail', message: `Service ${problems.join(', ')}.` } : { status: 'pass', message: 'Service exists, starts automatically and is running.' };
      },
      async (ctx, s) => {
        const blocked = needInstall(ctx) ?? needAdmin(ctx);
        if (blocked) return blocked;
        const inst = ctx.install!;
        let svc = await serviceState(ctx, env, s);
        if (!svc) {
          // Upstream scripts (what the silent MSI custom action runs): install-service.bat then autostart-service.bat.
          for (const bat of ['install-service.bat', 'autostart-service.bat']) {
            const p = w.join(inst.root, 'scripts', bat);
            if (!env.fileExists(p)) return { status: 'fail', message: `Service missing and upstream script not found: ${p}.` };
            const { file, args, cwd } = buildBatArgv(ctx.systemRoot, p);
            await runRecorded(ctx.runner, { file, args, timeoutMs: 120_000, cwd }, ctx.log.redactor, s.commands);
          }
          svc = await serviceState(ctx, env, s);
          if (!svc) return { status: 'fail', message: 'install-service.bat ran but the SunshineService service still does not exist (see command output).' };
        }
        if (!/^auto/i.test(svc.startMode)) {
          const r = await runRecorded(ctx.runner, { file: sc(ctx), args: ['config', SUNSHINE.windowsServiceName, 'start=', 'auto'], timeoutMs: 30_000 }, ctx.log.redactor, s.commands);
          if (r.exitCode !== 0) return { status: 'fail', message: `sc.exe config start= auto failed (exit ${r.exitCode}).` };
        }
        if (svc.state !== 'Running') {
          const r = await runRecorded(ctx.runner, { file: sc(ctx), args: ['start', SUNSHINE.windowsServiceName], timeoutMs: 30_000 }, ctx.log.redactor, s.commands);
          // 1056 = ERROR_SERVICE_ALREADY_RUNNING
          if (r.exitCode !== 0 && r.exitCode !== 1056) return { status: 'fail', message: `sc.exe start failed (exit ${r.exitCode}). See sunshine.log in diagnostics.` };
          const st = await waitForService(ctx, env, s, 'Running');
          if (st !== 'Running') return { status: 'fail', message: `Service did not reach Running (last state: ${st}).` };
        }
        return { status: 'pass', message: 'Service exists, starts automatically and is running.' };
      },
    ),

    mk(
      'config',
      true,
      async (ctx, s) => {
        const b = needInstall(ctx);
        if (b) return b;
        const managed = sunshineManagedConfig(env.internet === true);
        const text = env.readText(ctx.install!.configFile) ?? '';
        const m = mergeSunshineConf(text, managed);
        s.data.configFile = ctx.install!.configFile;
        return m.changed ? { status: 'fail', message: `sunshine.conf is missing LanPlay settings (${Object.keys(managed).join(', ')}).` } : { status: 'pass', message: 'sunshine.conf has LanPlay\'s settings.' };
      },
      async (ctx, s) => {
        const b = needInstall(ctx) ?? needAdmin(ctx);
        if (b) return b;
        const file = ctx.install!.configFile;
        const managed = sunshineManagedConfig(env.internet === true);
        const text = env.readText(file) ?? '';
        const m = mergeSunshineConf(text, managed);
        s.data.configFile = file;
        s.data.managed = managed;
        if (!m.changed) return { status: 'pass', message: 'sunshine.conf already correct (not rewritten).' };
        env.writeText(file, m.text);
        const back = env.readText(file);
        if (back !== m.text) return { status: 'fail', message: `Wrote ${file} but reading it back gave different content.` };
        return { status: 'pass', message: `Updated ${file}.` };
      },
    ),

    mk(
      'credentials',
      true,
      async () => {
        const pw = await env.getPassword();
        return pw ? { status: 'pass', message: 'LanPlay has a stored Sunshine admin password (checked by "Sunshine API login works").' } : { status: 'fail', message: 'No stored Sunshine admin password. Click "Set up this PC".' };
      },
      async (ctx, s) => {
        const b = needInstall(ctx) ?? needAdmin(ctx);
        if (b) return b;
        const pw = await env.getPassword();
        if (!pw) return { status: 'fail', message: 'Internal: no password was handed to the elevated setup.' };
        // "--creds username password | set user credentials for the Web manager" (Sunshine src/logging.cpp#L272)
        const res = await runRecorded(
          ctx.runner,
          { file: ctx.install!.exe, args: [SUNSHINE.credsFlag, LANPLAY.sunshineAdminUser, pw], cwd: ctx.install!.root, timeoutMs: 60_000, secrets: [pw] },
          ctx.log.redactor,
          s.commands,
        );
        if (res.spawnError) return { status: 'fail', message: `Could not run sunshine.exe: ${ctx.log.redactor.redact(res.spawnError)}` };
        if (res.timedOut) return { status: 'fail', message: 'sunshine.exe --creds did not exit within 60 s (it may have started a server instead).' };
        if (res.exitCode !== 0) return { status: 'fail', message: `sunshine.exe --creds exited with ${res.exitCode}.` };
        return {
          status: 'pass',
          message: `Sunshine's web login is now user "${LANPLAY.sunshineAdminUser}" with a random password that only LanPlay knows (kept by Windows for your account). Any earlier Sunshine web login was replaced.`,
        };
      },
    ),

    mk(
      'restart-service',
      true,
      async (ctx, s) => {
        const svc = await serviceState(ctx, env, s);
        return svc?.state === 'Running' ? { status: 'pass', message: 'Service running.' } : { status: 'fail', message: `Service is ${svc?.state ?? 'missing'}.` };
      },
      async (ctx, s) => {
        const b = needInstall(ctx) ?? needAdmin(ctx);
        if (b) return b;
        const stop = await runRecorded(ctx.runner, { file: sc(ctx), args: ['stop', SUNSHINE.windowsServiceName], timeoutMs: 30_000 }, ctx.log.redactor, s.commands);
        // 1062 = ERROR_SERVICE_NOT_ACTIVE
        if (stop.exitCode !== 0 && stop.exitCode !== 1062) return { status: 'fail', message: `sc.exe stop failed (exit ${stop.exitCode}).` };
        const stopped = await waitForService(ctx, env, s, 'Stopped');
        if (stopped !== 'Stopped') return { status: 'fail', message: `Service did not stop (state ${stopped}).` };
        const start = await runRecorded(ctx.runner, { file: sc(ctx), args: ['start', SUNSHINE.windowsServiceName], timeoutMs: 30_000 }, ctx.log.redactor, s.commands);
        if (start.exitCode !== 0 && start.exitCode !== 1056) return { status: 'fail', message: `sc.exe start failed (exit ${start.exitCode}).` };
        const running = await waitForService(ctx, env, s, 'Running');
        return running === 'Running' ? { status: 'pass', message: 'Sunshine restarted.' } : { status: 'fail', message: `Service did not come back (state ${running}).` };
      },
    ),

    mk(
      'web-ui',
      false,
      async (ctx, s) => {
        const up = await env.tcpProbe('127.0.0.1', SUNSHINE.webUiPort, 2000);
        s.data.listening = up;
        if (!up) return { status: 'fail', message: `Nothing listens on 127.0.0.1:${SUNSHINE.webUiPort} (Sunshine web UI).` };
        const { pem, from } = await readPinnedPem(env, ctx);
        s.data.pinnedFrom = from;
        if (!pem) return { status: 'fail', message: `No pinned Sunshine certificate at ${env.pinnedCertPath}.` };
        s.data.pinnedFingerprint256 = env.fingerprint(pem);
        s.data.cert = certSummary(pem);
        const tlsr = await env.tlsPinCheck('127.0.0.1', SUNSHINE.webUiPort, pem, 5000);
        s.data.tls = tlsr;
        return tlsr.ok ? { status: 'pass', message: 'Web API up and its certificate matches the pinned one.' } : { status: 'fail', message: `Web API certificate does not match the pinned one: ${tlsr.error}. Run setup again.` };
      },
      async (ctx, s) => {
        const b = needInstall(ctx);
        if (b) return b;
        const t = timing(env);
        const deadline = env.now() + t.webUiWaitMs;
        let up = false;
        for (;;) {
          up = await env.tcpProbe('127.0.0.1', SUNSHINE.webUiPort, 2000);
          if (up || env.now() >= deadline) break;
          await env.sleep(t.pollMs);
        }
        s.data.listening = up;
        if (!up) return { status: 'fail', message: `Sunshine web UI did not start listening on ${SUNSHINE.webUiPort} within ${t.webUiWaitMs / 1000} s. See sunshine.log in diagnostics.` };
        const pem = env.readText(ctx.install!.certFile);
        if (!pem) return { status: 'fail', message: `Sunshine certificate not found at ${ctx.install!.certFile}.` };
        let fp: string;
        try {
          fp = env.fingerprint(pem);
        } catch (e) {
          return { status: 'fail', message: `Sunshine certificate unreadable: ${(e as Error).message}` };
        }
        s.data.certFingerprint256 = fp;
        s.data.cert = certSummary(pem);
        const tlsr = await env.tlsPinCheck('127.0.0.1', SUNSHINE.webUiPort, pem, 5000);
        s.data.tls = tlsr;
        if (!tlsr.ok) return { status: 'fail', message: `The web API serves a different certificate than ${ctx.install!.certFile}: ${tlsr.error}` };
        env.copyFile(ctx.install!.certFile, env.pinnedCertPath);
        s.data.pinnedCopy = env.pinnedCertPath;
        return { status: 'pass', message: `Pinned Sunshine certificate ${fp.slice(0, 23)}… (copy at ${env.pinnedCertPath}).` };
      },
    ),

    mk('api-auth', false, (ctx, s) => apiAuth(ctx, s, 0), (ctx, s) => apiAuth(ctx, s, timing(env).apiRetries)),

    mk(
      'firewall-sunshine',
      true,
      async (ctx, s) => {
        const rules = await firewallRules(ctx, env, s, [SUNSHINE.firewallRuleName]);
        s.data.rules = rules;
        const ev = evaluateSunshineFirewall(rules);
        return ev.ok ? { status: 'pass', message: 'Inbound "Sunshine" rules (TCP + UDP) present and enabled.' } : { status: 'fail', message: `Firewall rule "Sunshine" missing for ${ev.missing.join(' + ')}.` };
      },
      async (ctx, s) => {
        const b = needInstall(ctx) ?? needAdmin(ctx);
        if (b) return b;
        let rules = await firewallRules(ctx, env, s, [SUNSHINE.firewallRuleName]);
        if (evaluateSunshineFirewall(rules).ok) {
          s.data.rules = rules;
          return { status: 'pass', message: 'Inbound "Sunshine" rules already present.' };
        }
        const bat = w.join(ctx.install!.root, 'scripts', 'add-firewall-rule.bat');
        if (!env.fileExists(bat)) return { status: 'fail', message: `Rule missing and upstream script not found: ${bat}.` };
        const { file, args, cwd } = buildBatArgv(ctx.systemRoot, bat);
        await runRecorded(ctx.runner, { file, args, timeoutMs: 60_000, cwd }, ctx.log.redactor, s.commands);
        rules = await firewallRules(ctx, env, s, [SUNSHINE.firewallRuleName]);
        s.data.rules = rules;
        const ev = evaluateSunshineFirewall(rules);
        return ev.ok ? { status: 'pass', message: 'Added inbound "Sunshine" rules.' } : { status: 'fail', message: `add-firewall-rule.bat ran but rules are still missing for ${ev.missing.join(' + ')}.` };
      },
    ),

    mk(
      'firewall-agent',
      true,
      async (ctx, s) => agentFirewall(ctx, s, false),
      async (ctx, s) => agentFirewall(ctx, s, true),
    ),

    mk(
      'firewall-internet',
      true,
      async (ctx, s) => internetFirewall(ctx, s, false),
      async (ctx, s) => internetFirewall(ctx, s, true),
    ),

    mk(
      'agent-autostart',
      false,
      async () => {
        if (!env.loginItem) return { status: 'skip', message: 'Checked by the LanPlay app (user session).' };
        return env.loginItem.get() ? { status: 'pass', message: 'LanPlay starts the pair agent at login.' } : { status: 'fail', message: 'LanPlay is not set to start at login.' };
      },
      async () => {
        if (!env.loginItem) return { status: 'skip', message: 'Done by the LanPlay app after the elevated part.' };
        env.loginItem.set(true);
        return env.loginItem.get() ? { status: 'pass', message: 'LanPlay will start the pair agent at login.' } : { status: 'fail', message: 'Could not register LanPlay to start at login.' };
      },
    ),

    mk('agent-listening', false, agentListening, agentListening),
  ];

  async function apiAuth(ctx: HostStepContext, s: StepScratch, retries: number): Promise<StepOutcome> {
    const { pem, from } = await readPinnedPem(env, ctx);
    s.data.pinnedFrom = from;
    if (!pem) return { status: 'fail', message: 'No pinned Sunshine certificate yet (the "web API" step must pass first).' };
    const pw = await env.getPassword();
    if (!pw) return { status: 'fail', message: 'No stored Sunshine admin password. Click "Set up this PC".' };
    const client = env.createSunshineClient({
      baseUrl: `https://127.0.0.1:${SUNSHINE.webUiPort}`,
      username: LANPLAY.sunshineAdminUser,
      getPassword: async () => pw,
      pinnedCertPem: pem,
      timeoutMs: 10_000,
      onCall: (r) => ctx.log.rest(r),
    });
    let clients;
    for (let attempt = 0; ; attempt++) {
      try {
        clients = await client.listClients();
        break;
      } catch (e) {
        const kind = e instanceof SunshineApiError ? e.kind : 'unknown';
        // Right after a service restart the port can accept before the API is ready: retry only those cases.
        if (attempt < retries && (kind === 'network' || kind === 'timeout')) {
          s.data.retries = attempt + 1;
          await env.sleep(timing(env).apiRetryMs);
          continue;
        }
        s.data.errorKind = kind;
        return { status: 'fail', message: explainApiError(e) };
      }
    }
    s.data.pairedClients = clients.length;
    try {
      s.data.sunshineVersion = await client.getVersion();
      if (ctx.install && typeof s.data.sunshineVersion === 'string') ctx.install.version = s.data.sunshineVersion;
    } catch {
      /* version is informational */
    }
    // The API answers even when Sunshine found no usable video encoder; only its log says so.
    try {
      const logTail = await client.getLogsTail(128 * 1024);
      const line = logTail.split(/\r?\n/).reverse().find((l) => NO_ENCODER_RE.test(l));
      if (line) {
        s.data.encoderProblem = ctx.log.redactor.redact(line.trim().slice(0, 300));
        return {
          status: 'warn',
          message: `Logged in to Sunshine's API, but Sunshine reports it found no working video encoder or display ("${String(s.data.encoderProblem).slice(0, 120)}"). Streaming will fail until that is fixed: update the graphics driver, keep a monitor (or dummy plug) connected and switched on, and do not use Remote Desktop on this PC while streaming.`,
        };
      }
    } catch {
      /* log check is informational */
    }
    return { status: 'pass', message: `Logged in to Sunshine's API (${clients.length} paired device(s)).` };
  }

  async function agentFirewall(ctx: HostStepContext, s: StepScratch, apply: boolean): Promise<StepOutcome> {
    const check = async () => {
      const rules = await firewallRules(ctx, env, s, [LANPLAY.agentFirewallRuleName], env.selfExe);
      s.data.rules = rules;
      return evaluateAgentFirewall(rules, LANPLAY.agentPort);
    };
    let ev = await check();
    if (apply && (!ev.ok || ev.blockRules.length > 0)) {
      const a = needAdmin(ctx);
      if (a) return a;
      const r = await runPs<{ rules: unknown; removedBlockRules?: string[] | string; blockRuleError?: string }>(
        { runner: ctx.runner, systemRoot: ctx.systemRoot, psDir: ctx.psDir, redactor: ctx.log.redactor },
        'set-agent-firewall-rule',
        // -Program also adds allow rules bound to LanPlay.exe so Windows never shows its "allow access?" prompt
        // (dismissing that prompt creates a Block rule, and Block beats Allow).
        { Port: LANPLAY.agentPort, Name: LANPLAY.agentFirewallRuleName, Program: env.selfExe },
        timing(env).psTimeoutMs,
        s.commands,
      );
      if (!r.ok) return { status: 'fail', message: `set-agent-firewall-rule.ps1 failed: ${r.error}` };
      const removed = r.json?.removedBlockRules;
      s.data.removedBlockRules = Array.isArray(removed) ? removed : removed ? [removed] : [];
      if (r.json?.blockRuleError) s.data.blockRuleError = r.json.blockRuleError;
      ev = await check();
    }
    if (!ev.ok) return { status: 'fail', message: `Agent firewall rule: ${ev.problems.join('; ')}.` };
    if (ev.blockRules.length) {
      return {
        status: 'warn',
        message: apply
          ? `Rules OK, but ${ev.blockRules.length} enabled Block rule(s) for LanPlay.exe could not be removed${s.data.blockRuleError ? ` (${String(s.data.blockRuleError)})` : ''}. Block wins over Allow: open "Windows Defender Firewall with Advanced Security" > Inbound Rules and delete the Block rules named "${ev.blockRules[0]!.name}".`
          : `Rules OK, but Windows Firewall also has ${ev.blockRules.length} enabled Block rule(s) for LanPlay.exe (created when its firewall prompt was dismissed). Block wins over Allow, so the Mac cannot reach this PC: press "Set up / Repair" to remove them.`,
      };
    }
    const removedCount = Array.isArray(s.data.removedBlockRules) ? s.data.removedBlockRules.length : 0;
    return {
      status: 'pass',
      message: `Inbound TCP+UDP ${LANPLAY.agentPort} allowed from the local subnet.${removedCount ? ` Removed ${removedCount} Block rule(s) Windows had created for LanPlay.exe when its firewall prompt was dismissed.` : ''}`,
    };
  }

  async function internetFirewall(ctx: HostStepContext, s: StepScratch, apply: boolean): Promise<StepOutcome> {
    const on = env.internet === true;
    s.data.internet = on;
    const check = async () => {
      const rules = await firewallRules(ctx, env, s, [LANPLAY.internetFirewallRuleName]);
      s.data.rules = rules;
      return evaluateInternetFirewall(rules, on);
    };
    let ev = await check();
    if (apply && !ev.ok) {
      const a = needAdmin(ctx);
      if (a) return a;
      const params: Record<string, string | number | readonly number[]> = { Enable: on ? 1 : 0, Name: LANPLAY.internetFirewallRuleName };
      if (on) {
        params.TcpPorts = INTERNET_TCP_PORTS;
        params.UdpPorts = udpRange;
      }
      const r = await runPs<{ rules: unknown; removed?: string[] | string }>(
        { runner: ctx.runner, systemRoot: ctx.systemRoot, psDir: ctx.psDir, redactor: ctx.log.redactor },
        'set-internet-firewall-rule',
        params,
        timing(env).psTimeoutMs,
        s.commands,
      );
      if (!r.ok) return { status: 'fail', message: `set-internet-firewall-rule.ps1 failed: ${r.error}` };
      ev = await check();
    }
    if (!ev.ok) return { status: 'fail', message: `Internet firewall rule: ${ev.problems.join('; ')}.` };
    return on
      ? { status: 'pass', message: `Inbound TCP ${INTERNET_TCP_PORTS.join(', ')} and UDP ${udpRange} are open to the internet (Sunshine's own ports only).` }
      : { status: 'pass', message: `Internet play is off: no "${LANPLAY.internetFirewallRuleName}" rule.` };
  }

  async function agentListening(_ctx: HostStepContext, s: StepScratch): Promise<StepOutcome> {
    if (!env.agentProbe) return { status: 'skip', message: 'Checked by the LanPlay app after the elevated part.' };
    const r = await env.agentProbe();
    s.data.agent = r;
    if (r.http && r.udp) return { status: 'pass', message: `Pair agent answers on TCP and UDP ${LANPLAY.agentPort}.` };
    if (r.http) return { status: 'warn', message: `Pair agent answers on TCP but not UDP discovery (${r.detail}). Macs can still add this PC by IP.` };
    return { status: 'fail', message: `Pair agent does not answer on 127.0.0.1:${LANPLAY.agentPort}: ${r.detail}` };
  }
}

/** Steps the elevated child runs; the rest belongs to the user session. */
export const ELEVATED_STEP_IDS: readonly HostStepId[] = ['admin', 'locate-sunshine', 'install-sunshine', 'service', 'config', 'credentials', 'restart-service', 'web-ui', 'api-auth', 'firewall-sunshine', 'firewall-agent', 'firewall-internet'];
export const USER_STEP_IDS: readonly HostStepId[] = ['agent-autostart', 'agent-listening'];

export { sleep };
