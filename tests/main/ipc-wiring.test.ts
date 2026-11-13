import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC_INVOKE_CHANNELS } from '../../src/contracts.js';
import type { AppPaths, SelfCheckReport } from '../../src/contracts.js';
import { collectDiagnostics, extractRecords, readTailText } from '../../src/core/diagnostics.js';
import { createJsonlLogger } from '../../src/core/shared/logger.js';
import { DefaultRedactor } from '../../src/core/shared/redact.js';
import { createIpcRouter, IPC_VALIDATORS } from '../../src/main/ipc.js';

describe('IPC router', () => {
  const r = new DefaultRedactor();
  r.addSecret('super-secret-password');
  const router = createIpcRouter(
    {
      'app:info': async () => ({ role: 'client', version: '0.1.0', platform: 'darwin', arch: 'arm64', logFile: '/x' }),
      'client:pair': async ({ hostId }) => ({ ok: true, hostId, alreadyPaired: true, durationMs: 1 }),
      'host:agent-set-auto-approve': async () => {
        throw new Error('boom with super-secret-password');
      },
    },
    r,
  );
  it('has a validator for every channel', () => {
    expect(Object.keys(IPC_VALIDATORS).sort()).toEqual([...IPC_INVOKE_CHANNELS].sort());
  });
  it('wraps values and errors in envelopes', async () => {
    expect(await router.dispatch('app:info', undefined)).toMatchObject({ ok: true, value: { role: 'client' } });
    expect(await router.dispatch('client:pair', { hostId: 'ABC' })).toMatchObject({ ok: true, value: { hostId: 'ABC' } });
    const err = await router.dispatch('host:agent-set-auto-approve', { on: true });
    expect(err).toEqual({ ok: false, error: { code: 'failed', message: 'boom with [REDACTED]' } });
  });
  it('rejects unknown channels, wrong roles and bad payloads', async () => {
    expect(await router.dispatch('shell:exec', {})).toMatchObject({ ok: false, error: { code: 'unknown-channel' } });
    expect(await router.dispatch('host:devices-list', undefined)).toMatchObject({ ok: false, error: { code: 'wrong-role' } });
    expect(await router.dispatch('client:pair', { hostId: '' })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    expect(await router.dispatch('client:pair', 'x')).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    expect(await router.dispatch('app:info', { extra: 1 })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    expect(await router.dispatch('host:agent-set-auto-approve', { on: 'yes' })).toMatchObject({ ok: false, error: { code: 'bad-request' } });
  });
  it('validators', () => {
    expect(IPC_VALIDATORS['host:devices-revoke']({ uuid: 'AB-12' })).toEqual({ uuid: 'AB-12' });
    expect(() => IPC_VALIDATORS['host:devices-revoke']({ uuid: '../x' })).toThrow();
    expect(() => IPC_VALIDATORS['client:add-manual-host']({ address: 'http://x/' })).toThrow();
    expect(IPC_VALIDATORS['client:add-manual-host']({ address: '192.168.1.5' })).toEqual({ address: '192.168.1.5' });
    expect(() => IPC_VALIDATORS['host:agent-decide']({ requestId: 'x', approve: true })).toThrow();
    expect(() => IPC_VALIDATORS['client:stream-start']({ hostId: 'a', settings: null })).toThrow();
  });
});

describe('diagnostics zip', () => {
  it('collects logs, steps, REST calls, network, paths and role files, all redacted', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-diag-'));
    const paths: AppPaths = { logDir: path.join(root, 'logs'), userData: root, sharedData: root, resources: root, vendorDir: root, psDir: root, diagnosticsOutDir: path.join(root, 'Desktop'), logDirFellBack: true };
    const log = createJsonlLogger({ dir: paths.logDir, filePattern: 'lanplay-<date>.log' });
    const elevated = createJsonlLogger({ dir: paths.logDir, filePattern: 'lanplay-<date>.elevated.log', redactor: log.redactor });
    const pw = 'diag-secret-password-xyz';
    log.redactor.addSecret(pw);
    elevated.step({ stepId: 'credentials', title: 'Sunshine admin login', status: 'fail', startedAt: new Date().toISOString(), durationMs: 12, message: 'sunshine.exe --creds exited with 1.', commands: [{ file: 'C:\\Program Files\\Sunshine\\sunshine.exe', argv: ['--creds', 'lanplay', pw], exitCode: 1, durationMs: 10, stdoutTail: '', stderrTail: 'error', timedOut: false }] });
    log.rest({ at: new Date().toISOString(), method: 'POST', url: 'https://127.0.0.1:47990/api/pin', status: 200, durationMs: 5, requestBody: '{"pairing_id":"0123456789abcdef0123456789abcdef","pin":"1234","name":"Mac"}' });
    // UTF-16LE msiexec log
    const msiLog = path.join(paths.logDir, 'msiexec-x.log');
    writeFileSync(msiLog, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('MSI (s) Product: Sunshine -- Installation completed successfully. Jörg\r\n', 'utf16le')]));
    expect(readTailText(msiLog, 1000)).toContain('completed successfully. Jörg');
    const rep: SelfCheckReport = { role: 'host', startedAt: new Date().toISOString(), durationMs: 1, ok: false, steps: [] };
    const { zipPath, bytes } = await collectDiagnostics({
      role: 'host',
      paths,
      redactor: log.redactor,
      app: { name: 'LanPlay', version: '0.1.0', electron: '45.1.0', node: process.versions.node, chrome: '1' },
      selfCheck: async () => rep,
      system: async () => ({ os: { platform: 'win32', release: 'Windows 11 Pro', arch: 'x64', version: '10.0.26100', build: '26100' }, gpus: [{ name: 'RTX 4070', driverVersion: '32.0' }], isAdmin: false }),
      extraFiles: async () => [{ name: 'logs/msiexec.log', text: readTailText(msiLog, 10_000)! }, { name: 'firewall.json', text: `{"note":"has ${pw}"}` }],
      listeners: async () => ({ listeners: [] }),
      resolvedPaths: { selfExe: 'C:\\LanPlay\\LanPlay.exe' },
      hostName: 'Gaming PC',
    });
    expect(bytes).toBeGreaterThan(200);
    expect(path.basename(zipPath)).toMatch(/^LanPlay-diagnostics-Gaming_PC-\d{8}-\d{6}\.zip$/);
    const list = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n').sort();
    expect(list).toEqual(expect.arrayContaining(['manifest.json', 'selfcheck.json', 'steps.jsonl', 'rest-calls.jsonl', 'network.json', 'paths.json', 'firewall.json', 'logs/msiexec.log']));
    expect(list.some((n) => /^logs\/lanplay-.*\.elevated\.log$/.test(n))).toBe(true);
    const all = execFileSync('unzip', ['-p', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(all).not.toContain(pw);
    expect(all).not.toContain('0123456789abcdef0123456789abcdef');
    expect(all).not.toContain('"1234"');
    expect(all).toContain('Installation completed successfully. Jörg');
    const manifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }));
    expect(manifest).toMatchObject({ role: 'host', isAdmin: false, gpus: [{ name: 'RTX 4070' }], logDirFellBack: true });
    expect(manifest.files.find((f: { name: string }) => f.name === 'steps.jsonl').bytes).toBeGreaterThan(10);
    const steps = execFileSync('unzip', ['-p', zipPath, 'steps.jsonl'], { encoding: 'utf8' }).trim().split('\n').map((l) => JSON.parse(l));
    expect(steps[0]).toMatchObject({ stepId: 'credentials', status: 'fail' });
    const net = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'network.json'], { encoding: 'utf8' }));
    expect(net.loopbackTcp.map((p: { port: number }) => p.port)).toEqual([47984, 47989, 47990, 48010, 47920]);
  });

  it('masks the STORED Sunshine password even in a fresh session whose redactor never saw it (third-party logs are copied verbatim)', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lanplay-diag2-'));
    const shared = path.join(root, 'ProgramData', 'LanPlay');
    const paths: AppPaths = { logDir: path.join(root, 'LocalAppData', 'LanPlay', 'logs'), userData: root, sharedData: shared, resources: root, vendorDir: root, psDir: root, diagnosticsOutDir: path.join(root, 'Desktop'), logDirFellBack: true };
    const pw = 'Zm9vYmFyLXN0b3JlZC1wYXNzd29yZC0wMTIzNDU2Nzg5';
    const basic = Buffer.from(`lanplay:${pw}`).toString('base64');
    // a brand-new logger/redactor: nobody called addSecret(pw) in this "session"
    const log = createJsonlLogger({ dir: paths.logDir, filePattern: 'lanplay-<date>.log' });
    log.log('info', 'main', 'start');
    // the elevated helper logged under %ProgramData% while this session fell back to %LOCALAPPDATA%
    const elevated = createJsonlLogger({ dir: path.join(shared, 'logs'), filePattern: 'lanplay-<date>.elevated.log' });
    elevated.step({ stepId: 'service', title: 'Sunshine service', status: 'pass', startedAt: new Date().toISOString(), durationMs: 1, message: 'ok', commands: [] });
    const { zipPath } = await collectDiagnostics({
      role: 'host',
      paths,
      redactor: log.redactor,
      app: { name: 'LanPlay', version: '0.1.0', electron: '45.1.0', node: process.versions.node, chrome: '1' },
      selfCheck: async () => ({ role: 'host', startedAt: new Date().toISOString(), durationMs: 1, ok: true, steps: [] }),
      system: async () => ({ os: { platform: 'win32', release: 'Windows 11', arch: 'x64' }, gpus: [], isAdmin: false }),
      extraFiles: async () => [{ name: 'logs/sunshine.log', text: `Info: cmdline sunshine.exe --creds lanplay ${pw}\nDebug: header X-Thing: ${basic}\nInfo: plain ${pw} again\n` }],
      resolvedPaths: {},
      secrets: async () => [pw],
      extraLogDirs: [path.join(shared, 'logs')],
      hostName: 'PC',
    });
    const all = execFileSync('unzip', ['-p', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(all).not.toContain(pw);
    expect(all).not.toContain(basic);
    expect(all).toContain('[REDACTED]');
    const list = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
    expect(list.some((n) => /^logs\/lanplay-.*\.elevated\.log$/.test(n))).toBe(true); // found in the second log folder
    const steps = execFileSync('unzip', ['-p', zipPath, 'steps.jsonl'], { encoding: 'utf8' });
    expect(steps).toContain('"stepId":"service"');
  });

  it('extractRecords skips partial lines', () => {
    const r = extractRecords(['…(truncated)\n{"broken', '{"ts":"t","scope":"s","step":{"stepId":"a"}}\n{"rest":{"url":"u"}}']);
    expect(r.steps).toHaveLength(1);
    expect(r.rest).toHaveLength(1);
  });
});

