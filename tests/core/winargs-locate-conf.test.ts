import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUNSHINE_MANAGED_CONFIG } from '../../src/contracts.js';
import type { SunshineFactsPs } from '../../src/contracts.js';
import { buildBatArgv, buildMsiexecArgs, buildPsArgv, parseWindowsCommandLine, quoteWindowsArg } from '../../src/core/host/winargs.js';
import { applyLogPathOverride, findNsisInstall, locateSunshine, rootFromServiceExe, servicePathToExe } from '../../src/core/host/sunshine-locate.js';
import { mergeSunshineConf, parseSunshineConf } from '../../src/core/host/sunshine-conf.js';

const w = path.win32;

const NASTY = [
  'C:\\Program Files\\Sunshine',
  'C:\\Program Files\\Sunshine\\',
  'C:\\Users\\Jörg Müller\\Downloads\\LanPlay\\LanPlay.exe',
  'C:\\Users\\山田\\AppData\\Local\\Temp\\lanplay-handoff.json',
  'C:\\Users\\O\'Brien & Co\\x',
  'say "hi"',
  'trailing\\\\',
  'a\\"b',
  '',
  'plain',
  'tab\there',
  '--host-setup',
];

describe('quoteWindowsArg', () => {
  it.each(NASTY)('round-trips %j through CommandLineToArgvW rules', (arg) => {
    expect(parseWindowsCommandLine(quoteWindowsArg(arg))).toEqual([arg]);
  });

  it('round-trips a whole elevated argv', () => {
    const argv = ['--host-setup', '--handoff', 'C:\\Users\\Jörg Müller\\AppData\\Local\\Temp\\h.json', '--result', 'C:\\Users\\山田\\r.json'];
    expect(parseWindowsCommandLine(argv.map(quoteWindowsArg).join(' '))).toEqual(argv);
  });

  it('leaves simple args alone and quotes spaces', () => {
    expect(quoteWindowsArg('abc')).toBe('abc');
    expect(quoteWindowsArg('C:\\Program Files\\Sunshine\\')).toBe('"C:\\Program Files\\Sunshine\\\\"');
  });
});

describe('buildPsArgv / msiexec / bat', () => {
  it('uses absolute Windows PowerShell 5.1 and argv pairs', () => {
    const { file, args } = buildPsArgv('C:\\Windows', 'C:\\Users\\Jörg Müller\\LanPlay\\resources\\ps', {
      script: 'get-listeners',
      params: { Ports: [47984, 47989], Name: 'LanPlay Pair Agent', Verbose: true },
      timeoutMs: 1000,
    });
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      'C:\\Users\\Jörg Müller\\LanPlay\\resources\\ps\\get-listeners.ps1',
      '-Ports', '47984,47989', '-Name', 'LanPlay Pair Agent', '-Verbose', '1',
    ]);
    expect(() => buildPsArgv('C:\\Windows', 'x', { script: 'test-admin', params: { 'bad name': 1 }, timeoutMs: 1 })).toThrow();
  });

  it('builds msiexec args with paths containing spaces', () => {
    const r = buildMsiexecArgs('C:\\Windows', 'C:\\Program Files\\LanPlay\\resources\\vendor\\Sunshine-Windows-AMD64-installer.msi', 'C:\\ProgramData\\LanPlay\\logs\\msiexec-1.log');
    expect(r.file).toBe('C:\\Windows\\System32\\msiexec.exe');
    expect(r.args).toEqual(['/i', 'C:\\Program Files\\LanPlay\\resources\\vendor\\Sunshine-Windows-AMD64-installer.msi', '/qn', '/norestart', '/l*v', 'C:\\ProgramData\\LanPlay\\logs\\msiexec-1.log']);
  });

  it('runs .bat through cmd.exe and refuses metacharacters', () => {
    expect(buildBatArgv('C:\\Windows', 'C:\\Program Files\\Sunshine\\scripts\\install-service.bat')).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/c', 'C:\\Program Files\\Sunshine\\scripts\\install-service.bat'],
    });
    expect(() => buildBatArgv('C:\\Windows', 'C:\\a&b\\x.bat')).toThrow();
  });
});

