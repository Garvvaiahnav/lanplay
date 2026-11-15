// Pure logic for the Sunshine.app that LanPlay bundles and runs from a private copy on macOS (docs/MAC-HOST-DESIGN.md 2.4).
// Disk and processes are injected, so everything here is testable without a Mac.
import path from 'node:path';
import { SUNSHINE_MANAGED_CONFIG, SUNSHINE_MAC } from '../../../contracts.js';
import type { ProcessRunner } from '../../../contracts.js';
import type { AgentSpec, ArgvCall } from './launchd.js';

const p = path.posix;

export interface SunshineMacPaths {
  /** <sharedData>/sunshine */
  dir: string;
  app: string;
  /** Where a new copy is made and verified before it replaces `app`. */
  staging: string;
  binary: string;
  conf: string;
  /** Serves as both `file_state` and `credentials_file`. */
  state: string;
  credentialsDir: string;
  pkey: string;
  cert: string;
  apps: string;
  installedJson: string;
  /** Sunshine's own `log_path`. */
  log: string;
  /** stdout/stderr of the launchd job (crashes before Sunshine opens its log land here). */
  launchdLog: string;
  /** Copy of the cert LanPlay pins, same file name as on Windows. */
  pinnedCert: string;
}

/**
 * Everything lives under LanPlay's own folders: the user's ~/.config/sunshine is never read or written, so a Sunshine
 * they run by hand keeps its own pairings. `logDir` is ~/Library/Logs/LanPlay.
 */
export function sunshinePaths(sharedData: string, logDir: string): SunshineMacPaths {
  const dir = p.join(sharedData, 'sunshine');
  const app = p.join(dir, SUNSHINE_MAC.appName);
  const credentialsDir = p.join(dir, 'credentials');
  return {
    dir,
    app,
    staging: p.join(dir, 'staging', SUNSHINE_MAC.appName),
    binary: p.join(app, SUNSHINE_MAC.binaryRelative),
    conf: p.join(dir, 'sunshine.conf'),
    state: p.join(dir, 'sunshine_state.json'),
    credentialsDir,
    pkey: p.join(credentialsDir, 'cakey.pem'),
    cert: p.join(credentialsDir, 'cacert.pem'),
    apps: p.join(dir, 'apps.json'),
    installedJson: p.join(dir, 'installed.json'),
    log: p.join(logDir, 'sunshine.log'),
    launchdLog: p.join(logDir, 'sunshine-launchd.log'),
    pinnedCert: p.join(sharedData, 'sunshine-cert.pem'),
  };
}

/** `resourcesPath` is process.resourcesPath, i.e. LanPlay.app/Contents/Resources (scripts/after-pack.cjs puts the app there). */
export function bundledSunshineApp(resourcesPath: string): string {
  return p.join(resourcesPath, 'vendor', SUNSHINE_MAC.appName);
}

/**
 * Keys LanPlay owns in sunshine.conf on macOS. The paths are absolute because Sunshine resolves relative ones under
 * ~/.config/sunshine; system_tray is off because LanPlay is the UI.
 */
export function macManagedConfig(paths: SunshineMacPaths): Record<string, string> {
  return {
    ...SUNSHINE_MANAGED_CONFIG,
    pkey: paths.pkey,
    cert: paths.cert,
    log_path: paths.log,
    file_state: paths.state,
    credentials_file: paths.state,
    file_apps: paths.apps,
    system_tray: 'disabled',
  };
}

/** The job the copy runs as. argv[1] is the private config, which stops Sunshine from reading ~/.config/sunshine. */
export function sunshineAgentSpec(paths: SunshineMacPaths): AgentSpec {
  return {
    label: SUNSHINE_MAC.launchdLabel,
    program: paths.binary,
    args: [paths.conf],
    keepAlive: true,
    stdoutPath: paths.launchdLog,
    stderrPath: paths.launchdLog,
  };
}

/** ditto keeps resource forks, xattrs and the code signature intact; cp -R can lose them. It merges into an existing folder, so `to` must not exist. */
export function dittoArgv(from: string, to: string): ArgvCall {
  return { file: '/usr/bin/ditto', args: [from, to] };
}

const CODESIGN = '/usr/bin/codesign';

/** Fails (exit 1) when any file inside the bundle was added, changed or removed since signing. */
export function verifySignatureArgv(app: string): ArgvCall {
  return { file: CODESIGN, args: ['--verify', '--deep', '--strict', app] };
}

