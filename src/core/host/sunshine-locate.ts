// Find the Sunshine install root without hardcoding paths: service binPath -> uninstall registry -> fallback list.
import path from 'node:path';
import { SUNSHINE } from '../../contracts.js';
import type { LocateSunshine, SunshineFactsPs, SunshineInstall } from '../../contracts.js';

const w = path.win32;

/** Strip quotes and arguments from a Win32_Service PathName: "\"C:\\Program Files\\Sunshine\\tools\\sunshinesvc.exe\" -x" -> path. */
export function servicePathToExe(pathName: string): string | null {
  const s = String(pathName ?? '').trim();
  if (!s) return null;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end) : null;
  }
  const m = /^(.+?\.exe)(?:\s|$)/i.exec(s);
  return m ? m[1]! : s;
}

/** <root>\tools\sunshinesvc.exe -> <root>. Returns null when the binary is not the expected one. */
export function rootFromServiceExe(exe: string): string | null {
  const norm = w.normalize(exe);
  const rel = SUNSHINE.serviceBinaryRelative.toLowerCase();
  if (!norm.toLowerCase().endsWith('\\' + rel)) return null;
  return stripTrailingSep(norm.slice(0, norm.length - rel.length - 1));
}

function stripTrailingSep(p: string): string {
  let out = w.normalize(p);
  while (out.length > 3 && (out.endsWith('\\') || out.endsWith('/'))) out = out.slice(0, -1);
  return out;
}

export function installFromRoot(root: string, foundVia: SunshineInstall['foundVia'], version?: string): SunshineInstall {
  const r = stripTrailingSep(root);
  const configDir = w.join(r, SUNSHINE.configDirRelative);
  const inst: SunshineInstall = {
    root: r,
    exe: w.join(r, 'sunshine.exe'),
    serviceExe: w.join(r, SUNSHINE.serviceBinaryRelative),
    configDir,
    configFile: w.join(configDir, SUNSHINE.configFileName),
    logFile: w.join(configDir, SUNSHINE.logFileName),
    certFile: w.join(configDir, SUNSHINE.certRelativeToConfigDir),
    foundVia,
  };
  if (version) inst.version = version;
  return inst;
}

/** An old NSIS install (UninstallString "...\uninstall.exe") must be removed by the user first (upstream instruction). */
export function findNsisInstall(facts: SunshineFactsPs): SunshineFactsPs['uninstallEntries'][number] | null {
  for (const e of facts.uninstallEntries ?? []) {
    if (!/^sunshine/i.test(e.displayName ?? '')) continue;
    const u = (e.uninstallString ?? '').trim().replace(/^"|"$/g, '').replace(/"\s.*$/, '');
    if (/\\uninstall\.exe$/i.test(u)) return e;
  }
  return null;
}

function sunshineEntries(facts: SunshineFactsPs) {
  return (facts.uninstallEntries ?? []).filter((e) => /^sunshine\b/i.test(e.displayName ?? ''));
}

export const locateSunshine: LocateSunshine = (facts, fileExists) => {
  const versionFromRegistry = sunshineEntries(facts).find((e) => e.displayVersion)?.displayVersion;
  const ok = (root: string) => fileExists(w.join(root, 'sunshine.exe'));

  // 1. Service binPath
  if (facts.service?.pathName) {
    const exe = servicePathToExe(facts.service.pathName);
    const root = exe ? rootFromServiceExe(exe) : null;
    if (root && ok(root)) return installFromRoot(root, 'service-binpath', versionFromRegistry);
  }
  // 2. Uninstall registry InstallLocation
  for (const e of sunshineEntries(facts)) {
    if (e.installLocation && e.installLocation.trim()) {
      const root = stripTrailingSep(e.installLocation.trim().replace(/^"|"$/g, ''));
      if (ok(root)) return installFromRoot(root, 'uninstall-registry', e.displayVersion ?? versionFromRegistry);
    }
  }
  // 3. Fallback list: %ProgramW6432%, %ProgramFiles%, %ProgramFiles(x86)% + \Sunshine
  const bases = [facts.env?.ProgramW6432, facts.env?.ProgramFiles, facts.env?.['ProgramFiles(x86)']].filter((b): b is string => Boolean(b && b.trim()));
  const seen = new Set<string>();
  for (const b of bases) {
    const root = w.join(b, SUNSHINE.defaultInstallDirName);
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (ok(root)) return installFromRoot(root, 'fallback-path', versionFromRegistry);
  }
  return null;
};

/** Honour a `log_path` override in sunshine.conf (relative paths are relative to the config dir). */
export function applyLogPathOverride(inst: SunshineInstall, confText: string): SunshineInstall {
  const m = /^\s*log_path\s*=\s*(.+?)\s*$/m.exec(confText);
  if (!m) return inst;
  const v = m[1]!.replace(/^"|"$/g, '');
  const logFile = w.isAbsolute(v) ? w.normalize(v) : w.join(inst.configDir, v);
  return { ...inst, logFile };
}
