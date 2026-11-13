// ProcessRunner: execFile with an argv array, shell:false, windowsHide:true. Never a shell string.
import { execFile } from 'node:child_process';
import type { ExecRequest, ExecResult, ProcessRunner, Redactor, StepRecord } from '../../contracts.js';

export const TAIL_BYTES = 4096;

export function tail(text: string, maxBytes = TAIL_BYTES): string {
  if (!text) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Cut on a UTF-8 boundary: skip continuation bytes.
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return '…' + buf.subarray(start).toString('utf8');
}

export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly redactor?: Redactor) {}

  run(req: ExecRequest): Promise<ExecResult> {
    for (const s of req.secrets ?? []) this.redactor?.addSecret(s);
    const started = Date.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(
          req.file,
          [...req.args],
          {
            cwd: req.cwd,
            timeout: req.timeoutMs,
            windowsHide: true,
            shell: false,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            killSignal: 'SIGTERM',
            env: req.env ? { ...process.env, ...req.env } : process.env,
          },
          (err, stdout, stderr) => {
            const durationMs = Date.now() - started;
            const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number }) | null;
            if (!e) {
              resolve({ exitCode: 0, signal: null, stdout: String(stdout), stderr: String(stderr), durationMs, timedOut: false });
              return;
            }
            const timedOut = Boolean(e.killed) && durationMs >= req.timeoutMs - 50;
            if (typeof e.code === 'string' && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              resolve({ exitCode: null, signal: null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), durationMs, timedOut, spawnError: `${e.code}: ${e.message}` });
              return;
            }
            resolve({
              exitCode: typeof e.code === 'number' ? e.code : null,
              signal: e.signal ?? null,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              durationMs,
              timedOut,
            });
          },
        );
      } catch (err) {
        // execFile throws synchronously for invalid arguments (e.g. NUL bytes, EINVAL for .bat without shell).
        resolve({ exitCode: null, signal: null, stdout: '', stderr: '', durationMs: Date.now() - started, timedOut: false, spawnError: (err as Error).message });
        return;
      }
      child.stdin?.end();
    });
  }
}

/** Converts one process run into the redacted shape stored in StepRecord.commands. */
export function commandRecord(req: ExecRequest, res: ExecResult, redactor: Redactor): StepRecord['commands'][number] {
  for (const s of req.secrets ?? []) redactor.addSecret(s);
  const rec: StepRecord['commands'][number] = {
    file: redactor.redact(req.file),
    argv: redactor.redactArgv(req.args),
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    stdoutTail: redactor.redact(tail(res.stdout)),
    stderrTail: redactor.redact(tail(res.stderr)),
    timedOut: res.timedOut,
  };
  if (res.spawnError !== undefined) rec.spawnError = redactor.redact(res.spawnError);
  return rec;
}

/** Runs and records in one go. */
export async function runRecorded(runner: ProcessRunner, req: ExecRequest, redactor: Redactor, into: StepRecord['commands']): Promise<ExecResult> {
  for (const s of req.secrets ?? []) redactor.addSecret(s);
  const res = await runner.run(req);
  into.push(commandRecord(req, res, redactor));
  return res;
}
