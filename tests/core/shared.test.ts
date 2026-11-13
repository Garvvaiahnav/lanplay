import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultRedactor, REDACTED } from '../../src/core/shared/redact.js';
import { createJsonlLogger, localDateStamp, MemoryLogger } from '../../src/core/shared/logger.js';
import { commandRecord, NodeProcessRunner, tail } from '../../src/core/shared/exec.js';
import { broadcastAddress, isPrivateAddress, normalizeAddress, parseHostHeader, subnetHosts } from '../../src/core/shared/ipnet.js';
import { timedStep } from '../../src/core/shared/steprec.js';

describe('Redactor', () => {
  it('masks literal secrets, JSON keys, auth headers and argv values', () => {
    const r = new DefaultRedactor();
    r.addSecret('S3cr3t-Pass_word');
    expect(r.redact('pw=S3cr3t-Pass_word!')).toBe(`pw=${REDACTED}!`);
    expect(r.redact('{"pin":"1234","name":"mac"}')).toBe(`{"pin":"${REDACTED}","name":"mac"}`);
    expect(r.redact('{"pairing_id": "0123456789abcdef0123456789abcdef"}')).toContain(REDACTED);
    expect(r.redact('{\\"password\\":\\"abc\\"}')).not.toContain('abc');
    expect(r.redact('{"pin":1234}')).not.toContain('1234');
    expect(r.redact('Authorization: Basic bGFucGxheTpwYXNz')).toBe(`Authorization: ${REDACTED}`);
    expect(r.redact('sunshine.exe --creds lanplay hunter22')).toBe(`sunshine.exe --creds lanplay ${REDACTED}`);
    expect(r.redact('Moonlight pair 10.0.0.2 --pin 4821')).toBe(`Moonlight pair 10.0.0.2 --pin ${REDACTED}`);
    expect(r.redact('https://user:pw@127.0.0.1:47990/api')).toBe(`https://${REDACTED}@127.0.0.1:47990/api`);
    expect(r.redactArgv(['--creds', 'lanplay', 'zzzz-pw'])).toEqual(['--creds', 'lanplay', REDACTED]);
    expect(r.redactArgv(['pair', '1.2.3.4', '--pin', '0042'])).toEqual(['pair', '1.2.3.4', '--pin', REDACTED]);
    expect(r.redactArgv(['--pin=0042'])).toEqual([`--pin=${REDACTED}`]);
  });

  it('matches a 4-digit PIN only as a whole number', () => {
    const r = new DefaultRedactor();
    r.addSecret('2026');
    expect(r.redact('pin 2026 at 2026-11-13 and 120260')).toBe(`pin ${REDACTED} at ${REDACTED}-11-13 and 120260`);
    r.addSecret('ab'); // too short: ignored
    expect(r.redact('ab')).toBe('ab');
  });

  it('redacts nested values by key', () => {
    const r = new DefaultRedactor();
    const v = r.redactValue({ a: { password: 'x', list: [{ pin: '1111' }] }, ok: 'fine' });
    expect(v).toEqual({ a: { password: REDACTED, list: [{ pin: REDACTED }] }, ok: 'fine' });
  });
});

describe('JSONL logger', () => {
  it('writes redacted JSON lines into lanplay-<date>.log', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-log-'));
    const now = new Date(2026, 10, 13, 9, 30);
    const log = createJsonlLogger({ dir, filePattern: 'lanplay-<date>.log', now: () => now });
    log.redactor.addSecret('very-secret-pw');
    log.log('info', 'main', 'started with very-secret-pw', { password: 'p', n: 1 });
    log.child('host').step({ stepId: 'credentials', title: 't', status: 'pass', startedAt: now.toISOString(), durationMs: 1, message: 'ok', commands: [{ file: 'sunshine.exe', argv: ['--creds', 'lanplay', 'very-secret-pw'], exitCode: 0, durationMs: 1, stdoutTail: '', stderrTail: '', timedOut: false }] });
    log.rest({ at: now.toISOString(), method: 'POST', url: 'https://127.0.0.1:47990/api/pin', status: 200, durationMs: 3, requestBody: '{"pin":"1234"}' });
    expect(log.currentFile()).toBe(path.join(dir, `lanplay-${localDateStamp(now)}.log`));
    const text = readFileSync(log.currentFile(), 'utf8');
    expect(text).not.toContain('very-secret-pw');
    expect(text).not.toContain('1234');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[1].scope).toBe('host.step');
    expect(lines[1].step.commands[0].argv[2]).toBe(REDACTED);
    expect(lines[0].data.password).toBe(REDACTED);
  });

  it('when today\'s file cannot be appended to (owned by an elevated run on Windows), lines go to a sibling .user.log that diagnostics also collects', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lanplay-log-ro-'));
    const now = new Date(2026, 10, 13, 9, 0, 0);
    const locked = path.join(dir, 'lanplay-2026-11-13.log');
    mkdirSync(locked); // appendFileSync on a directory fails like an access-denied file does
    const log = createJsonlLogger({ dir, filePattern: 'lanplay-<date>.log', now: () => now });
    log.log('info', 'main', 'not lost');
    expect(readFileSync(path.join(dir, 'lanplay-2026-11-13.user.log'), 'utf8')).toContain('"msg":"not lost"');
    const { recentLogFiles } = await import('../../src/core/diagnostics.js');
    writeFileSync(path.join(dir, 'lanplay-2026-11-13.elevated.log'), '{}\n');
    expect(recentLogFiles(dir, new Date()).map((f) => path.basename(f))).toEqual(expect.arrayContaining(['lanplay-2026-11-13.elevated.log', 'lanplay-2026-11-13.user.log']));
  });

  it('never throws when the directory is unwritable', () => {
    const log = createJsonlLogger({ dir: '/dev/null/nope', filePattern: 'x-<date>.log' });
    expect(() => log.log('error', 's', 'm')).not.toThrow();
  });

  it('memory logger collects entries', () => {
    const m = new MemoryLogger();
    m.child('a').log('warn', 'b', 'hello');
    expect(m.entries[0]?.scope).toBe('a.b');
  });
});

