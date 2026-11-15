// Host-only diagnostics files on macOS (docs/MAC-HOST-DESIGN.md 2.11). Same shape as ../diagnostics-host.ts so the
// wiring can pick one per platform. Disk and processes are injected; nothing here reads the real machine on its own.
import { LANPLAY, SUNSHINE_MAC } from '../../../contracts.js';
import type { AppPaths, ExecResult, ProcessRunner, Redactor, StepRecord, SunshineClient } from '../../../contracts.js';
import type { DiagFile } from '../../diagnostics.js';
import { REDACTED } from '../../shared/redact.js';
import { parseLaunchctlPrint, plistPath, printArgv } from './launchd.js';
import type { ArgvCall } from './launchd.js';
import { describeSignatureArgv, parseCodesignDetails, parseInstalledJson, sunshinePaths } from './sunshine-mac.js';

export interface HostDiagFsMac {
  exists(file: string): boolean;
  /** Last `maxBytes` of a text file; null when it is missing or unreadable. */
  readTail(file: string, maxBytes: number): string | null;
}

export interface HostDiagMacDeps {
  runner: ProcessRunner;
  redactor: Redactor;
  paths: AppPaths;
  fs: HostDiagFsMac;
  sunshine: SunshineClient;
  /** For ~/Library/LaunchAgents. */
  home: string;
  uid: number;
}

const SOCKETFILTERFW = '/usr/libexec/ApplicationFirewall/socketfilterfw';
const LSOF = '/usr/sbin/lsof';
const QUICK_MS = 10_000;
const TAIL_OF_COMMAND = 4096;

// Sunshine keeps the account in its state file, not in sunshine.conf, but nothing stops a user from adding a
// `sunshine_password` line by hand; the redactor only knows values it has been told about.
const SECRET_CONF_KEY = /pass|secret|token|salt|(^|_)pin($|_)/i;

/** Keeps the conf readable for support while dropping the value of any credential-looking key. */
export function maskSunshineConf(text: string): string {
  return text.replace(/^[ \t]*([A-Za-z0-9_]+)[ \t]*=.*$/gm, (line, key: string) => (SECRET_CONF_KEY.test(key) ? `${key} = ${REDACTED}` : line));
}

async function runLogged(d: Pick<HostDiagMacDeps, 'runner' | 'redactor'>, cmds: StepRecord['commands'], call: ArgvCall, timeoutMs: number): Promise<ExecResult> {
  const res = await d.runner.run({ file: call.file, args: call.args, timeoutMs });
  cmds.push({
    file: call.file,
    argv: d.redactor.redactArgv(call.args),
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    stdoutTail: d.redactor.redact(res.stdout.slice(-TAIL_OF_COMMAND)),
    stderrTail: d.redactor.redact(res.stderr.slice(-TAIL_OF_COMMAND)),
    timedOut: res.timedOut,
    ...(res.spawnError ? { spawnError: res.spawnError } : {}),
  });
  return res;
}

function failure(res: ExecResult): string | undefined {
  if (res.spawnError) return res.spawnError;
  if (res.timedOut) return 'timed out';
  return res.exitCode === 0 ? undefined : res.stderr.trim() || `exit ${res.exitCode}`;
}

