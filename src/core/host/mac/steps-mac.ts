// macOS host setup steps (docs/MAC-HOST-DESIGN.md 2.6 and 2.7). Same contract as the Windows steps: probe() never
// changes the machine, apply() is idempotent. Everything is per-user, so nothing here needs elevation, and every process
// runs as an argv array through the injected ProcessRunner.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { LANPLAY, SUNSHINE, SUNSHINE_MAC, SunshineApiError } from '../../../contracts.js';
import type { ExecResult, HostStep, HostStepContext, HostStepId, KeyValueStore, ProcessRunner, SunshineInstall } from '../../../contracts.js';
import { runRecorded } from '../../shared/exec.js';
import { timedStep } from '../../shared/steprec.js';
import type { StepOutcome, StepScratch } from '../../shared/steprec.js';
import { mergeSunshineConf } from '../sunshine-conf.js';
import { certSummary, STEP_TITLES } from '../steps.js';
import type { HostStepsEnv } from '../steps.js';
import { SUNSHINE_MAC_DMG_SHA256, SUNSHINE_MAC_TEAM_ID, SUNSHINE_MAC_VERSION } from '../vendor.js';
import { bootoutArgv, bootstrapArgv, buildAgentPlist, kickstartArgv, lanplayAgentSpec, parseLaunchctlPrint, plistPath, printArgv } from './launchd.js';
import type { ArgvCall, LaunchctlJob } from './launchd.js';
import { firewallStateArgv, parseFirewallState, screenRecordingDenied } from './permissions-mac.js';
import { dittoArgv, installedJsonText, macManagedConfig, planSunshineInstall, sunshineAgentSpec, sunshinePaths, verifySunshineSignature } from './sunshine-mac.js';
import type { SunshineMacPaths } from './sunshine-mac.js';

const posix = path.posix;

/** The user pressed "I did this" after switching Sunshine on under Accessibility. LanPlay cannot read that grant itself. */
export const INPUT_CONFIRMED_KEY = 'host.mac.inputConfirmed';
/**
 * Digest of the admin login `--creds` last wrote. It lets a second setup skip rewriting the credentials (and so the
 * restart they need). The password is 256 random bits, so its digest reveals nothing.
 */
export const CREDENTIALS_STAMP_KEY = 'host.mac.credentialsStamp';

export const MAC_TIMING = {
  /** How long Sunshine gets to show up in launchd after bootstrap or kickstart. */
  launchWaitMs: 15_000,
  /** How long to wait for the web UI port before concluding that Sunshine is not answering (and not just slow). */
  screenWaitMs: 20_000,
  webUiWaitMs: 60_000,
  pollMs: 1000,
  /** api-auth during setup: Sunshine may accept TCP a moment before its API answers. */
  apiRetries: 5,
  apiRetryMs: 2000,
};

/** The platform-neutral part of the Windows env, plus what only a Mac needs. Injected so tests can fake the machine. */
export interface MacStepsEnv
  extends Pick<HostStepsEnv, 'fileExists' | 'readText' | 'writeText' | 'copyFile' | 'getPassword' | 'createSunshineClient' | 'tcpProbe' | 'tlsPinCheck' | 'fingerprint' | 'agentProbe' | 'now' | 'sleep'> {
  /** The user's home folder (LaunchAgents live in ~/Library/LaunchAgents). */
  home: string;
  uid: number;
  /** LanPlay's own executable, and the argv before `--agent` (a dev run starts electron with the app path). */
  selfExe: string;
  selfArgsPrefix: readonly string[];
  /** Sunshine.app inside the LanPlay bundle. */
  bundledApp: string;
  macOS: { major: number; arch: string };
  settings: KeyValueStore;
  mkdirp(dir: string): void;
  /** rm -rf: a file or a whole app bundle. */
  remove(p: string): void;
  /** Same-volume move; `to` must not exist. */
  rename(from: string, to: string): void;
  /** Creation time in ms (stat birthtime); null when the file is missing. */
  fileBornMs(p: string): number | null;
  /** The last few hundred KiB of a text file; null when it is missing. */
  readLog(p: string): string | null;
  timing?: Partial<typeof MAC_TIMING>;
}