describe('ProcessRunner', () => {
  it('runs argv arrays without a shell (metacharacters stay literal)', async () => {
    const r = new NodeProcessRunner();
    const res = await r.run({ file: process.execPath, args: ['-e', 'console.log(process.argv.slice(1).join("|"))', 'a b', '$(whoami)', '; rm -rf /'], timeoutMs: 10_000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('a b|$(whoami)|; rm -rf /');
  });

  it('reports exit codes, timeouts and spawn errors', async () => {
    const r = new NodeProcessRunner();
    const bad = await r.run({ file: process.execPath, args: ['-e', 'process.stderr.write("boom"); process.exit(3)'], timeoutMs: 10_000 });
    expect(bad.exitCode).toBe(3);
    expect(bad.stderr).toBe('boom');
    const slow = await r.run({ file: process.execPath, args: ['-e', 'setTimeout(()=>{}, 5000)'], timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    const missing = await r.run({ file: '/nonexistent/binary', args: [], timeoutMs: 1000 });
    expect(missing.spawnError).toMatch(/ENOENT/);
    expect(missing.exitCode).toBeNull();
  });

  it('commandRecord redacts argv/stdout and keeps 4 KiB tails', () => {
    const r = new DefaultRedactor();
    const rec = commandRecord(
      { file: 'C:\\Program Files\\Sunshine\\sunshine.exe', args: ['--creds', 'lanplay', 'pw-abcdef'], timeoutMs: 1, secrets: ['pw-abcdef'] },
      { exitCode: 0, signal: null, stdout: 'x'.repeat(10_000) + 'pw-abcdef', stderr: '', durationMs: 5, timedOut: false },
      r,
    );
    expect(rec.argv).toEqual(['--creds', 'lanplay', REDACTED]);
    expect(rec.stdoutTail).toContain(REDACTED);
    expect(Buffer.byteLength(rec.stdoutTail)).toBeLessThanOrEqual(4096 + 20);
    expect(tail('äöü'.repeat(3000)).startsWith('…')).toBe(true);
  });
});

describe('ipnet', () => {
  it('normalizes mapped IPv6, zone ids, brackets and case', () => {
    expect(normalizeAddress('::ffff:192.168.1.20')).toBe('192.168.1.20');
    expect(normalizeAddress('::FFFF:C0A8:0114')).toBe('192.168.1.20');
    expect(normalizeAddress('0:0:0:0:0:ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeAddress('[FE80::1%en0]')).toBe('fe80::1');
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeAddress(' 10.1.2.3 ')).toBe('10.1.2.3');
    expect(normalizeAddress('64:ff9b::1.2.3.4')).toBe('64:ff9b::1.2.3.4');
  });

  it.each([
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.10.10', true],
    ['127.0.0.1', true],
    ['8.8.8.8', false],
    ['100.64.0.1', false],
    ['::1', true],
    ['fe80::abcd%en0', true],
    ['fd12:3456::1', true],
    ['2001:db8::1', false],
    ['::ffff:192.168.0.5', true],
    ['::ffff:8.8.8.8', false],
    ['::ffff:7f00:1', true],
    ['not-an-ip', false],
    ['', false],
  ])('isPrivateAddress(%s) = %s', (a, want) => {
    expect(isPrivateAddress(a)).toBe(want);
  });

  it('parses Host headers', () => {
    expect(parseHostHeader('192.168.1.5:47920')).toEqual({ host: '192.168.1.5', port: 47920 });
    expect(parseHostHeader('[fe80::1]:47920')).toEqual({ host: 'fe80::1', port: 47920 });
    expect(parseHostHeader('Gaming-PC.local:47920')).toEqual({ host: 'gaming-pc.local', port: 47920 });
    expect(parseHostHeader('evil.com')).toEqual({ host: 'evil.com', port: null });
    expect(parseHostHeader('fe80::1:47920')).toBeNull();
    expect(parseHostHeader('a:99999')).toBeNull();
    expect(parseHostHeader(undefined)).toBeNull();
  });

  it('computes subnet hosts and broadcast', () => {
    const hosts = subnetHosts('192.168.1.10', '255.255.255.0', 1024);
    expect(hosts).toHaveLength(253);
    expect(hosts).not.toContain('192.168.1.10');
    expect(hosts[0]).toBe('192.168.1.1');
    expect(subnetHosts('10.0.5.7', '255.0.0.0', 1024)).toHaveLength(253);
    expect(subnetHosts('10.0.5.7', '255.255.252.0', 100)).toHaveLength(100);
    expect(broadcastAddress('192.168.1.10', '255.255.255.0')).toBe('192.168.1.255');
  });
});

describe('timedStep', () => {
  it('turns exceptions into fail records', async () => {
    const rec = await timedStep('x', 'X', async () => {
      throw new Error('kaput');
    });
    expect(rec.status).toBe('fail');
    expect(rec.message).toContain('kaput');
  });
});
