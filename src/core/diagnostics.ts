// "Copy diagnostics" / --diagnostics: one zip with everything needed to fix a failure in one round.
// Layout: see DiagnosticsService in contracts. Every text passes through the Redactor before it is written.
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { LANPLAY } from './../contracts.js';
import type { AppPaths, DiagnosticsManifest, DiagnosticsService, Redactor, Role, SelfCheckReport } from '../contracts.js';
import { redactValue } from './shared/redact.js';
import { tcpProbe } from './shared/netprobe.js';

export interface DiagFile {
  name: string;
  text: string;
}

export interface DiagnosticsDeps {
  role: Role;
  paths: AppPaths;
  redactor: Redactor;
  app: DiagnosticsManifest['app'];
  selfCheck: () => Promise<SelfCheckReport>;
  /** OS version/build, GPUs, admin status (PowerShell on Windows, sw_vers/system_profiler on macOS). */
  system: () => Promise<{ os: DiagnosticsManifest['os']; gpus: DiagnosticsManifest['gpus']; isAdmin: boolean | null; extra?: Record<string, unknown> }>;
  /** Role-specific files (host: firewall.json, sunshine.json, sunshine logs, installer logs; client: Moonlight logs). */
  extraFiles: () => Promise<DiagFile[]>;
  /** Extra listener details (host: get-listeners.ps1). */
  listeners?: () => Promise<unknown>;
  resolvedPaths: Record<string, unknown>;
  /**
   * Stored secrets (e.g. the Sunshine admin password) to mask in everything that goes into the zip. A fresh app
   * session's Redactor has never seen them, and third-party logs (sunshine.log, installer logs) are copied verbatim.
   */
  secrets?: () => Promise<string[]>;
  /** Other folders that may hold LanPlay logs (the elevated helper logs to %ProgramData% even when the app fell back). */
  extraLogDirs?: string[];
  now?: () => Date;
  hostName?: string;
}

