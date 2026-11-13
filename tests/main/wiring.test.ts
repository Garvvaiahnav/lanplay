import { describe, expect, it } from 'vitest';
import type { ClientService, IpcEventChannel, SelfCheckReport, ServiceDeps } from '../../src/contracts.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { buildHandlers, runSelfCheckCli } from '../../src/main/wiring.js';
import type { Services, WiringEnv } from '../../src/main/wiring.js';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readdirSync } from 'node:fs';

function env(): WiringEnv {
  const log = new MemoryLogger();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-wiring-'));
  const deps: ServiceDeps = {
    log,
    paths: { logDir: dir, userData: dir, sharedData: dir, resources: dir, vendorDir: dir, psDir: dir, diagnosticsOutDir: dir, logDirFellBack: false },
    secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined, backend: () => 'keychain' },
    settings: new MemoryStore(),
    runner: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false }) },
  };
  return { role: 'client', deps, appInfo: { name: 'LanPlay', version: '0.1.0', electron: '45', node: '26', chrome: '1' }, selfExe: '/x', selfArgsPrefix: [], isPackaged: false, appRoot: dir, loginItem: null, fileExists: () => false };
}

describe('buildHandlers', () => {
  it('only reveals zips created in this session; dedupes concurrent self-checks; pushes events', async () => {
    let checks = 0;
    const rep: SelfCheckReport = { role: 'client', startedAt: new Date().toISOString(), durationMs: 1, ok: true, steps: [] };
    const pushed: IpcEventChannel[] = [];
    const client = {
      systemInfo: async () => ({ chip: { model: 'Apple M4', generation: 4, av1HardwareDecode: true }, moonlightPath: null, moonlightVersion: null }),
      discovery: { start: (cb: (h: never[]) => void) => cb([]), stop: () => undefined, addManual: async () => { throw new Error('x'); }, list: () => [] },
      getSettings: () => ({}) as never,
      setSettings: (s: never) => s,
      pair: async () => ({ ok: true, hostId: 'h', alreadyPaired: true, durationMs: 1 }),
      startStream: async () => ({ hostId: 'h', state: 'running' }),
      stopStream: async () => undefined,
      selfCheck: async () => rep,
    } as unknown as ClientService;
    const s: Services = {
      client,
      host: null,
      diagnostics: { collect: async () => ({ zipPath: '/tmp/LanPlay-diagnostics-x.zip', bytes: 10 }) },
      selfCheck: async () => {
        checks++;
        await new Promise((r) => setTimeout(r, 20));
        return rep;
      },
      resolvedPaths: {},
    };
    const revealed: string[] = [];
    const h = buildHandlers(env(), s, (c) => void pushed.push(c), (p) => void revealed.push(p));
    await expect(h['diagnostics:reveal']!({ zipPath: '/etc/passwd' })).rejects.toThrow(/Only a diagnostics file/);
    const z = await h['diagnostics:collect']!();
    await h['diagnostics:reveal']!({ zipPath: z.zipPath });
    expect(revealed).toEqual([z.zipPath]);
    await Promise.all([h['selfcheck:run']!(), h['selfcheck:run']!()]);
    expect(checks).toBe(1);
    await h['client:discover-start']!();
    expect(pushed).toContain('client:hosts-updated');
    expect(h['host:setup-run']).toBeUndefined();
    const info = await h['app:info']!();
    expect(info).toMatchObject({ role: 'client', version: '0.1.0' });
    expect(Array.isArray(info.localAddresses)).toBe(true);
  });

  it('--self-check writes the report next to the logs and returns the exit code', async () => {
    const e = env();
    const out: string[] = [];
    const rep: SelfCheckReport = { role: 'client', startedAt: '2026-11-13T10:00:00.000Z', durationMs: 1, ok: false, steps: [{ stepId: 'x', title: 'X', status: 'fail', startedAt: '', durationMs: 0, message: 'm', commands: [] }] };
    const code = await runSelfCheckCli({ selfCheck: async () => rep } as unknown as Services, e.deps.paths.logDir, (t) => void out.push(t));
    expect(code).toBe(1);
    expect(readdirSync(e.deps.paths.logDir)).toContain('selfcheck-2026-11-13T10-00-00-000Z.json');
    expect(out.join('\n')).toMatch(/Self-check FAILED \(1 failed\)/);
  });
});
