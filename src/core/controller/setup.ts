// Elevated one-time setup for phone controllers: install the virtual-controller driver and open the LAN port (UAC prompt).
// The parent (this code) cannot see an elevated child's output, so setup-controllers.ps1 writes a result file that is read here.
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProcessRunner, Redactor, StepRecord } from '../../contracts.js';
import { runPs } from '../host/ps.js';
import { powershellExe, quoteWindowsArg } from '../host/winargs.js';
import type { SetupResult } from './service.js';

export interface ControllerSetupEnv {
  runner: ProcessRunner;
  redactor: Redactor;
  systemRoot: string;
  /** Folder with the wrapper scripts (resources/ps). */
  psDir: string;
  /** The pinned ViGEmBus installer shipped with the app. */
  installerPath: string;
  /** LanPlay.exe (a firewall rule bound to it avoids the Windows "allow access?" prompt). */
  selfExe: string;
  port: number;
  /** Private temp folder for the result file (default: the user's temp). */
  tempDir?: string;
}

const TEN_MINUTES = 10 * 60_000;

export async function runControllerSetup(env: ControllerSetupEnv): Promise<SetupResult> {
  const resultFile = path.join(env.tempDir ?? os.tmpdir(), `lanplay-controllers-${randomBytes(8).toString('hex')}.json`);
  const child = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.win32.join(env.psDir, 'setup-controllers.ps1'),
    '-InstallerPath',
    env.installerPath,
    '-Port',
    String(env.port),
    '-Program',
    env.selfExe,
    '-ResultFile',
    resultFile,
  ].map(quoteWindowsArg);
  const b64 = Buffer.from(JSON.stringify(child), 'utf8').toString('base64');
  const commands: StepRecord['commands'] = [];
  try {
    const ps = await runPs<{ exitCode: number | null; cancelled: boolean }>(
      { runner: env.runner, systemRoot: env.systemRoot, psDir: env.psDir, redactor: env.redactor },
      'invoke-elevated',
      { FilePath: powershellExe(env.systemRoot), ArgumentListB64: b64 },
      TEN_MINUTES,
      commands,
    );
    let parsed: { ok?: unknown; message?: unknown } | null = null;
    try {
      parsed = JSON.parse(readFileSync(resultFile, 'utf8')) as { ok?: unknown; message?: unknown };
    } catch {
      /* handled below */
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
      return parsed.ok ? { ok: true, message: 'Phone controllers are set up.' } : { ok: false, message: typeof parsed.message === 'string' && parsed.message ? parsed.message : 'Setup failed.' };
    }
    if (ps.json?.cancelled) return { ok: false, message: 'The Windows permission prompt was cancelled. Press Install driver again and choose Yes.' };
    return { ok: false, message: `The setup did not finish and left no result${ps.error ? ` (${ps.error})` : ''}.` };
  } finally {
    rmSync(resultFile, { force: true });
  }
}
