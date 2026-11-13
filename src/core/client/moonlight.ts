// MoonlightRunner: argv builders + spawning the bundled moonlight-qt. argv arrays only, never a shell.
// Flags: https://github.com/moonlight-stream/moonlight-qt/blob/v6.2.0/app/cli/commandlineparser.cpp#L260-L373
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { MOONLIGHT } from '../../contracts.js';
import type { CreateMoonlightRunner, ExecResult, MoonlightProcessHandle, MoonlightRunner, MoonlightRunnerOptions, MoonlightStreamArgsInput, ResolvedCodec } from '../../contracts.js';
import { tail } from '../shared/exec.js';

const F = MOONLIGHT.streamFlags;

/** --video-codec values are case-sensitive keys of m_VideoCodecMap (commandlineparser.cpp#L308-L313). */
export const CODEC_FLAG_VALUE: Record<ResolvedCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };

/** Host argument must be an IP literal: a leading "-" would be read as an option. */
export function assertHostArg(host: string): string {
  const h = String(host ?? '').trim();
  if (!net.isIP(h)) throw new Error(`Moonlight host must be an IP address, got "${h}"`);
  return h;
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
  ];
}

export function buildPairArgs(host: string, pin: string): string[] {
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be 4 digits');
  return ['pair', assertHostArg(host), MOONLIGHT.pairPinFlag, pin];
}

export function buildListArgs(host: string): string[] {
  return ['list', assertHostArg(host)];
}

/** Bundled first (packaged: resources/vendor/Moonlight.app; dev: vendor/moonlight-macos/Moonlight.app), then /Applications. */
export function moonlightCandidates(vendorDir: string, devVendorDir: string | null): string[] {
  const list = [path.join(vendorDir, MOONLIGHT.macBundleBinary)];
  if (devVendorDir) list.push(path.join(devVendorDir, 'moonlight-macos', MOONLIGHT.macBundleBinary));
  list.push(path.join('/Applications', MOONLIGHT.macBundleBinary));
  return list;
}

function spawnHandle(o: MoonlightRunnerOptions, argv: string[]): MoonlightProcessHandle {
  const full = [...o.prefixArgs, ...argv];
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  const child = spawn(o.binary, full, {
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
  return {
    pid: child.pid,
    argv: o.log.redactor.redactArgv(argv),
    exited,
    async terminate(graceMs: number) {
      if (finished) return;
      child.kill('SIGTERM');
      const t = setTimeout(() => {
        if (!finished) child.kill('SIGKILL');
      }, graceMs);
      await exited;
      clearTimeout(t);
    },
  };
}

export const createMoonlightRunner: CreateMoonlightRunner = (o) => {
  const runner: MoonlightRunner = {
    binaryPath: () => o.binary,
    buildStreamArgs,
    buildPairArgs,
    buildListArgs,
    startPair(host, pin) {
      o.log.redactor.addSecret(pin);
      const argv = buildPairArgs(host, pin);
      o.log.log('info', 'moonlight', 'starting pair', { argv: o.log.redactor.redactArgv(argv) });
      return spawnHandle(o, argv);
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
      return spawnHandle(o, argv);
    },
  };
  return runner;
};