export interface MacStepsOptions {
  /** "Restart Sunshine": kickstart -k even though nothing changed. */
  restart?: boolean;
}

const FOREIGN_SUNSHINE = 'Another Sunshine is running on this Mac. Quit it, then press Set up again.';

const fail = (message: string, data?: Record<string, unknown>): StepOutcome => (data ? { status: 'fail', message, data } : { status: 'fail', message });

function plistString(xml: string | null, key: string): string | null {
  const m = xml ? new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml) : null;
  return m ? m[1]! : null;
}

function installRecord(paths: SunshineMacPaths, version: string | null): SunshineInstall {
  const install: SunshineInstall = { root: paths.app, exe: paths.binary, serviceExe: '', configDir: paths.dir, configFile: paths.conf, logFile: paths.log, certFile: paths.cert, foundVia: 'lanplay-managed' };
  if (version) install.version = version;
  return install;
}

function describeJob(j: LaunchctlJob): string {
  return `launchd state: ${j.state ?? 'not loaded'}, last exit code: ${j.lastExitCode ?? 'none'}${j.lastSignal ? `, last signal: ${j.lastSignal}` : ''}`;
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

export function createMacHostSteps(env: MacStepsEnv, opts: MacStepsOptions = {}): HostStep[] {
  const t = { ...MAC_TIMING, ...(env.timing ?? {}) };
  // Two facts that one step hands to a later step of the same run; steps are created per operation, never kept.
  /** Something Sunshine reads at start (the app copy, sunshine.conf, the credentials) changed, so a running Sunshine is stale. */
  let restartNeeded = opts.restart === true;
  /**
   * When this run (re)started Sunshine; null while the Sunshine that was already running is still the one to look at.
   * Sunshine renames sunshine.log away at every start (logging.h rotate_log_file, `--creds` runs included), so the
   * current file belongs to this start only once it was created after this moment.
   */
  let startedAt: number | null = null;

  const paths = (ctx: HostStepContext) => sunshinePaths(ctx.paths.sharedData, ctx.paths.logDir);
  const sunshinePlist = () => plistPath(env.home, SUNSHINE_MAC.launchdLabel);
  const agentPlist = () => plistPath(env.home, SUNSHINE_MAC.agentLaunchdLabel);
  const agentPlistText = () => buildAgentPlist({ ...lanplayAgentSpec(env.selfExe), args: [...env.selfArgsPrefix, '--agent'] });

  const mk = (id: HostStepId, probe: (ctx: HostStepContext, s: StepScratch) => Promise<StepOutcome>, apply: (ctx: HostStepContext, s: StepScratch) => Promise<StepOutcome> = probe): HostStep => ({
    id,
    title: STEP_TITLES[id],
    needsAdmin: false,
    probe: (ctx) => timedStep(id, STEP_TITLES[id], (s) => probe(ctx, s), env.now),
    apply: (ctx) => timedStep(id, STEP_TITLES[id], (s) => apply(ctx, s), env.now),
  });

  /* ---------------------------------------------------------------- helpers */

  const exec = (ctx: HostStepContext, s: StepScratch, call: ArgvCall, timeoutMs = 30_000, secrets?: readonly string[]): Promise<ExecResult> =>
    runRecorded(ctx.runner, { file: call.file, args: call.args, timeoutMs, ...(secrets ? { secrets } : {}) }, ctx.log.redactor, s.commands);

  /** The runner that signature checks use, so their codesign calls land in the step's command list. */
  const recording = (ctx: HostStepContext, s: StepScratch): ProcessRunner => ({ run: (req) => runRecorded(ctx.runner, req, ctx.log.redactor, s.commands) });

  async function job(ctx: HostStepContext, s: StepScratch): Promise<LaunchctlJob> {
    const r = await exec(ctx, s, printArgv(env.uid, SUNSHINE_MAC.launchdLabel), 15_000);
    if (r.spawnError) throw new Error(`launchctl could not run: ${r.spawnError}`);
    return parseLaunchctlPrint(r.stdout);
  }

  /** Who answers on Sunshine's ports although launchd's Sunshine is not running? Only then is it somebody else's. */
  async function foreignPort(j: LaunchctlJob): Promise<number | null> {
    if (j.pid !== null) return null;
    for (const port of [SUNSHINE.httpPort, SUNSHINE.webUiPort]) if (await env.tcpProbe('127.0.0.1', port, 1000)) return port;
    return null;
  }

  const needInstall = (ctx: HostStepContext): StepOutcome | null => (env.fileExists(paths(ctx).binary) ? null : fail('Blocked: Sunshine is not installed (see "Install Sunshine (private copy)").'));

  function currentLog(ctx: HostStepContext): string {
    const log = paths(ctx).log;
    if (startedAt !== null && (env.fileBornMs(log) ?? -Infinity) < startedAt) return ''; // the new start has not opened its log yet
    return env.readLog(log) ?? '';
  }

  /** Sunshine keeps running without the Screen Recording grant (it only logs it), so a running job is a healthy launch agent. */
  const launchOutcome = (j: LaunchctlJob): StepOutcome | null => (j.loaded && j.pid !== null ? { status: 'pass', message: `Sunshine is running (pid ${j.pid}).` } : null);

  async function checkBundle(ctx: HostStepContext, s: StepScratch): Promise<StepOutcome> {
    const app = env.bundledApp;
    s.data.bundledApp = app;
    s.data.macOS = env.macOS;
    if (env.macOS.major < SUNSHINE_MAC.minMacOS) return fail(`Hosting needs macOS ${SUNSHINE_MAC.minMacOS} or newer (this Mac runs macOS ${env.macOS.major}). Sunshine's system audio capture does not exist before that.`);
    if (env.macOS.arch !== 'arm64') return fail(`The bundled Sunshine is built for Apple Silicon Macs (this Mac is ${env.macOS.arch}).`);
    if (!env.fileExists(posix.join(app, SUNSHINE_MAC.binaryRelative))) return fail(`The bundled Sunshine is missing: ${app}. Reinstall LanPlay.`);
    const version = plistString(env.readText(posix.join(app, 'Contents', 'Info.plist')), 'CFBundleShortVersionString');
    if (version !== SUNSHINE_MAC_VERSION) return fail(`The bundled Sunshine is version ${version ?? 'unknown'}, but this LanPlay was built for ${SUNSHINE_MAC_VERSION}. Reinstall LanPlay.`);
    const sig = await verifySunshineSignature(recording(ctx, s), app, SUNSHINE_MAC_TEAM_ID);
    if (!sig.ok) return fail(`The bundled Sunshine failed its signature check: ${sig.reason}. Reinstall LanPlay.`);
    return { status: 'pass', message: `Sunshine ${version} is bundled and signed by team ${sig.teamId}.` };
  }

  const installPlan = (ctx: HostStepContext, s: StepScratch) =>
    planSunshineInstall(
      {
        fs: {
          exists: env.fileExists,
          readText: async (f) => {
            const text = env.readText(f);
            if (text === null) throw new Error(`cannot read ${f}`);
            return text;
          },
        },
        runner: recording(ctx, s),
      },
      paths(ctx),
      { version: SUNSHINE_MAC_VERSION, dmgSha256: SUNSHINE_MAC_DMG_SHA256, teamId: SUNSHINE_MAC_TEAM_ID },
    );

  const credentialsStamp = (pw: string) => createHash('sha256').update(`${LANPLAY.sunshineAdminUser}\n${pw}`).digest('hex');

  const inputOutcome = (ctx: HostStepContext): StepOutcome =>
    env.settings.get(INPUT_CONFIRMED_KEY, false)
      ? { status: 'pass', message: 'You confirmed that Sunshine may control the keyboard and mouse.' }
      : {
          status: 'warn',
          message: `Let Sunshine control the keyboard and mouse: open Accessibility settings and switch Sunshine on (press + and choose ${paths(ctx).app} if it is not listed), then press "I did this". Without it a stream shows the screen but ignores keys and clicks.`,
          data: { settingsPane: 'accessibility', userAction: 'confirm-input' },
        };

  /* ---------------------------------------------------------------- steps */

  const bundle = mk('mac-bundle', async (ctx, s) => checkBundle(ctx, s));

  const install = mk(
    'mac-install',
    async (ctx, s) => {
      const P = paths(ctx);
      const plan = await installPlan(ctx, s);
      s.data.plan = plan.reason;
      if (env.fileExists(P.app)) ctx.install = installRecord(P, null);
      if (!plan.needsCopy) return { status: 'pass', message: `Sunshine ${SUNSHINE_MAC_VERSION} is installed at ${P.app}.` };
      if (plan.reason === 'version-changed') return { status: 'warn', message: `A newer Sunshine (${SUNSHINE_MAC_VERSION}) came with this LanPlay. Press "Restart Sunshine" to switch to it.` };
      if (plan.reason === 'signature-invalid') return fail(`The Sunshine copy at ${P.app} does not pass its signature check. Press "Set up / Repair".`);
      return fail('Sunshine is not installed yet. Press "Set up this Mac".');
    },
    async (ctx, s) => {
      const P = paths(ctx);
      const plan = await installPlan(ctx, s);
      s.data.plan = plan.reason;
      if (!plan.needsCopy) {
        ctx.install = installRecord(P, SUNSHINE_MAC_VERSION);
        return { status: 'pass', message: `Sunshine ${SUNSHINE_MAC_VERSION} is already installed at ${P.app} (not copied again).` };
      }
      // Never swap a working copy for one that fails its checks.
      const checked = await checkBundle(ctx, s);
      if (checked.status === 'fail') return fail(`Not installing: ${checked.message}`);

      // The new copy is made and verified next to the old one, which keeps running until the swap. A fresh folder,
      // because ditto onto an existing app merges: files the new version dropped would stay and break its seal.
      const stagingDir = posix.dirname(P.staging);
      env.remove(stagingDir);
      env.mkdirp(stagingDir);
      const copy = await exec(ctx, s, dittoArgv(env.bundledApp, P.staging), 120_000);
      if (copy.exitCode !== 0) {
        env.remove(stagingDir);
        return fail(`Copying Sunshine failed (ditto exit ${copy.exitCode ?? copy.spawnError ?? 'none'}): ${copy.stderr.trim().slice(0, 200)}`);
      }
      const sig = await verifySunshineSignature(recording(ctx, s), P.staging, SUNSHINE_MAC_TEAM_ID);
      if (!sig.ok) {
        env.remove(stagingDir);
        return fail(`The new Sunshine copy failed its signature check: ${sig.reason}`);
      }

      const j = await job(ctx, s);
      if (j.loaded) {
        const out = await exec(ctx, s, bootoutArgv(env.uid, SUNSHINE_MAC.launchdLabel));
        if (out.exitCode !== 0) {
          env.remove(stagingDir);
          return fail(`Could not stop the running Sunshine to replace it (launchctl bootout exit ${out.exitCode}).`);
        }
      }
      env.remove(P.installedJson);
      env.remove(P.app);
      env.rename(P.staging, P.app);
      env.remove(stagingDir);
      // Written last: a copy without installed.json counts as not installed and is redone.
      env.writeText(P.installedJson, installedJsonText({ version: SUNSHINE_MAC_VERSION, dmgSha256: SUNSHINE_MAC_DMG_SHA256, teamId: sig.teamId, copiedAt: new Date(env.now()).toISOString() }));
      restartNeeded = true;
      ctx.install = installRecord(P, SUNSHINE_MAC_VERSION);
      return { status: 'pass', message: `Copied Sunshine ${SUNSHINE_MAC_VERSION} to ${P.app}.` };
    },
  );

  const config = mk(
    'config',
    async (ctx, s) => {
      const blocked = needInstall(ctx);
      if (blocked) return blocked;
      const P = paths(ctx);
      s.data.configFile = P.conf;
      const m = mergeSunshineConf(env.readText(P.conf) ?? '', macManagedConfig(P));
      return m.changed ? fail(`sunshine.conf is missing LanPlay settings (${Object.keys(macManagedConfig(P)).join(', ')}).`) : { status: 'pass', message: 'sunshine.conf has LanPlay\'s settings.' };
    },
    async (ctx, s) => {
      const blocked = needInstall(ctx);
      if (blocked) return blocked;
      const P = paths(ctx);
      const managed = macManagedConfig(P);
      s.data.configFile = P.conf;
      s.data.managed = managed;
      const m = mergeSunshineConf(env.readText(P.conf) ?? '', managed);
      if (!m.changed) return { status: 'pass', message: 'sunshine.conf already correct (not rewritten).' };
      env.mkdirp(P.dir);
      // Sunshine writes its certificate here and does not create the folder itself.
      env.mkdirp(P.credentialsDir);
      env.writeText(P.conf, m.text);
      if (env.readText(P.conf) !== m.text) return fail(`Wrote ${P.conf} but reading it back gave different content.`);
      restartNeeded = true;
      return { status: 'pass', message: `Updated ${P.conf}.` };
    },
  );

  const credentials = mk(
    'credentials',
    async () => ((await env.getPassword()) ? { status: 'pass', message: 'LanPlay has a stored Sunshine admin password (checked by "Sunshine API login works").' } : fail('No stored Sunshine admin password. Press "Set up this Mac".')),
    async (ctx, s) => {
      const blocked = needInstall(ctx);
      if (blocked) return blocked;
      const P = paths(ctx);
      const pw = await env.getPassword();
      if (!pw) return fail('Internal: no admin password was stored before setup.');
      const stamp = credentialsStamp(pw);
      if (env.settings.get(CREDENTIALS_STAMP_KEY, '') === stamp && env.fileExists(P.state)) return { status: 'pass', message: 'Sunshine\'s admin login is already set (not rewritten).' };
      // "--creds username password | set user credentials for the Web manager"; the config file argument keeps it out of ~/.config/sunshine.
      // Sunshine has no other offline way to set them, so for this sub-second run the password is in argv, which `ps`
      // shows to every local account on macOS. It also rotates sunshine.log; the restart below gives Sunshine a new one.
      const res = await exec(ctx, s, { file: P.binary, args: [P.conf, SUNSHINE.credsFlag, LANPLAY.sunshineAdminUser, pw] }, 60_000, [pw]);
      if (res.spawnError) return fail(`Could not run Sunshine: ${ctx.log.redactor.redact(res.spawnError)}`);
      if (res.timedOut) return fail('Sunshine --creds did not exit within 60 s (it may have started a server instead).');
      if (res.exitCode !== 0) return fail(`Sunshine --creds exited with ${res.exitCode}.`);
      env.settings.set(CREDENTIALS_STAMP_KEY, stamp);
      restartNeeded = true;
      return { status: 'pass', message: `Sunshine's web login is now user "${LANPLAY.sunshineAdminUser}" with a random password that only LanPlay knows (kept in LanPlay's secret store). Any earlier Sunshine web login was replaced.` };
    },
  );

  const launchAgent = mk(
    'mac-launch-agent',
    async (ctx, s) => {
      const P = paths(ctx);
      const j = await job(ctx, s);
      s.data.job = j;
      if (await foreignPort(j)) return fail(FOREIGN_SUNSHINE);
      const have = env.readText(sunshinePlist());
      const stale = have !== buildAgentPlist(sunshineAgentSpec(P));
      if (!j.loaded) return fail(`Sunshine's launch agent is not loaded${have === null ? ' and its plist is missing' : ''}. Press "Set up / Repair".`);
      const running = launchOutcome(j);
      if (!running) return fail(`Sunshine is loaded but not running (${describeJob(j)}). See ${P.launchdLog} and sunshine.log in diagnostics.`);
      return stale ? { status: 'warn', message: `${running.message} Its launch agent file is out of date: press "Set up / Repair".` } : running;
    },
    async (ctx, s) => {
      const blocked = needInstall(ctx);
      if (blocked) return blocked;
      const P = paths(ctx);
      let j = await job(ctx, s);
      if (await foreignPort(j)) return fail(FOREIGN_SUNSHINE);

      const plist = sunshinePlist();
      const want = buildAgentPlist(sunshineAgentSpec(P));
      const rewrite = env.readText(plist) !== want;
      if (rewrite) {
        env.mkdirp(posix.dirname(plist));
        env.mkdirp(ctx.paths.logDir); // launchd does not create the folder of StandardOutPath
        env.writeText(plist, want);
      }
      s.data.plist = plist;
      // launchd keeps the definition it loaded; only bootout + bootstrap reads a changed plist.
      if (j.loaded && rewrite) {
        const out = await exec(ctx, s, bootoutArgv(env.uid, SUNSHINE_MAC.launchdLabel));
        if (out.exitCode !== 0) return fail(`launchctl bootout failed (exit ${out.exitCode}): ${out.stderr.trim().slice(0, 200)}`);
        j = { loaded: false, state: null, pid: null, lastExitCode: null, lastSignal: null };
      }

      if (!j.loaded) {
        startedAt = env.now();
        const out = await exec(ctx, s, bootstrapArgv(env.uid, plist));
        if (out.exitCode !== 0) {
          return fail(`launchctl bootstrap failed (exit ${out.exitCode}): ${out.stderr.trim().slice(0, 200)}. macOS may have blocked the launch agent: check Login Items & Extensions.`, { settingsPane: 'login-items' });
        }
      } else if (restartNeeded || j.pid === null) {
        // Not running = launchd is throttling a crash loop: start it now rather than in up to 10 s.
        startedAt = env.now();
        const out = await exec(ctx, s, kickstartArgv(env.uid, SUNSHINE_MAC.launchdLabel, j.pid !== null));
        if (out.exitCode !== 0) return fail(`launchctl kickstart failed (exit ${out.exitCode}): ${out.stderr.trim().slice(0, 200)}`);
      }
      restartNeeded = false;

      const deadline = env.now() + t.launchWaitMs;
      for (;;) {
        j = await job(ctx, s);
        const up = launchOutcome(j);
        if (up) return up;
        if (env.now() >= deadline) break;
        await env.sleep(t.pollMs);
      }
      s.data.job = j;
      return fail(`Sunshine did not start (${describeJob(j)}). See ${P.launchdLog} and sunshine.log in diagnostics.`);
    },
  );

  /**
   * Sunshine checks the grant once at start (platf::init), logs the refusal and carries on, web UI included, so an open
   * port proves nothing: the log of the current start decides. The check runs before the web server starts, so once the
   * port answers that line is already written. Sunshine never re-checks, hence the restart button.
   */
  async function screenRecording(ctx: HostStepContext, s: StepScratch, wait: boolean): Promise<StepOutcome> {
    const deadline = env.now() + (wait ? t.screenWaitMs : 0);
    for (;;) {
      const up = await env.tcpProbe('127.0.0.1', SUNSHINE.webUiPort, 2000);
      if (screenRecordingDenied(currentLog(ctx))) {
        return fail('macOS has not allowed Sunshine to record this Mac\'s screen. Open Screen Recording settings, switch Sunshine on, then press "Restart Sunshine" (Sunshine only checks this when it starts).', {
          settingsPane: 'screen-recording',
          userAction: 'restart-sunshine',
        });
      }
      if (up) return { status: 'pass', message: 'Sunshine started with macOS allowing it to record the screen.' };
      if (env.now() >= deadline) break;
      await env.sleep(t.pollMs);
    }
    const j = await job(ctx, s);
    return fail(`Sunshine is not answering on port ${SUNSHINE.webUiPort} (${describeJob(j)}). See ${paths(ctx).launchdLog} and sunshine.log in diagnostics.`);
  }
  const screen = mk(
    'mac-screen-recording',
    (ctx, s) => screenRecording(ctx, s, false),
    (ctx, s) => screenRecording(ctx, s, true),
  );

  const webUi = mk(
    'web-ui',
    async (ctx, s) => {
      const P = paths(ctx);
      const up = await env.tcpProbe('127.0.0.1', SUNSHINE.webUiPort, 2000);
      s.data.listening = up;
      if (!up) return fail(`Nothing listens on 127.0.0.1:${SUNSHINE.webUiPort} (Sunshine web UI).`);
      const pem = env.readText(P.pinnedCert) ?? env.readText(P.cert);
      if (!pem) return fail(`No pinned Sunshine certificate at ${P.pinnedCert}.`);
      try {
        s.data.pinnedFingerprint256 = env.fingerprint(pem);
      } catch (e) {
        return fail(`The pinned Sunshine certificate is unreadable (${(e as Error).message}). Run setup again.`);
      }
      s.data.cert = certSummary(pem);
      const tls = await env.tlsPinCheck('127.0.0.1', SUNSHINE.webUiPort, pem, 5000);
      s.data.tls = tls;
      return tls.ok ? { status: 'pass', message: 'Web API up and its certificate matches the pinned one.' } : fail(`Web API certificate does not match the pinned one: ${tls.error}. Run setup again.`);
    },
    async (ctx, s) => {
      const blocked = needInstall(ctx);
      if (blocked) return blocked;
      const P = paths(ctx);
      const deadline = env.now() + t.webUiWaitMs;
      let up = false;
      for (;;) {
        up = await env.tcpProbe('127.0.0.1', SUNSHINE.webUiPort, 2000);
        if (up || env.now() >= deadline) break;
        await env.sleep(t.pollMs);
      }
      s.data.listening = up;
      if (!up) return fail(`Sunshine web UI did not start listening on ${SUNSHINE.webUiPort} within ${t.webUiWaitMs / 1000} s. See sunshine.log in diagnostics.`);
      const pem = env.readText(P.cert);
      if (!pem) return fail(`Sunshine certificate not found at ${P.cert}.`);
      let fp: string;
      try {
        fp = env.fingerprint(pem);
      } catch (e) {
        return fail(`Sunshine certificate unreadable: ${(e as Error).message}`);
      }
      s.data.certFingerprint256 = fp;
      s.data.cert = certSummary(pem);
      const tls = await env.tlsPinCheck('127.0.0.1', SUNSHINE.webUiPort, pem, 5000);
      s.data.tls = tls;
      if (!tls.ok) return fail(`The web API serves a different certificate than ${P.cert}: ${tls.error}`);
      if (env.readText(P.pinnedCert) !== pem) env.copyFile(P.cert, P.pinnedCert);
      s.data.pinnedCopy = P.pinnedCert;
      return { status: 'pass', message: `Pinned Sunshine certificate ${fp.slice(0, 23)}… (copy at ${P.pinnedCert}).` };
    },
  );

  async function apiAuth(ctx: HostStepContext, s: StepScratch, forApply: boolean): Promise<StepOutcome> {
    const P = paths(ctx);
    const pem = env.readText(P.pinnedCert) ?? env.readText(P.cert);
    if (!pem) return fail('No pinned Sunshine certificate yet (the web API step must pass first).');
    const pw = await env.getPassword();
    if (!pw) return fail('No stored Sunshine admin password. Press "Set up this Mac".');
    const client = env.createSunshineClient({
      baseUrl: `https://127.0.0.1:${SUNSHINE.webUiPort}`,
      username: LANPLAY.sunshineAdminUser,
      getPassword: async () => pw,
      pinnedCertPem: pem,
      timeoutMs: 10_000,
      onCall: (r) => ctx.log.rest(r),
    });
    const retries = forApply ? t.apiRetries : 0;
    let clients;
    for (let attempt = 0; ; attempt++) {
      try {
        clients = await client.listClients();
        break;
      } catch (e) {
        const kind = e instanceof SunshineApiError ? e.kind : 'unknown';
        // Right after a restart the port can accept before the API is ready: retry only those cases.
        if (attempt < retries && (kind === 'network' || kind === 'timeout')) {
          s.data.retries = attempt + 1;
          await env.sleep(t.apiRetryMs);
          continue;
        }
        s.data.errorKind = kind;
        // The stored login no longer works, so the next setup must write it again instead of trusting its own record.
        if (forApply && kind === 'auth') env.settings.set(CREDENTIALS_STAMP_KEY, '');
        return fail(explainApiError(e));
      }
    }
    s.data.pairedClients = clients.length;
    try {
      s.data.sunshineVersion = await client.getVersion();
      if (ctx.install && typeof s.data.sunshineVersion === 'string') ctx.install.version = s.data.sunshineVersion;
    } catch {
      /* the version is informational */
    }
    return { status: 'pass', message: `Logged in to Sunshine's API (${clients.length} paired device(s)).` };
  }
  const apiAuthStep = mk('api-auth', (ctx, s) => apiAuth(ctx, s, false), (ctx, s) => apiAuth(ctx, s, true));

  const input = mk('mac-input', async (ctx) => inputOutcome(ctx));

  const audio = mk('mac-audio', async () => ({
    status: 'pass',
    message: 'The first stream makes macOS ask whether Sunshine may record system audio. Choose Allow. It asks about the microphone only if the other device sends one.',
  }));

  const network = mk('mac-network', async (ctx, s) => {
    const r = await exec(ctx, s, firewallStateArgv(), 15_000);
    if (r.spawnError || r.exitCode !== 0) return { status: 'skip', message: 'Could not read the macOS firewall state.' };
    const state = parseFirewallState(r.stdout);
    const allow = 'Choose Allow when macOS asks whether Sunshine and LanPlay may accept incoming connections';
    switch (state) {
      case 'off':
        return { status: 'pass', message: 'The macOS firewall is off. macOS may still ask once for Local Network access for Sunshine and LanPlay: choose Allow.' };
      case 'on':
        return { status: 'warn', message: `The macOS firewall is on. ${allow}; without it other devices cannot reach this Mac.`, data: { settingsPane: 'firewall' } };
      case 'block-all':
        return { status: 'warn', message: 'The macOS firewall blocks all incoming connections, so no other device can reach Sunshine. Turn that option off in Firewall options.', data: { settingsPane: 'firewall' } };
      default:
        return { status: 'skip', message: 'Could not read the macOS firewall state.' };
    }
  });

  const autostart = mk(
    'agent-autostart',
    async () => {
      const have = env.readText(agentPlist());
      if (have === null) return fail('LanPlay is not set to start its pair agent at login.');
      return have === agentPlistText() ? { status: 'pass', message: 'LanPlay starts the pair agent at login.' } : fail('The login launch agent points at another LanPlay (was LanPlay moved?). Press "Set up / Repair".');
    },
    async (_ctx, s) => {
      const plist = agentPlist();
      s.data.plist = plist;
      if (env.readText(plist) !== agentPlistText()) {
        env.mkdirp(posix.dirname(plist));
        // Written, not loaded: loading starts `LanPlay --agent` right now, next to the LanPlay that is running. launchd loads it at the next login.
        env.writeText(plist, agentPlistText());
      }
      return { status: 'pass', message: 'LanPlay will start the pair agent at login.' };
    },
  );

  const listening = mk('agent-listening', async (_ctx, s) => {
    if (!env.agentProbe) return { status: 'skip', message: 'Checked by the LanPlay app.' };
    const r = await env.agentProbe();
    s.data.agent = r;
    if (r.http && r.udp) return { status: 'pass', message: `Pair agent answers on TCP and UDP ${LANPLAY.agentPort}.` };
    if (r.http) return { status: 'warn', message: `Pair agent answers on TCP but not UDP discovery (${r.detail}). Other devices can still add this Mac by IP.` };
    return fail(`Pair agent does not answer on 127.0.0.1:${LANPLAY.agentPort}: ${r.detail}`);
  });

  return [bundle, install, config, credentials, launchAgent, screen, webUi, apiAuthStep, input, audio, network, autostart, listening];
}
