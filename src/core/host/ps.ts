// Runs one thin PowerShell wrapper and parses its single JSON object. TypeScript makes every decision.
import type { ExecResult, PsInvocation, PsScriptName, ProcessRunner, Redactor, StepRecord } from '../../contracts.js';
import { runRecorded } from '../shared/exec.js';
import { buildPsArgv } from './winargs.js';

export interface PsResult<T> {
  ok: boolean;
  json: T | null;
  /** {error} reported by the wrapper, or a parse/spawn problem. */
  error: string | null;
  res: ExecResult;
}

/** Parse the LAST JSON object on stdout (PowerShell may print warnings before it). */
export function parsePsJson(stdout: string): unknown {
  const s = stdout.replace(/^﻿/, '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const start = s.lastIndexOf('\n{');
    if (start >= 0) {
      try {
        return JSON.parse(s.slice(start + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface PsEnv {
  runner: ProcessRunner;
  systemRoot: string;
  psDir: string;
  redactor: Redactor;
}

export async function runPs<T>(
  env: PsEnv,
  script: PsScriptName,
  params: PsInvocation['params'],
  timeoutMs: number,
  into: StepRecord['commands'],
  secrets: readonly string[] = [],
): Promise<PsResult<T>> {
  const { file, args } = buildPsArgv(env.systemRoot, env.psDir, { script, params, timeoutMs });
  const res = await runRecorded(env.runner, { file, args, timeoutMs, secrets }, env.redactor, into);
  if (res.spawnError) return { ok: false, json: null, error: `could not start powershell.exe: ${res.spawnError}`, res };
  if (res.timedOut) return { ok: false, json: null, error: `${script}.ps1 timed out after ${timeoutMs} ms`, res };
  const json = parsePsJson(res.stdout) as (T & { error?: string }) | null;
  const reported = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : null;
  if (res.exitCode !== 0) {
    return { ok: false, json, error: reported ?? `${script}.ps1 exited with ${res.exitCode}: ${res.stderr.trim().slice(-300)}`, res };
  }
  if (json === null) return { ok: false, json: null, error: `${script}.ps1 printed no JSON`, res };
  return { ok: true, json, error: null, res };
}
