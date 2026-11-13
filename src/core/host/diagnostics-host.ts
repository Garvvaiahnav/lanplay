// Host-only diagnostics files: firewall.json, sunshine.json, sunshine.log tail, installer logs, msiexec log.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LANPLAY, SUNSHINE } from '../../contracts.js';
import type { AppPaths, ProcessRunner, Redactor, StepRecord, SunshineClient, SunshineFactsPs } from '../../contracts.js';
import { newestFiles, readTailText } from '../diagnostics.js';
import type { DiagFile } from '../diagnostics.js';
import { runPs } from './ps.js';
import { applyLogPathOverride, findNsisInstall, locateSunshine } from './sunshine-locate.js';

export interface HostDiagDeps {
  runner: ProcessRunner;
  redactor: Redactor;
  paths: AppPaths;
  systemRoot: string;
  selfExe: string;
  sunshine: SunshineClient;
  pinnedCertPath: string;
}

export async function hostDiagnosticsFiles(d: HostDiagDeps): Promise<DiagFile[]> {
  const files: DiagFile[] = [];
  const env = { runner: d.runner, systemRoot: d.systemRoot, psDir: d.paths.psDir, redactor: d.redactor };
  const cmds: StepRecord['commands'] = [];
  const max = LANPLAY.diagnosticsTailBytes;

  const fw = await runPs<unknown>(env, 'get-firewall-rules', { Names: [SUNSHINE.firewallRuleName, LANPLAY.agentFirewallRuleName], Program: d.selfExe }, 60_000, cmds);
  files.push({ name: 'firewall.json', text: JSON.stringify({ ok: fw.ok, error: fw.error, result: fw.json, stderr: fw.res.stderr.slice(-2000) }, null, 2) });

  const facts = await runPs<SunshineFactsPs>(env, 'get-sunshine-facts', {}, 60_000, cmds);
  let install = null;
  let nsis = null;
  if (facts.ok && facts.json) {
    install = locateSunshine(facts.json, (p) => existsSync(p));
    nsis = findNsisInstall(facts.json);
    if (install) {
      try {
        install = applyLogPathOverride(install, readFileSync(install.configFile, 'utf8'));
      } catch {
        /* conf unreadable */
      }
    }
  }
  let apiVersion: string | { error: string } = { error: 'not tried' };
  try {
    apiVersion = await d.sunshine.getVersion();
  } catch (e) {
    apiVersion = { error: (e as Error).message };
  }
  let conf: string | null = null;
  if (install) {
    try {
      conf = readFileSync(install.configFile, 'utf8');
    } catch (e) {
      conf = `unreadable: ${(e as Error).message}`;
    }
  }
  let pinned: string | null = null;
  try {
    pinned = readFileSync(d.pinnedCertPath, 'utf8').slice(0, 200) + '…';
  } catch {
    pinned = null;
  }
  files.push({
    name: 'sunshine.json',
    text: JSON.stringify({ facts: facts.json, factsError: facts.error, install, oldNsisInstall: nsis, apiVersion, sunshineConf: conf, pinnedCertPresent: pinned !== null }, null, 2),
  });

  // sunshine.log: file first (needs read access to Program Files\Sunshine\config), API as fallback.
  let slog = install ? readTailText(install.logFile, max) : null;
  if (slog === null) {
    try {
      slog = `(via GET /api/logs)\n${await d.sunshine.getLogsTail(max)}`;
    } catch (e) {
      slog = `sunshine.log unavailable: ${(e as Error).message}`;
    }
  }
  files.push({ name: 'logs/sunshine.log', text: slog });

  // Upstream installer logs: "%TEMP%/Sunshine/logs/install/" (docs/getting_started.md)
  const temp = facts.json?.env?.TEMP ?? process.env.TEMP;
  if (temp) {
    const dir = path.join(temp, SUNSHINE.installerLogDirRelativeToTemp);
    for (const f of newestFiles(dir, () => true, 2)) {
      const t = readTailText(f, max);
      if (t !== null) files.push({ name: `logs/sunshine-install/${path.basename(f)}`, text: t });
    }
  }
  // The silent MSI action runs as LocalSystem, so its logs are under SYSTEM's temp; the elevated setup copied them
  // next to LanPlay's logs as sunshine-install-* (collectSunshineInstallerLogs).
  const logDirs = [...new Set([d.paths.logDir, path.join(d.paths.sharedData, 'logs')])];
  for (const dir of logDirs) {
    for (const f of newestFiles(dir, (n) => n.startsWith('sunshine-install-'), 3)) {
      const t = readTailText(f, max);
      const name = `logs/sunshine-install/${path.basename(f).replace(/^sunshine-install-/, 'system-')}`;
      if (t !== null && !files.some((x) => x.name === name)) files.push({ name, text: t });
    }
  }
  const msi = logDirs.flatMap((dir) => newestFiles(dir, (n) => /^msiexec-.*\.log$/.test(n), 1))[0];
  if (msi) {
    const t = readTailText(msi, max);
    if (t !== null) files.push({ name: 'logs/msiexec.log', text: t });
  }
  files.push({ name: 'host-commands.json', text: JSON.stringify(cmds, null, 2) });
  return files;
}

export async function hostListeners(d: Pick<HostDiagDeps, 'runner' | 'redactor' | 'paths' | 'systemRoot'>): Promise<unknown> {
  const r = await runPs<unknown>({ runner: d.runner, systemRoot: d.systemRoot, psDir: d.paths.psDir, redactor: d.redactor }, 'get-listeners', { Ports: [...LANPLAY.listenPortsToCheck] }, 60_000, []);
  return { ok: r.ok, error: r.error, result: r.json };
}

export async function hostSystemInfo(d: Pick<HostDiagDeps, 'runner' | 'redactor' | 'paths' | 'systemRoot'>) {
  const r = await runPs<{ os: string; version: string; build: string; gpus: Array<{ name: string; driverVersion?: string }> | { name: string; driverVersion?: string }; isAdmin: boolean; userName: string; psVersion: string }>(
    { runner: d.runner, systemRoot: d.systemRoot, psDir: d.paths.psDir, redactor: d.redactor },
    'get-system-info',
    {},
    60_000,
    [],
  );
  if (!r.ok || !r.json) throw new Error(`get-system-info.ps1: ${r.error}`);
  const j = r.json;
  return {
    os: { platform: 'win32', release: j.os, arch: process.arch, version: j.version, build: j.build },
    gpus: Array.isArray(j.gpus) ? j.gpus : j.gpus ? [j.gpus] : [],
    isAdmin: j.isAdmin,
    extra: { userName: j.userName, psVersion: j.psVersion },
  };
}
