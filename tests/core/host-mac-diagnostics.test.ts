import { describe, expect, it } from 'vitest';
import { LANPLAY, SUNSHINE_MAC } from '../../src/contracts.js';
import type { AppPaths, ExecRequest, ExecResult, ProcessRunner, SunshineClient } from '../../src/contracts.js';
import { hostDiagnosticsFilesMac, hostListenersMac, maskSunshineConf, parseLsofListeners } from '../../src/core/host/mac/diagnostics-host-mac.js';
import type { HostDiagFsMac } from '../../src/core/host/mac/diagnostics-host-mac.js';
import { plistPath } from '../../src/core/host/mac/launchd.js';
import { sunshinePaths } from '../../src/core/host/mac/sunshine-mac.js';
import { DefaultRedactor } from '../../src/core/shared/redact.js';

const HOME = '/Users/me';
const SHARED = `${HOME}/Library/Application Support/LanPlay`;
const LOGS = `${HOME}/Library/Logs/LanPlay`;
const SP = sunshinePaths(SHARED, LOGS);
const PW = 'hunter2-s3cret';
const PIN = '4821';

const PATHS = { logDir: LOGS, userData: SHARED, sharedData: SHARED, resources: '/r', vendorDir: '/r/vendor', psDir: '', diagnosticsOutDir: '/d', logDirFellBack: false } as AppPaths;

const PRINT_RUNNING = `gui/501/dev.lanplay.sunshine = {
\tactive count = 1
\tstate = running
\tpid = 4242
\tlast exit code = (never exited)
}
`;
const CODESIGN_ERR = `Identifier=dev.lizardbyte.app.Sunshine
TeamIdentifier=F8XQ7XCN2R
`;
const FIREWALL_OUT = 'Firewall is disabled. (State = 0)\n';

function res(over: Partial<ExecResult>): ExecResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 5, timedOut: false, ...over };
}

function fakeRunner(answers: Record<string, Partial<ExecResult>>): ProcessRunner & { calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  return {
    calls,
    async run(req) {
      calls.push(req);
      return res(answers[`${req.file} ${req.args.join(' ')}`] ?? { exitCode: 1, spawnError: 'no fake for this command' });
    },
  };
}

const DEFAULT_ANSWERS: Record<string, Partial<ExecResult>> = {
  '/bin/launchctl print gui/501/dev.lanplay.sunshine': { stdout: PRINT_RUNNING },
  '/bin/launchctl print gui/501/dev.lanplay.agent': { exitCode: 113, stderr: 'Could not find service "dev.lanplay.agent" in domain for user gui: 501' },
  [`/usr/bin/codesign -dvv ${SP.app}`]: { exitCode: 0, stderr: CODESIGN_ERR },
  '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate': { stdout: FIREWALL_OUT },
};

function fakeFs(files: Record<string, string>): HostDiagFsMac {
  return {
    exists: (f) => f in files,
    readTail: (f, max) => (f in files ? files[f]!.slice(-max) : null),
  };
}

const INSTALLED = JSON.stringify({ version: '2026.1115.0', dmgSha256: 'ab'.repeat(32), teamId: 'F8XQ7XCN2R', copiedAt: '2026-11-16T10:00:00.000Z' });
const CONF = `# managed by LanPlay\nlog_path = ${SP.log}\nsunshine_password = ${PW}\n`;

function fakeSunshine(over: Partial<SunshineClient> = {}): SunshineClient {
  const nope = async () => {
    throw new Error('unused');
  };
  return {
    getPendingPairings: nope,
    submitPin: nope,
    cancelPairing: nope,
    listClients: nope,
    unpairClient: nope,
    getVersion: async () => '2026.1115.0',
    getLogsTail: async () => 'api log tail',
    ...over,
  } as SunshineClient;
}

function setup(opts: { files?: Record<string, string>; answers?: Record<string, Partial<ExecResult>>; sunshine?: SunshineClient } = {}) {
  const redactor = new DefaultRedactor();
  redactor.addSecret(PW);
  redactor.addSecret(PIN);
  const runner = fakeRunner({ ...DEFAULT_ANSWERS, ...opts.answers });
  const files = opts.files ?? {
    [SP.installedJson]: INSTALLED,
    [SP.app]: '',
    [SP.conf]: CONF,
    [SP.log]: 'sunshine log line\n',
    [SP.launchdLog]: 'launchd stderr line\n',
    [SP.pinnedCert]: 'PEM',
    [plistPath(HOME, SUNSHINE_MAC.launchdLabel)]: '<plist>sunshine</plist>',
    [plistPath(HOME, SUNSHINE_MAC.agentLaunchdLabel)]: '<plist>agent</plist>',
  };
  const deps = { runner, redactor, paths: PATHS, fs: fakeFs(files), sunshine: opts.sunshine ?? fakeSunshine(), home: HOME, uid: 501 };
  return { deps, runner };
}

