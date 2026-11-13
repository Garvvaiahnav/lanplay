// Windows argv helpers. Pure, path.win32 only (safe to unit-test on macOS).
import path from 'node:path';
import type { BuildMsiexecArgs, BuildPsArgv, PsInvocation, QuoteWindowsArg } from '../../contracts.js';

const w = path.win32;

/**
 * Quote one argument following the MSVCRT / CommandLineToArgvW rules:
 *  - 2n backslashes + quote -> n backslashes, quote toggles; 2n+1 backslashes + quote -> n backslashes + literal quote;
 *  - backslashes not followed by a quote are literal.
 * Rules: https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
 */
export const quoteWindowsArg: QuoteWindowsArg = (arg) => {
  const s = String(arg);
  if (s.length > 0 && !/[ \t\n\v"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
};

/** Absolute path to Windows PowerShell 5.1 (never PATH lookup). */
export function powershellExe(systemRoot: string): string {
  return w.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function system32Exe(systemRoot: string, exe: string): string {
  return w.join(systemRoot, 'System32', exe);
}

/**
 * PowerShell wrapper argv. Values are passed as separate argv elements (no string concatenation).
 * Under `powershell.exe -File`, every value arrives as a STRING: arrays cannot be passed as arrays and
 * [switch]/$false cannot be passed reliably. So: arrays are joined with ',' (the scripts split them),
 * booleans become '1'/'0' (the scripts declare [int]).
 */
export const buildPsArgv: BuildPsArgv = (systemRoot, psDir, inv: PsInvocation) => {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', w.join(psDir, `${inv.script}.ps1`)];
  for (const [name, value] of Object.entries(inv.params)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`invalid PowerShell parameter name: ${name}`);
    let v: string;
    if (Array.isArray(value)) v = (value as readonly (string | number)[]).map(String).join(',');
    else if (typeof value === 'boolean') v = value ? '1' : '0';
    else v = String(value);
    args.push(`-${name}`, v);
  }
  return { file: powershellExe(systemRoot), args };
};

/** msiexec /i <msi> /qn /norestart /l*v <log>. Exit codes: 0 ok, 3010 ok + reboot, 1603 fatal, 1618 another install running. */
export const buildMsiexecArgs: BuildMsiexecArgs = (systemRoot, msiPath, logPath) => ({
  file: system32Exe(systemRoot, 'msiexec.exe'),
  args: ['/i', msiPath, '/qn', '/norestart', '/l*v', logPath],
});

/** Reference parser (CommandLineToArgvW semantics for arguments after the program name). Used by tests and by self-check to double check quoting. */
export function parseWindowsCommandLine(cmd: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    while (i < n && (cmd[i] === ' ' || cmd[i] === '\t')) i++;
    if (i >= n) break;
    let cur = '';
    let inQuotes = false;
    while (i < n) {
      const c = cmd[i]!;
      if (c === '\\') {
        let k = 0;
        while (i < n && cmd[i] === '\\') {
          k++;
          i++;
        }
        if (cmd[i] === '"') {
          cur += '\\'.repeat(Math.floor(k / 2));
          if (k % 2 === 1) {
            cur += '"';
            i++;
          }
        } else {
          cur += '\\'.repeat(k);
        }
        continue;
      }
      if (c === '"') {
        if (inQuotes && cmd[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = !inQuotes;
        i++;
        continue;
      }
      if (!inQuotes && (c === ' ' || c === '\t')) break;
      cur += c;
      i++;
    }
    out.push(cur);
  }
  return out;
}

/**
 * Run an upstream .bat: cmd.exe /d /c <name.bat> with cwd = the script's folder.
 * .bat files cannot be spawned directly with shell:false (Node CVE-2024-27980 hardening), so cmd.exe runs them.
 * The FULL path is never put on cmd's command line: `cmd /c "C:\Program Files (x86)\x\y.bat"` breaks because cmd
 * strips the quotes when the quoted text contains ( ) & or other special characters ("cmd /?": the quote rules for /C).
 * A bare file name without spaces needs no quoting at all; cmd looks in the current directory first, and the upstream
 * scripts find their own location with %~dp0, so cwd does not change their behaviour.
 */
export function buildBatArgv(systemRoot: string, batPath: string): { file: string; args: string[]; cwd: string } {
  const name = w.basename(batPath);
  const dir = w.dirname(batPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.bat$/i.test(name)) throw new Error(`refusing to run a .bat with an unexpected file name: ${name}`);
  if (!w.isAbsolute(dir)) throw new Error(`.bat path must be absolute: ${batPath}`);
  return { file: system32Exe(systemRoot, 'cmd.exe'), args: ['/d', '/c', name], cwd: dir };
}
