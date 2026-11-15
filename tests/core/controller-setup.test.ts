import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecRequest, ExecResult, ProcessRunner } from '../../src/contracts.js';
import { runControllerSetup } from '../../src/core/controller/setup.js';
import { DefaultRedactor } from '../../src/core/shared/redact.js';

const ok = (stdout: string): ExecResult => ({ exitCode: 0, signal: null, stdout, stderr: '', durationMs: 1, timedOut: false });

describe('runControllerSetup', () => {
  let tmp: string;
  let calls: ExecRequest[];
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lanplay-csetup-'));
    calls = [];
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const env = (runner: ProcessRunner) => ({
    runner,
    redactor: new DefaultRedactor(),
    systemRoot: 'C:\\Windows',
    psDir: 'C:\\Program Files\\LanPlay\\resources\\ps',
    installerPath: 'C:\\Program Files\\LanPlay\\resources\\vendor\\ViGEmBus_1.22.0_x64_x86_arm64.exe',
    selfExe: 'C:\\Users\\me\\AppData\\Local\\Programs\\LanPlay\\LanPlay.exe',
    port: 47921,
    tempDir: tmp,
  });

  /** A runner that behaves like invoke-elevated.ps1 and lets the test play the elevated child by writing the result file. */
  const runnerWith = (child: (resultFile: string) => void, elevated: unknown = { exitCode: 0, cancelled: false }): ProcessRunner => ({
    async run(req) {
      calls.push(req);
      // The child's own argv travels base64-encoded inside the -ArgumentListB64 value.
      const i = req.args.indexOf('-ArgumentListB64');
      const inner = JSON.parse(Buffer.from(req.args[i + 1]!, 'base64').toString('utf8')) as string[];
      const rf = inner[inner.indexOf('-ResultFile') + 1]!.replace(/^"|"$/g, '');
      child(rf);
      return ok(JSON.stringify(elevated));
    },
  });

  it('elevates powershell.exe running setup-controllers.ps1 with the installer, port, program and a private result file', async () => {
    let inner: string[] = [];
    const runner: ProcessRunner = {
      async run(req) {
        calls.push(req);
        const i = req.args.indexOf('-ArgumentListB64');
        inner = JSON.parse(Buffer.from(req.args[i + 1]!, 'base64').toString('utf8')) as string[];
        const rf = inner[inner.indexOf('-ResultFile') + 1]!.replace(/^"|"$/g, '');
        writeFileSync(rf, JSON.stringify({ ok: true, message: 'ok' }));
        return ok(JSON.stringify({ exitCode: 0, cancelled: false }));
      },
    };
    const r = await runControllerSetup(env(runner));
    expect(r).toEqual({ ok: true, message: 'Phone controllers are set up.' });
    expect(calls[0]!.args).toContain('-FilePath');
    expect(calls[0]!.args[calls[0]!.args.indexOf('-FilePath') + 1]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const strip = (s: string) => s.replace(/^"|"$/g, '');
    expect(inner.map(strip)).toEqual(
      expect.arrayContaining(['-File', 'C:\\Program Files\\LanPlay\\resources\\ps\\setup-controllers.ps1', '-InstallerPath', 'C:\\Program Files\\LanPlay\\resources\\vendor\\ViGEmBus_1.22.0_x64_x86_arm64.exe', '-Port', '47921', '-Program', 'C:\\Users\\me\\AppData\\Local\\Programs\\LanPlay\\LanPlay.exe']),
    );
    expect(inner.map(strip).find((a) => a.startsWith(tmp))).toBeTruthy(); // result file lives in the temp dir
  });

  it('removes the result file afterwards', async () => {
    let rf = '';
    await runControllerSetup(
      env(
        runnerWith((f) => {
          rf = f;
          writeFileSync(f, JSON.stringify({ ok: true, message: 'ok' }));
        }),
      ),
    );
    expect(() => readFileSync(rf)).toThrow();
  });

  it('reports the script failure message', async () => {
    const r = await runControllerSetup(env(runnerWith((f) => writeFileSync(f, JSON.stringify({ ok: false, message: 'The virtual controller driver (ViGEmBus) could not be installed.' })))));
    expect(r).toEqual({ ok: false, message: 'The virtual controller driver (ViGEmBus) could not be installed.' });
  });

  it('says so when the Windows permission prompt was cancelled', async () => {
    const r = await runControllerSetup(env(runnerWith(() => undefined, { exitCode: null, cancelled: true })));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cancel/i);
  });

  it('a missing or garbled result file is a failure with a useful message, never a throw', async () => {
    const none = await runControllerSetup(env(runnerWith(() => undefined)));
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/no result|did not finish/i);
    const bad = await runControllerSetup(env(runnerWith((f) => writeFileSync(f, '{nope'))));
    expect(bad.ok).toBe(false);
  });
});