describe('stores', () => {
  it('file secret store is 0600 and JsonFileStore round-trips', async () => {
    const { FileSecretStore, JsonFileStore, SafeStorageSecretStore, chooseSecretStore } = await import('../../src/core/shared/stores.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-store-'));
    mkdirSync(dir, { recursive: true });
    const s = new FileSecretStore(path.join(dir, 'secrets.json'));
    await s.set('sunshine-admin-password', 'abc');
    expect(await s.get('sunshine-admin-password')).toBe('abc');
    const { statSync } = await import('node:fs');
    expect(statSync(path.join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
    await s.delete('sunshine-admin-password');
    expect(await s.get('sunshine-admin-password')).toBeNull();
    const kv = new JsonFileStore(path.join(dir, 'settings.json'));
    kv.set('a', { b: 1 });
    expect(new JsonFileStore(path.join(dir, 'settings.json')).get('a', null)).toEqual({ b: 1 });
    const fake = { isEncryptionAvailable: () => true, encryptString: (p: string) => Buffer.from(p.split('').reverse().join('')), decryptString: (b: Buffer) => b.toString().split('').reverse().join('') };
    const ss = chooseSecretStore(fake, dir, 'darwin');
    expect(ss).toBeInstanceOf(SafeStorageSecretStore);
    expect(ss.backend()).toBe('keychain');
    await ss.set('sunshine-admin-password', 'plain-text-pw');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path.join(dir, 'secrets.enc.json'), 'utf8')).not.toContain('plain-text-pw');
    expect(await ss.get('sunshine-admin-password')).toBe('plain-text-pw');
    expect(chooseSecretStore({ ...fake, isEncryptionAvailable: () => false }, dir, 'win32').backend()).toBe('file-0600');
    expect(chooseSecretStore(fake, dir, 'win32').backend()).toBe('dpapi');
  });
});