const byName = (files: Array<{ name: string; text: string }>, name: string) => files.find((f) => f.name === name)?.text;

describe('hostDiagnosticsFilesMac', () => {
  it('produces the documented file set', async () => {
    const { deps } = setup();
    const files = await hostDiagnosticsFilesMac(deps);
    expect(files.map((f) => f.name).sort()).toEqual(
      [
        'firewall.json',
        'host-commands.json',
        'launchagents/dev.lanplay.agent.plist',
        'launchagents/dev.lanplay.sunshine.plist',
        'logs/sunshine-launchd.log',
        'logs/sunshine.log',
        'sunshine.json',
      ].sort(),
    );
  });

  it('sunshine.json carries install record, launchd state of both jobs, codesign and API version', async () => {
    const { deps } = setup();
    const j = JSON.parse(byName(await hostDiagnosticsFilesMac(deps), 'sunshine.json')!);
    expect(j.installed).toMatchObject({ version: '2026.1115.0', teamId: 'F8XQ7XCN2R' });
    expect(j.launchd[SUNSHINE_MAC.launchdLabel].job).toMatchObject({ loaded: true, state: 'running', pid: 4242 });
    expect(j.launchd[SUNSHINE_MAC.launchdLabel].raw).toContain('state = running');
    expect(j.launchd[SUNSHINE_MAC.agentLaunchdLabel].job.loaded).toBe(false);
    expect(j.launchd[SUNSHINE_MAC.agentLaunchdLabel].stderr).toContain('Could not find service');
    expect(j.codesign).toMatchObject({ identifier: 'dev.lizardbyte.app.Sunshine', teamId: 'F8XQ7XCN2R' });
    expect(j.pinnedCertPresent).toBe(true);
    expect(j.apiVersion).toBe('2026.1115.0');
  });

  it('keeps the conf but masks secret values, and never the redactor-known password anywhere', async () => {
    const { deps } = setup();
    const files = await hostDiagnosticsFilesMac(deps);
    const j = JSON.parse(byName(files, 'sunshine.json')!);
    expect(j.sunshineConf).toContain(`log_path = ${SP.log}`);
    expect(j.sunshineConf).toContain('sunshine_password = [REDACTED]');
    for (const f of files) expect(f.text, f.name).not.toContain(PW);
  });

  it('redacts a registered password and PIN that appear in copied logs and command output', async () => {
    const { deps } = setup({
      files: {
        [SP.log]: `pin ${PIN} accepted; Authorization: Basic c3VuOnB3\ncreds --creds sun ${PW}\n`,
        [SP.launchdLog]: `argv leaked ${PW}\n`,
        [SP.app]: '',
      },
      answers: { '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate': { stdout: `weird ${PW}` } },
    });
    const files = await hostDiagnosticsFilesMac(deps);
    for (const f of files) {
      expect(f.text, f.name).not.toContain(PW);
      expect(f.text, f.name).not.toMatch(new RegExp(`(?<![0-9])${PIN}(?![0-9])`));
      expect(f.text, f.name).not.toContain('c3VuOnB3');
    }
  });

  it('tails logs to LANPLAY.diagnosticsTailBytes', async () => {
    const big = 'x'.repeat(LANPLAY.diagnosticsTailBytes + 500);
    const { deps } = setup({ files: { [SP.log]: big, [SP.app]: '' } });
    const log = byName(await hostDiagnosticsFilesMac(deps), 'logs/sunshine.log')!;
    expect(log.length).toBe(LANPLAY.diagnosticsTailBytes);
  });

  it('reads log_path from the conf when it differs from the managed one', async () => {
    const other = '/elsewhere/sun.log';
    const { deps } = setup({ files: { [SP.conf]: `log_path = "${other}"\n`, [other]: 'custom log\n', [SP.log]: 'managed log\n', [SP.app]: '' } });
    expect(byName(await hostDiagnosticsFilesMac(deps), 'logs/sunshine.log')).toBe('custom log\n');
  });

  it('falls back to GET /api/logs when the log file is unreadable, and says so when both fail', async () => {
    const { deps } = setup({ files: { [SP.app]: '' } });
    expect(byName(await hostDiagnosticsFilesMac(deps), 'logs/sunshine.log')).toBe('(via GET /api/logs)\napi log tail');
    const { deps: d2 } = setup({ files: { [SP.app]: '' }, sunshine: fakeSunshine({ getLogsTail: async () => Promise.reject(new Error('401')) }) });
    expect(byName(await hostDiagnosticsFilesMac(d2), 'logs/sunshine.log')).toBe('sunshine.log unavailable: 401');
  });

  it('survives a missing install, absent logs and an unreachable API', async () => {
    const { deps } = setup({
      files: {},
      sunshine: fakeSunshine({ getVersion: async () => Promise.reject(new Error('ECONNREFUSED')), getLogsTail: async () => Promise.reject(new Error('ECONNREFUSED')) }),
    });
    const files = await hostDiagnosticsFilesMac(deps);
    const j = JSON.parse(byName(files, 'sunshine.json')!);
    expect(j.installed).toBeNull();
    expect(j.sunshineConf).toBeNull();
    expect(j.pinnedCertPresent).toBe(false);
    expect(j.codesign).toBeNull();
    expect(j.apiVersion).toEqual({ error: 'ECONNREFUSED' });
    expect(files.some((f) => f.name.startsWith('launchagents/'))).toBe(false);
    expect(files.some((f) => f.name === 'logs/sunshine-launchd.log')).toBe(false);
  });

  it('keeps the raw text of an installed.json it cannot parse', async () => {
    const { deps } = setup({ files: { [SP.installedJson]: '{oops', [SP.app]: '' } });
    const j = JSON.parse(byName(await hostDiagnosticsFilesMac(deps), 'sunshine.json')!);
    expect(j.installed).toBeNull();
    expect(j.installedUnparsed).toBe('{oops');
  });

  it('records every process it ran, argv only, in host-commands.json', async () => {
    const { deps, runner } = setup();
    const files = await hostDiagnosticsFilesMac(deps);
    const cmds = JSON.parse(byName(files, 'host-commands.json')!) as Array<{ file: string; argv: string[]; exitCode: number | null }>;
    expect(cmds.map((c) => [c.file, ...c.argv].join(' '))).toEqual(runner.calls.map((c) => [c.file, ...c.args].join(' ')));
    expect(cmds).toHaveLength(4);
    expect(cmds.find((c) => c.argv[0] === 'print' && c.argv[1]!.endsWith('agent'))!.exitCode).toBe(113);
  });

  it('firewall.json holds the socketfilterfw answer', async () => {
    const { deps } = setup();
    const j = JSON.parse(byName(await hostDiagnosticsFilesMac(deps), 'firewall.json')!);
    expect(j).toMatchObject({ ok: true, state: 'Firewall is disabled. (State = 0)' });
  });

  it('records a spawn failure instead of throwing', async () => {
    const { deps } = setup({ answers: { '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate': { exitCode: null, spawnError: 'ENOENT' } } });
    const j = JSON.parse(byName(await hostDiagnosticsFilesMac(deps), 'firewall.json')!);
    expect(j).toMatchObject({ ok: false, error: 'ENOENT' });
  });
});