export async function hostDiagnosticsFilesMac(d: HostDiagMacDeps): Promise<DiagFile[]> {
  const sp = sunshinePaths(d.paths.sharedData, d.paths.logDir);
  const max = LANPLAY.diagnosticsTailBytes;
  const cmds: StepRecord['commands'] = [];
  const files: DiagFile[] = [];

  const installedText = d.fs.readTail(sp.installedJson, max);
  const installed = installedText === null ? null : parseInstalledJson(installedText);
  const rawConf = d.fs.readTail(sp.conf, max);

  // A job that is not loaded prints nothing on stdout and fails with 113; both facts are worth keeping.
  const launchd: Record<string, unknown> = {};
  for (const label of [SUNSHINE_MAC.launchdLabel, SUNSHINE_MAC.agentLaunchdLabel]) {
    const r = await runLogged(d, cmds, printArgv(d.uid, label), QUICK_MS);
    launchd[label] = { job: parseLaunchctlPrint(r.stdout), exitCode: r.exitCode, raw: r.stdout, stderr: r.stderr.slice(-2000), error: failure(r) };
  }

  let codesign: unknown = null;
  if (d.fs.exists(sp.app)) {
    // codesign describes on stderr.
    const r = await runLogged(d, cmds, describeSignatureArgv(sp.app), QUICK_MS);
    codesign = { ...parseCodesignDetails(r.stderr), error: failure(r) };
  }

  let apiVersion: string | { error: string } = { error: 'not tried' };
  try {
    apiVersion = await d.sunshine.getVersion();
  } catch (e) {
    apiVersion = { error: (e as Error).message };
  }

  files.push({
    name: 'sunshine.json',
    text: JSON.stringify(
      {
        installed,
        ...(installedText !== null && installed === null ? { installedUnparsed: installedText } : {}),
        appPresent: d.fs.exists(sp.app),
        sunshineConf: rawConf === null ? null : maskSunshineConf(rawConf),
        launchd,
        codesign,
        pinnedCertPresent: d.fs.exists(sp.pinnedCert),
        apiVersion,
      },
      null,
      2,
    ),
  });

  const fw = await runLogged(d, cmds, { file: SOCKETFILTERFW, args: ['--getglobalstate'] }, QUICK_MS);
  files.push({ name: 'firewall.json', text: JSON.stringify({ ok: failure(fw) === undefined, error: failure(fw), state: fw.stdout.trim() }, null, 2) });

  // sunshine.log: the file first (honouring a log_path set in the conf), the API when the file cannot be read.
  const confLog = rawConf === null ? null : /^\s*log_path\s*=\s*(.+?)\s*$/m.exec(rawConf)?.[1]?.replace(/^"|"$/g, '');
  const logFile = confLog?.startsWith('/') ? confLog : sp.log;
  let slog = d.fs.readTail(logFile, max);
  if (slog === null) {
    try {
      slog = `(via GET /api/logs)\n${await d.sunshine.getLogsTail(max)}`;
    } catch (e) {
      slog = `sunshine.log unavailable: ${(e as Error).message}`;
    }
  }
  files.push({ name: 'logs/sunshine.log', text: slog });

  // Whatever Sunshine wrote before it could open its own log (bad conf, missing permission) only exists here.
  const launchdLog = d.fs.readTail(sp.launchdLog, max);
  if (launchdLog !== null) files.push({ name: 'logs/sunshine-launchd.log', text: launchdLog });

  for (const label of [SUNSHINE_MAC.launchdLabel, SUNSHINE_MAC.agentLaunchdLabel]) {
    const plist = d.fs.readTail(plistPath(d.home, label), max);
    if (plist !== null) files.push({ name: `launchagents/${label}.plist`, text: plist });
  }

  files.push({ name: 'host-commands.json', text: JSON.stringify(cmds, null, 2) });
  // sunshine_state.json (password hash, paired client certs) and the credentials folder are deliberately never read.
  return files.map((f) => ({ name: f.name, text: d.redactor.redact(f.text) }));
}

export interface LsofListener {
  port: number;
  pid: number;
  command: string;
  address: string;
}

/** `lsof -F` prints one field per line: `p<pid>` and `c<command>` start a process, each `n<addr>:<port>` is one socket. */
export function parseLsofListeners(output: string, ports: readonly number[]): LsofListener[] {
  const out: LsofListener[] = [];
  let pid = 0;
  let command = '';
  for (const line of output.split(/\r?\n/)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      pid = Number(value);
      command = '';
    } else if (field === 'c') {
      command = value;
    } else if (field === 'n') {
      const i = value.lastIndexOf(':');
      const port = Number(value.slice(i + 1));
      if (i > 0 && ports.includes(port)) out.push({ port, pid, command, address: value.slice(0, i) });
    }
  }
  return out;
}

export async function hostListenersMac(d: Pick<HostDiagMacDeps, 'runner'>): Promise<unknown> {
  const r = await d.runner.run({ file: LSOF, args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], timeoutMs: 30_000 });
  // lsof exits 1 with no output at all when nothing is listening.
  const quietEmpty = r.exitCode === 1 && !r.stderr.trim() && !r.stdout.trim();
  const error = quietEmpty ? undefined : failure(r);
  return { ok: error === undefined, error, result: error === undefined ? parseLsofListeners(r.stdout, LANPLAY.listenPortsToCheck) : null };
}
