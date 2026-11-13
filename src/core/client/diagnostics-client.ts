// Client-only diagnostics: Moonlight CLI logs (/tmp/Moonlight-<epoch>.log on macOS, %TEMP%\\Moonlight-<epoch>.log on Windows), OS version, GPU.
import path from 'node:path';
import os from 'node:os';
import { LANPLAY, MOONLIGHT } from '../../contracts.js';
import type { ProcessRunner } from '../../contracts.js';
import { newestFiles, readTailText } from '../diagnostics.js';
import type { DiagFile } from '../diagnostics.js';

export function clientDiagnosticsFiles(logDir: string = MOONLIGHT.macLogGlobDir): DiagFile[] {
  const files: DiagFile[] = [];
  for (const f of newestFiles(logDir, (n) => n.startsWith(MOONLIGHT.macLogPrefix) && n.endsWith('.log'), 3)) {
    const t = readTailText(f, LANPLAY.diagnosticsTailBytes);
    if (t !== null) files.push({ name: `logs/moonlight/${path.basename(f)}`, text: t });
  }
  return files;
}

export async function macSystemInfo(runner: ProcessRunner) {
  const sw = await runner.run({ file: '/usr/bin/sw_vers', args: [], timeoutMs: 10_000 });
  const ver = /ProductVersion:\s*(\S+)/.exec(sw.stdout)?.[1];
  const build = /BuildVersion:\s*(\S+)/.exec(sw.stdout)?.[1];
  const gpus: Array<{ name: string; driverVersion?: string }> = [];
  const sp = await runner.run({ file: '/usr/sbin/system_profiler', args: ['SPDisplaysDataType', '-json'], timeoutMs: 30_000 });
  try {
    const j = JSON.parse(sp.stdout) as { SPDisplaysDataType?: Array<{ sppci_model?: string; _name?: string; sppci_cores?: string }> };
    for (const g of j.SPDisplaysDataType ?? []) gpus.push({ name: `${g.sppci_model ?? g._name ?? 'GPU'}${g.sppci_cores ? ` (${g.sppci_cores} cores)` : ''}` });
  } catch {
    /* ignore */
  }
  const id = await runner.run({ file: '/usr/bin/id', args: ['-Gn'], timeoutMs: 5000 });
  const os_: { platform: string; release: string; arch: string; version?: string; build?: string } = { platform: 'darwin', release: os.release(), arch: process.arch };
  if (ver) os_.version = ver;
  if (build) os_.build = build;
  return { os: os_, gpus, isAdmin: id.exitCode === 0 ? id.stdout.split(/\s+/).includes('admin') : null };
}

/** Windows client: no extra processes (keep diagnostics fast and dependency-free); CPU model stands in for the chip. */
export async function winClientSystemInfo() {
  const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
  return { os: { platform: 'win32', release: os.release(), arch: process.arch }, gpus: [] as Array<{ name: string; driverVersion?: string }>, isAdmin: null, extra: { cpu } };
}