describe('maskSunshineConf', () => {
  it('masks values of password-like keys only and leaves comments and paths', () => {
    const out = maskSunshineConf('# pw = abc\nsunshine_password=abc\nPassword = "x y"\napi_token = t0k\nresolutions = [1920x1080]\ncredentials_file = /a/b.json\nsalt=zz\n');
    expect(out).toBe('# pw = abc\nsunshine_password = [REDACTED]\nPassword = [REDACTED]\napi_token = [REDACTED]\nresolutions = [1920x1080]\ncredentials_file = /a/b.json\nsalt = [REDACTED]\n');
  });
});

describe('listeners', () => {
  const LSOF = ['p100', 'claunchd', 'n*:5000', 'p4242', 'cSunshine', 'n*:47989', 'n*:47990', 'n127.0.0.1:47984', 'n[::1]:48010', 'n*:9999', ''].join('\n');

  it('parseLsofListeners keeps only the ports LanPlay cares about', () => {
    expect(parseLsofListeners(LSOF, [47984, 47989, 47990, 48010])).toEqual([
      { port: 47989, pid: 4242, command: 'Sunshine', address: '*' },
      { port: 47990, pid: 4242, command: 'Sunshine', address: '*' },
      { port: 47984, pid: 4242, command: 'Sunshine', address: '127.0.0.1' },
      { port: 48010, pid: 4242, command: 'Sunshine', address: '[::1]' },
    ]);
  });

  it('hostListenersMac runs lsof and returns {ok,error,result} like the Windows one', async () => {
    const runner = fakeRunner({ '/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -Fpcn': { stdout: LSOF } });
    const r = (await hostListenersMac({ runner })) as { ok: boolean; result: Array<{ port: number }> };
    expect(r.ok).toBe(true);
    expect(r.result.map((x) => x.port).sort()).toEqual([47984, 47989, 47990, 48010]);
  });

  it('treats the silent exit 1 of an idle machine as an empty list, not a failure', async () => {
    const runner = fakeRunner({ '/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -Fpcn': { exitCode: 1 } });
    expect(await hostListenersMac({ runner })).toEqual({ ok: true, result: [] });
  });

  it('reports a failed lsof', async () => {
    const runner = fakeRunner({ '/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -Fpcn': { exitCode: 1, stderr: 'boom' } });
    expect(await hostListenersMac({ runner })).toMatchObject({ ok: false, error: 'boom' });
  });
});
