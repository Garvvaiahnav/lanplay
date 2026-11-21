// MoonlightRunner: argv builders + spawning the bundled moonlight-qt. argv arrays only, never a shell.
// Flags: https://github.com/moonlight-stream/moonlight-qt/blob/v6.2.0/app/cli/commandlineparser.cpp#L260-L373
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { MOONLIGHT, SUNSHINE } from '../../contracts.js';
import { MOONLIGHT_WIN } from './platform.js';
import type { CreateMoonlightRunner, ExecResult, HostInfo, MoonlightProcessHandle, MoonlightRunner, MoonlightRunnerOptions, MoonlightStreamArgsInput, ResolvedCodec } from '../../contracts.js';
import { tail } from '../shared/exec.js';

const F = MOONLIGHT.streamFlags;

/** --video-codec values are case-sensitive keys of m_VideoCodecMap (commandlineparser.cpp#L308-L313). */
export const CODEC_FLAG_VALUE: Record<ResolvedCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };

/**
 * Host argument: an IP literal, optionally with a port ("1.2.3.4:47989", "[2001:db8::1]:47989"). Names and anything that could
 * be read as an option are refused. D11: bundled Moonlight 6.2.0 accepts ip:port for list, pair and stream (checked against a
 * local fake Sunshine on a non-default port), so a port is passed through.
 */
export function assertHostArg(host: string): string {
  const h = String(host ?? '').trim();
  if (net.isIP(h)) return h;
  const v4 = /^([0-9.]+):(\d{1,5})$/.exec(h);
  if (v4 && net.isIPv4(v4[1]!) && validPort(v4[2]!)) return h;
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(h);
  if (v6 && net.isIPv6(v6[1]!) && validPort(v6[2]!)) return h;
  throw new Error(`Moonlight host must be an IP address (optionally with :port), got "${h}"`);
}

function validPort(p: string): boolean {
  const n = Number(p);
  return n >= 1 && n <= 65535;
}

/** What to hand Moonlight for a host: the plain address, plus the port only for an internet host on a non-default port. */
export function moonlightTarget(host: Pick<HostInfo, 'preferredAddress' | 'httpPort' | 'remote'>): string {
  const ip = host.preferredAddress;
  if (!host.remote || !host.httpPort || host.httpPort === SUNSHINE.httpPort) return ip;
  return net.isIPv6(ip) ? `[${ip}]:${host.httpPort}` : `${ip}:${host.httpPort}`;
}

export function buildStreamArgs(input: MoonlightStreamArgsInput): string[] {
  const s = input.settings;
  const host = assertHostArg(input.host);
  if (!s.appName || s.appName.startsWith('-')) throw new Error('invalid app name');
  const res = s.resolution === '4k' ? F.res4k : s.resolution === '1440p' ? F.res1440 : F.res1080;
  const kbps = Math.round(s.bitrateMbps * 1000);
  if (kbps < MOONLIGHT.bitrateKbpsRange[0] || kbps > MOONLIGHT.bitrateKbpsRange[1]) throw new Error(`bitrate ${kbps} Kbps outside Moonlight's range`);
  if (s.fps < MOONLIGHT.fpsRange[0] || s.fps > MOONLIGHT.fpsRange[1]) throw new Error(`fps ${s.fps} outside Moonlight's range`);
  return [
    'stream',
    host,
    s.appName,
    res,
    F.fps,
    String(s.fps),
    F.bitrateKbps,
    String(kbps),
    F.videoCodec,
    CODEC_FLAG_VALUE[input.resolvedCodec],
    F.audioConfig,
    'stereo',
    F.displayMode,
    s.displayMode,
    s.vsync ? F.vsync : F.noVsync,
    s.framePacing ? F.framePacing : F.noFramePacing,
    // Windows key, Alt+Tab etc. go to the streamed PC, not the viewer. "always" so it also holds in borderless/windowed.
    // Ctrl+Alt+Shift+Q (quit) and Ctrl+Alt+Shift+Z (ungrab) stay handled inside Moonlight.
    F.captureSystemKeys,
    'always',
  ];
}

export function buildPairArgs(host: string, pin: string): string[] {
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be 4 digits');
  return ['pair', assertHostArg(host), MOONLIGHT.pairPinFlag, pin];
}

export function buildListArgs(host: string): string[] {
  return ['list', assertHostArg(host)];
}

/**
 * Moonlight binary candidates, first existing wins.
 * darwin: bundled Moonlight.app (packaged: resources/vendor; dev: vendor/moonlight-macos), then /Applications.
 * win32:  <vendorDir>/moonlight-windows/Moonlight.exe (bundled), then the installed
 *         C:\Program Files\Moonlight Game Streaming\Moonlight.exe, then the portable dev vendor path
 *         <repo>/vendor/moonlight-windows/Moonlight.exe.
 */
export function moonlightCandidates(vendorDir: string, devVendorDir: string | null, platform: NodeJS.Platform = process.platform, env: Readonly<Record<string, string | undefined>> = {}): string[] {
  if (platform === 'win32') {
    const w = path.win32;
    const list = [w.join(vendorDir, MOONLIGHT_WIN.bundledDirName, MOONLIGHT_WIN.exeName)];
    const installed: string[] = [MOONLIGHT_WIN.installedDefault];
    for (const root of [env.ProgramW6432, env.ProgramFiles]) if (root) installed.push(w.join(root, MOONLIGHT_WIN.installedRelative));
    for (const p of installed) if (!list.some((x) => x.toLowerCase() === p.toLowerCase())) list.push(p);
    if (devVendorDir) list.push(w.join(devVendorDir, MOONLIGHT_WIN.bundledDirName, MOONLIGHT_WIN.exeName));
    return list;
  }
  const list = [path.join(vendorDir, MOONLIGHT.macBundleBinary)];
  if (devVendorDir) list.push(path.join(devVendorDir, 'moonlight-macos', MOONLIGHT.macBundleBinary));
  list.push(path.join('/Applications', MOONLIGHT.macBundleBinary));
  return list;
}

