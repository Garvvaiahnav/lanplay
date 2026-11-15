// Pure helpers for the two per-user LaunchAgents LanPlay installs on macOS (plist text, launchctl argv, `launchctl print`
// parsing). Nothing here touches the disk or spawns a process; callers run the argv through a ProcessRunner.
import path from 'node:path';
import { SUNSHINE_MAC } from '../../../contracts.js';

export interface AgentSpec {
  label: string;
  program: string;
  args: string[];
  /** true = launchd restarts the job whenever it exits (Sunshine). false = started at login only (LanPlay's agent). */
  keepAlive: boolean;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface ArgvCall {
  file: string;
  args: string[];
}

export interface LaunchctlJob {
  loaded: boolean;
  /** `state = ...` of the job itself ("running", "not running", "spawn scheduled"); null when not loaded. */
  state: string | null;
  pid: number | null;
  /** `last exit code`; null while the job never exited or when launchd reports a signal instead. */
  lastExitCode: number | null;
  /** `last terminating signal`, e.g. "Segmentation fault: 11". */
  lastSignal: string | null;
}

const LAUNCHCTL = '/bin/launchctl';

/** The LanPlay --agent job. No KeepAlive: the auto-updater has to be able to quit it while it swaps LanPlay.app. */
export function lanplayAgentSpec(lanplayExe: string): AgentSpec {
  return { label: SUNSHINE_MAC.agentLaunchdLabel, program: lanplayExe, args: ['--agent'], keepAlive: false };
}

// Only the three characters that can end a text node. Quotes are legal inside <string>.
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Sunshine's profile (keepAlive) also gets ThrottleInterval and ProcessType Interactive: a crash loop must not spin, and
 * a screen-capture process must not be demoted to background QoS. Aqua keeps both jobs out of SSH and login-window
 * sessions, where there is no screen to capture.
 */
export function buildAgentPlist(s: AgentSpec): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${esc(s.label)}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...[s.program, ...s.args].map((a) => `\t\t<string>${esc(a)}</string>`),
    '\t</array>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
  ];
  if (s.keepAlive) out.push('\t<key>KeepAlive</key>', '\t<true/>', '\t<key>ThrottleInterval</key>', '\t<integer>10</integer>');
  out.push('\t<key>LimitLoadToSessionType</key>', '\t<string>Aqua</string>');
  if (s.keepAlive) out.push('\t<key>ProcessType</key>', '\t<string>Interactive</string>');
  if (s.stdoutPath) out.push('\t<key>StandardOutPath</key>', `\t<string>${esc(s.stdoutPath)}</string>`);
  if (s.stderrPath) out.push('\t<key>StandardErrorPath</key>', `\t<string>${esc(s.stderrPath)}</string>`);
  out.push('</dict>', '</plist>', '');
  return out.join('\n');
}

export function plistPath(home: string, label: string): string {
  return path.posix.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

function domain(uid: number): string {
  if (!Number.isInteger(uid) || uid < 0) throw new Error(`invalid uid: ${uid}`);
  return `gui/${uid}`;
}

export function bootstrapArgv(uid: number, plist: string): ArgvCall {
  return { file: LAUNCHCTL, args: ['bootstrap', domain(uid), plist] };
}

export function bootoutArgv(uid: number, label: string): ArgvCall {
  return { file: LAUNCHCTL, args: ['bootout', `${domain(uid)}/${label}`] };
}

/** kill=true is `kickstart -k`: stop the running instance first, so the job restarts even if it is alive. */
export function kickstartArgv(uid: number, label: string, kill: boolean): ArgvCall {
  return { file: LAUNCHCTL, args: ['kickstart', ...(kill ? ['-k'] : []), `${domain(uid)}/${label}`] };
}

export function printArgv(uid: number, label: string): ArgvCall {
  return { file: LAUNCHCTL, args: ['print', `${domain(uid)}/${label}`] };
}

/**
 * `launchctl print gui/<uid>/<label>` prints one tab-indented block; a missing job prints nothing on stdout (the
 * "Could not find service" text goes to stderr, exit 113). Keys of the job itself sit one tab deep. Nested blocks such as
 * `endpoints = {` carry their own `state` and `pid`, so deeper lines must be ignored.
 */
export function parseLaunchctlPrint(stdout: string): LaunchctlJob {
  const top = new Map<string, string>();
  let header = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^\S.* = \{$/.test(line)) header = true;
    const m = /^\t([^\t].*?) = (.*)$/.exec(line);
    if (m && !top.has(m[1]!)) top.set(m[1]!, m[2]!);
  }
  if (!header) return { loaded: false, state: null, pid: null, lastExitCode: null, lastSignal: null };
  const pid = top.get('pid');
  const code = top.get('last exit code');
  return {
    loaded: true,
    state: top.get('state') ?? null,
    pid: pid !== undefined && /^\d+$/.test(pid) ? Number(pid) : null,
    lastExitCode: code !== undefined && /^-?\d+$/.test(code) ? Number(code) : null,
    lastSignal: top.get('last terminating signal') ?? null,
  };
}