/** Prints the details on stderr, not stdout. */
export function describeSignatureArgv(app: string): ArgvCall {
  return { file: CODESIGN, args: ['-dvv', app] };
}

export interface CodesignDetails {
  identifier: string | null;
  /** null for ad-hoc and unsigned code (codesign prints "not set"). */
  teamId: string | null;
  authorities: string[];
}

export function parseCodesignDetails(output: string): CodesignDetails {
  let identifier: string | null = null;
  let teamId: string | null = null;
  const authorities: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'Identifier' && identifier === null) identifier = value;
    else if (key === 'TeamIdentifier' && teamId === null) teamId = value === 'not set' ? null : value;
    else if (key === 'Authority') authorities.push(value);
  }
  return { identifier, teamId, authorities };
}

export type SignatureVerdict = { ok: true; teamId: string } | { ok: false; reason: string };

const CODESIGN_TIMEOUT_MS = 60_000; // --deep over the ~150 MB bundle on a cold disk

/** Valid seal, signed by `teamId`, and Sunshine itself: a seal check alone would accept anyone's signature, ad-hoc included. */
export async function verifySunshineSignature(runner: ProcessRunner, app: string, teamId: string): Promise<SignatureVerdict> {
  const verify = verifySignatureArgv(app);
  const v = await runner.run({ file: verify.file, args: verify.args, timeoutMs: CODESIGN_TIMEOUT_MS });
  if (v.spawnError) return { ok: false, reason: `codesign could not run: ${v.spawnError}` };
  if (v.exitCode !== 0) return { ok: false, reason: `codesign --verify failed: ${v.stderr.trim() || `exit ${v.exitCode}`}` };
  const describe = describeSignatureArgv(app);
  const d = await runner.run({ file: describe.file, args: describe.args, timeoutMs: CODESIGN_TIMEOUT_MS });
  if (d.spawnError) return { ok: false, reason: `codesign could not run: ${d.spawnError}` };
  const details = parseCodesignDetails(d.stderr);
  const found = details.teamId;
  if (found !== teamId) return { ok: false, reason: `signed by team ${found ?? '(none)'}, expected ${teamId}` };
  if (details.identifier !== SUNSHINE_MAC.bundleId) return { ok: false, reason: `the bundle is ${details.identifier ?? '(no identifier)'}, expected ${SUNSHINE_MAC.bundleId}` };
  return { ok: true, teamId: found };
}

/** `<dir>/installed.json`: what the copy on disk was made from. */
export interface InstalledSunshine {
  version: string;
  dmgSha256: string;
  teamId: string;
  copiedAt: string;
}

export function installedJsonText(info: InstalledSunshine): string {
  return JSON.stringify(info, null, 2) + '\n';
}

export function parseInstalledJson(text: string): InstalledSunshine | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== 'string' || typeof o.dmgSha256 !== 'string' || typeof o.teamId !== 'string' || typeof o.copiedAt !== 'string') return null;
  return { version: o.version, dmgSha256: o.dmgSha256, teamId: o.teamId, copiedAt: o.copiedAt };
}

export interface InstallFs {
  exists(file: string): boolean;
  readText(file: string): Promise<string>;
}

export interface InstallPlan {
  needsCopy: boolean;
  reason: 'absent' | 'no-metadata' | 'version-changed' | 'signature-invalid' | 'current';
}

/**
 * Decides whether Sunshine.app must be (re)copied from the bundle. Cheap checks first; codesign (slow) only runs for a
 * copy that otherwise looks current. A different version or dmg digest means LanPlay shipped a new Sunshine.
 */
export async function planSunshineInstall(
  deps: { fs: InstallFs; runner: ProcessRunner },
  paths: SunshineMacPaths,
  want: { version: string; dmgSha256: string; teamId: string },
): Promise<InstallPlan> {
  if (!deps.fs.exists(paths.app)) return { needsCopy: true, reason: 'absent' };
  let installed: InstalledSunshine | null = null;
  try {
    installed = parseInstalledJson(await deps.fs.readText(paths.installedJson));
  } catch {
    // unreadable is treated like missing: without the record there is no telling what the copy is
  }
  if (!installed) return { needsCopy: true, reason: 'no-metadata' };
  if (installed.version !== want.version || installed.dmgSha256 !== want.dmgSha256) return { needsCopy: true, reason: 'version-changed' };
  const sig = await verifySunshineSignature(deps.runner, paths.app, want.teamId);
  return sig.ok ? { needsCopy: false, reason: 'current' } : { needsCopy: true, reason: 'signature-invalid' };
}