/** Test seams for spawnHandle / terminate. Production uses the defaults. */
export interface MoonlightPlatformOptions {
  platform?: NodeJS.Platform;
  /** Tests: fake child_process.spawn. */
  spawnFn?: typeof spawn;
  /** Tests: record the taskkill argv instead of running it. Resolves when taskkill is done. */
  taskkill?: (file: string, args: string[]) => Promise<void>;
  env?: Readonly<Record<string, string | undefined>>;
  /** After taskkill, how long terminate() still waits for the process to be reaped before giving up (default 3000). */
  killWaitMs?: number;
}

/** Absolute taskkill.exe (never resolved through PATH). */
export function taskkillPath(env: Readonly<Record<string, string | undefined>>): string {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
}

/** argv for killing a process tree: taskkill /PID <pid> /T /F (T = children too, F = force). */
export function taskkillArgs(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`);
  return ['/PID', String(pid), '/T', '/F'];
}

function defaultTaskkill(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    // UNTESTED-ON-WINDOWS: real taskkill.exe. execFile = argv array, no shell; errors (already gone) are not fatal.
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, () => resolve());
  });
}

export function spawnHandle(o: MoonlightRunnerOptions, argv: string[], p: MoonlightPlatformOptions = {}): MoonlightProcessHandle {
  const platform = p.platform ?? process.platform;
  const spawnFn = p.spawnFn ?? spawn;
  const full = [...o.prefixArgs, ...argv];
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  const child = spawnFn(o.binary, full, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: o.env ? { ...process.env, ...o.env } : process.env,
  });
  child.stdout?.on('data', (c: Buffer) => {
    stdout = tail(stdout + c.toString('utf8'), 64 * 1024);
  });
  child.stderr?.on('data', (c: Buffer) => {
    stderr = tail(stderr + c.toString('utf8'), 64 * 1024);
  });
  const exited = new Promise<ExecResult>((resolve) => {
    let done = false;
    child.once('error', (e) => {
      if (done) return;
      done = true;
      resolve({ exitCode: null, signal: null, stdout, stderr, durationMs: Date.now() - started, timedOut: false, spawnError: e.message });
    });
    child.once('close', (code, signal) => {
      if (done) return;
      done = true;
      resolve({ exitCode: code, signal: signal ?? null, stdout, stderr, durationMs: Date.now() - started, timedOut: false });
    });
  });
  let finished = false;
  void exited.then(() => {
    finished = true;
  });
  const pid = child.pid;
  return {
    pid,
    argv: o.log.redactor.redactArgv(argv),
    exited,
    async terminate(graceMs: number) {
      if (finished) return;
      child.kill('SIGTERM');
      // Windows: kill() is TerminateProcess on the main process only; child processes (and their inherited stdio pipes,
      // which hold 'close' back) can survive. After the grace period kill the whole tree: taskkill /PID <pid> /T /F.
      let forced: Promise<void> | null = null;
      const t = setTimeout(() => {
        if (finished) return;
        if (platform === 'win32' && pid !== undefined) {
          // UNTESTED-ON-WINDOWS (argv + ordering are unit-tested with an injected taskkill).
          forced = (p.taskkill ?? defaultTaskkill)(taskkillPath(p.env ?? process.env), taskkillArgs(pid));
        } else child.kill('SIGKILL');
      }, graceMs);
      if (platform !== 'win32') {
        await exited;
        clearTimeout(t);
        return;
      }
      // Never hang the UI on Windows: give up waiting killWaitMs after taskkill ran.
      const afterKill = new Promise<void>((r) => setTimeout(r, graceMs + 10))
        .then(() => forced ?? undefined)
        .then(() => (finished ? undefined : new Promise<void>((r) => setTimeout(r, p.killWaitMs ?? 3000))));
      await Promise.race([exited.then(() => undefined), afterKill]);
      clearTimeout(t);
    },
  };
}

export function createMoonlightRunnerWith(o: MoonlightRunnerOptions, p: MoonlightPlatformOptions = {}): MoonlightRunner {
  const runner: MoonlightRunner = {
    binaryPath: () => o.binary,
    buildStreamArgs,
    buildPairArgs,
    buildListArgs,
    startPair(host, pin) {
      o.log.redactor.addSecret(pin);
      const argv = buildPairArgs(host, pin);
      o.log.log('info', 'moonlight', 'starting pair', { argv: o.log.redactor.redactArgv(argv) });
      return spawnHandle(o, argv, p);
    },
    async isPaired(host, timeoutMs) {
      const argv = buildListArgs(host);
      const req: Parameters<typeof o.runner.run>[0] = { file: o.binary, args: [...o.prefixArgs, ...argv], timeoutMs };
      if (o.env) (req as { env?: Readonly<Record<string, string>> }).env = o.env;
      const result = await o.runner.run(req);
      o.log.log('debug', 'moonlight', 'list', { host, exitCode: result.exitCode, stderr: tail(result.stderr, 500) });
      return { paired: result.exitCode === MOONLIGHT.listExitOk, result };
    },
    startStream(input) {
      const argv = buildStreamArgs(input);
      o.log.log('info', 'moonlight', 'starting stream', { argv });
      return spawnHandle(o, argv, p);
    },
  };
  return runner;
}

export const createMoonlightRunner: CreateMoonlightRunner = (o) => createMoonlightRunnerWith(o);