/** Last maxBytes of a text file; handles UTF-16LE (msiexec /l*v logs) and UTF-8. */
export function readTailText(file: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    fd = openSync(file, 'r');
    const head = Buffer.alloc(Math.min(2, size));
    readSync(fd, head, 0, head.length, 0);
    const utf16 = head.length === 2 && head[0] === 0xff && head[1] === 0xfe;
    let start = Math.max(0, size - maxBytes);
    if (utf16 && start % 2 === 1) start++;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = utf16 ? buf.toString('utf16le') : buf.toString('utf8');
    if (start === 0) text = text.replace(/^﻿/, '');
    return (start > 0 ? '…(truncated)\n' : '') + text;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function newestFiles(dir: string, filter: (name: string) => boolean, count: number): string[] {
  try {
    return readdirSync(dir)
      .filter(filter)
      .map((n) => {
        const p = path.join(dir, n);
        try {
          return { p, m: statSync(p).mtimeMs };
        } catch {
          return { p, m: 0 };
        }
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, count)
      .map((x) => x.p);
  } catch {
    return [];
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** LanPlay logs of the last 3 days (normal + elevated). */
export function recentLogFiles(logDir: string, now: Date): string[] {
  const cutoff = now.getTime() - 3 * 24 * 3600_000;
  return newestFiles(logDir, (n) => /^lanplay-\d{4}-\d{2}-\d{2}(\.elevated)?\.log$/.test(n), 20).filter((p) => {
    try {
      return statSync(p).mtimeMs >= cutoff;
    } catch {
      return false;
    }
  });
}

/** Extract step and REST records from JSONL logs. */
export function extractRecords(texts: string[]): { steps: string[]; rest: string[] } {
  const steps: string[] = [];
  const rest: string[] = [];
  for (const t of texts) {
    for (const line of t.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const e = JSON.parse(line) as { ts?: string; scope?: string; step?: unknown; rest?: unknown };
        if (e.step) steps.push(JSON.stringify({ ts: e.ts, scope: e.scope, ...(e.step as object) }));
        if (e.rest) rest.push(JSON.stringify(e.rest));
      } catch {
        /* truncated first line */
      }
    }
  }
  return { steps, rest };
}

export async function collectDiagnostics(d: DiagnosticsDeps, outDir?: string): Promise<{ zipPath: string; bytes: number }> {
  const now = (d.now ?? (() => new Date()))();
  const files: DiagFile[] = [];
  const errors: string[] = [];
  const safe = async <T>(what: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${what}: ${(e as Error)?.message ?? String(e)}`);
      return { error: (e as Error)?.message ?? String(e) };
    }
  };
  const json = (v: unknown) => JSON.stringify(redactValue(d.redactor, v), null, 2);

  // Register stored secrets FIRST so nothing collected below can carry them into the zip.
  if (d.secrets) {
    const got = await safe('secrets for redaction', d.secrets);
    if (Array.isArray(got)) {
      for (const sec of got) {
        if (typeof sec !== 'string' || !sec) continue;
        d.redactor.addSecret(sec);
        // Also the forms it takes inside an HTTP Basic header.
        d.redactor.addSecret(Buffer.from(sec, 'utf8').toString('base64'));
        d.redactor.addSecret(Buffer.from(`${LANPLAY.sunshineAdminUser}:${sec}`, 'utf8').toString('base64'));
      }
    }
  }

  const selfcheck = await safe('selfcheck', d.selfCheck);
  files.push({ name: 'selfcheck.json', text: json(selfcheck) });

  // Logs (tails) + extracted step/REST records.
  const logTexts: string[] = [];
  const logDirs = [...new Set([d.paths.logDir, ...(d.extraLogDirs ?? [])])];
  const seenLogNames = new Set<string>();
  for (const dir of logDirs) {
    for (const f of recentLogFiles(dir, now)) {
      const t = readTailText(f, LANPLAY.diagnosticsTailBytes);
      if (t === null) continue;
      logTexts.push(t);
      let name = path.basename(f);
      if (seenLogNames.has(name)) name = `${path.basename(dir)}-${name}`;
      seenLogNames.add(name);
      files.push({ name: `logs/${name}`, text: t });
    }
  }
  const rec = extractRecords(logTexts);
  files.push({ name: 'steps.jsonl', text: rec.steps.join('\n') + (rec.steps.length ? '\n' : '') });
  files.push({ name: 'rest-calls.jsonl', text: rec.rest.join('\n') + (rec.rest.length ? '\n' : '') });

  // Network: interfaces + loopback listen checks + platform listener details.
  const ports = await Promise.all(LANPLAY.listenPortsToCheck.map(async (port) => ({ port, proto: 'tcp', listening: await tcpProbe('127.0.0.1', port, 800) })));
  const network = {
    hostName: d.hostName ?? os.hostname(),
    interfaces: os.networkInterfaces(),
    loopbackTcp: ports,
    listeners: d.listeners ? await safe('listeners', d.listeners) : null,
  };
  files.push({ name: 'network.json', text: json(network) });

  files.push({ name: 'paths.json', text: json({ ...d.paths, ...d.resolvedPaths, logDirsRead: logDirs }) });

  const extra = await safe('extra files', d.extraFiles);
  if (Array.isArray(extra)) files.push(...extra);

  const sys = await safe('system info', d.system);
  const sysOk = 'os' in sys ? sys : null;
  if (errors.length) files.push({ name: 'collector-errors.txt', text: errors.join('\n') + '\n' });

  const redacted = files.map((f) => ({ name: f.name, buf: Buffer.from(d.redactor.redact(f.text), 'utf8') }));
  const manifest: DiagnosticsManifest = {
    createdAt: now.toISOString(),
    app: d.app,
    os: sysOk?.os ?? { platform: process.platform, release: os.release(), arch: process.arch },
    isAdmin: sysOk?.isAdmin ?? null,
    gpus: sysOk?.gpus ?? [],
    cpuModel: os.cpus()[0]?.model ?? '',
    role: d.role,
    files: redacted.map((f) => ({ name: f.name, bytes: f.buf.length })),
  };
  const manifestText = d.redactor.redact(JSON.stringify({ ...manifest, systemExtra: sysOk?.extra ?? null, logDirFellBack: d.paths.logDirFellBack }, null, 2));

  const dir = outDir ?? d.paths.diagnosticsOutDir;
  mkdirSync(dir, { recursive: true });
  const host = (d.hostName ?? os.hostname()).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'host';
  let zipPath = path.join(dir, `LanPlay-diagnostics-${host}-${stamp(now)}.zip`);
  for (let i = 2; existsSync(zipPath); i++) zipPath = path.join(dir, `LanPlay-diagnostics-${host}-${stamp(now)}-${i}.zip`);

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(manifestText, 'utf8'), 'manifest.json', { mtime: now });
  for (const f of redacted) zip.addBuffer(f.buf, f.name, { mtime: now });
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(zipPath, { mode: 0o600 });
    ws.on('close', () => resolve());
    ws.on('error', reject);
    zip.outputStream.on('error', reject).pipe(ws);
    zip.end();
  });
  return { zipPath, bytes: statSync(zipPath).size };
}

export function createDiagnosticsService(d: DiagnosticsDeps): DiagnosticsService {
  return { collect: (outDir?: string) => collectDiagnostics(d, outDir) };
}