const facts = (over: Partial<SunshineFactsPs> = {}): SunshineFactsPs => ({
  service: null,
  uninstallEntries: [],
  env: { ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
  ...over,
});
const existsSet = (...roots: string[]) => (p: string) => roots.some((r) => w.join(r, 'sunshine.exe').toLowerCase() === p.toLowerCase());

describe('locateSunshine', () => {
  it('prefers the service binPath (quoted, with args)', () => {
    expect(servicePathToExe('"D:\\Games\\Sun Shine\\tools\\sunshinesvc.exe" --flag')).toBe('D:\\Games\\Sun Shine\\tools\\sunshinesvc.exe');
    expect(servicePathToExe('C:\\S\\tools\\sunshinesvc.exe -x')).toBe('C:\\S\\tools\\sunshinesvc.exe');
    expect(rootFromServiceExe('D:\\Games\\Sun Shine\\tools\\sunshinesvc.exe')).toBe('D:\\Games\\Sun Shine');
    expect(rootFromServiceExe('C:\\other.exe')).toBeNull();
    const inst = locateSunshine(
      facts({ service: { name: 'SunshineService', pathName: '"D:\\Games\\Sun Shine\\tools\\sunshinesvc.exe"', startMode: 'Auto', state: 'Running' } }),
      existsSet('D:\\Games\\Sun Shine'),
    );
    expect(inst).toMatchObject({
      root: 'D:\\Games\\Sun Shine',
      exe: 'D:\\Games\\Sun Shine\\sunshine.exe',
      serviceExe: 'D:\\Games\\Sun Shine\\tools\\sunshinesvc.exe',
      configFile: 'D:\\Games\\Sun Shine\\config\\sunshine.conf',
      certFile: 'D:\\Games\\Sun Shine\\config\\credentials\\cacert.pem',
      logFile: 'D:\\Games\\Sun Shine\\config\\sunshine.log',
      foundVia: 'service-binpath',
    });
  });

  it('falls back to the uninstall registry (trailing backslash, non-ASCII)', () => {
    const inst = locateSunshine(
      facts({ uninstallEntries: [{ displayName: 'Sunshine', displayVersion: '2026.914.233613', installLocation: 'C:\\Users\\山田\\Apps\\Sunshine\\' }] }),
      existsSet('C:\\Users\\山田\\Apps\\Sunshine'),
    );
    expect(inst?.root).toBe('C:\\Users\\山田\\Apps\\Sunshine');
    expect(inst?.foundVia).toBe('uninstall-registry');
    expect(inst?.version).toBe('2026.914.233613');
  });

  it('falls back to ProgramFiles paths and returns null when nothing exists', () => {
    expect(locateSunshine(facts(), existsSet('C:\\Program Files (x86)\\Sunshine'))?.foundVia).toBe('fallback-path');
    expect(locateSunshine(facts(), existsSet('C:\\Program Files\\Sunshine'))?.root).toBe('C:\\Program Files\\Sunshine');
    expect(locateSunshine(facts(), () => false)).toBeNull();
    // service pointing to a deleted folder -> next source
    expect(
      locateSunshine(facts({ service: { name: 'SunshineService', pathName: '"E:\\gone\\tools\\sunshinesvc.exe"', startMode: 'Auto', state: 'Stopped' } }), existsSet('C:\\Program Files\\Sunshine'))?.foundVia,
    ).toBe('fallback-path');
  });

  it('detects an old NSIS install', () => {
    expect(findNsisInstall(facts({ uninstallEntries: [{ displayName: 'Sunshine', uninstallString: '"C:\\Program Files\\Sunshine\\uninstall.exe"' }] }))).not.toBeNull();
    expect(findNsisInstall(facts({ uninstallEntries: [{ displayName: 'Sunshine', uninstallString: 'MsiExec.exe /X{1234}' }] }))).toBeNull();
  });

  it('honours log_path overrides', () => {
    const inst = locateSunshine(facts(), existsSet('C:\\Program Files\\Sunshine'))!;
    expect(applyLogPathOverride(inst, 'log_path = logs\\s.log\n').logFile).toBe('C:\\Program Files\\Sunshine\\config\\logs\\s.log');
    expect(applyLogPathOverride(inst, 'log_path = D:\\x.log').logFile).toBe('D:\\x.log');
  });
});

describe('mergeSunshineConf', () => {
  it('adds managed keys to an empty file and is idempotent', () => {
    const a = mergeSunshineConf('', SUNSHINE_MANAGED_CONFIG);
    expect(a.changed).toBe(true);
    expect(parseSunshineConf(a.text)).toEqual({ ...SUNSHINE_MANAGED_CONFIG });
    const b = mergeSunshineConf(a.text, SUNSHINE_MANAGED_CONFIG);
    expect(b).toEqual({ text: a.text, changed: false });
  });

  it('keeps unknown keys, comments, order and CRLF; replaces + dedupes managed keys', () => {
    const src = '# my config\r\nsunshine_name = Gaming PC\r\norigin_web_ui_allowed = wan\r\nencoder = nvenc\r\nupnp = enabled\r\nupnp = enabled\r\n';
    const r = mergeSunshineConf(src, SUNSHINE_MANAGED_CONFIG);
    expect(r.changed).toBe(true);
    expect(r.text).toBe('# my config\r\nsunshine_name = Gaming PC\r\norigin_web_ui_allowed = lan\r\nencoder = nvenc\r\nupnp = disabled\r\nhevc_mode = 0\r\nav1_mode = 0\r\n');
    expect(mergeSunshineConf(r.text, SUNSHINE_MANAGED_CONFIG).changed).toBe(false);
  });

  it('keeps a BOM and treats already-correct files as unchanged', () => {
    const src = '\uFEFForigin_web_ui_allowed = lan\nupnp = disabled\nhevc_mode = 0\nav1_mode = 0\n';
    expect(mergeSunshineConf(src, SUNSHINE_MANAGED_CONFIG).changed).toBe(false);
  });
});
