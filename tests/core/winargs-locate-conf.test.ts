import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sunshineManagedConfig } from '../../src/contracts.js';
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

  it('runs .bat through cmd.exe by bare name with cwd = its folder (no path on the cmd line to mis-quote)', () => {
    expect(buildBatArgv('C:\\Windows', 'C:\\Program Files\\Sunshine\\scripts\\install-service.bat')).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/c', 'install-service.bat'],
      cwd: 'C:\\Program Files\\Sunshine\\scripts',
    });
    // cmd.exe drops the quotes around a path that contains ( ) & etc: those paths must still work.
    for (const dir of ['C:\\Program Files (x86)\\Sunshine\\scripts', 'D:\\Spiele & Tools\\Sunshine\\scripts', 'C:\\Users\\山田\\Sunshine 100%\\scripts']) {
      const r = buildBatArgv('C:\\Windows', `${dir}\\add-firewall-rule.bat`);
      expect(r.args).toEqual(['/d', '/c', 'add-firewall-rule.bat']);
      expect(r.cwd).toBe(dir);
      expect(r.args.join('')).not.toMatch(/[\s"&()%^]/);
    }
    expect(() => buildBatArgv('C:\\Windows', 'C:\\x\\evil & calc.bat')).toThrow();
    expect(() => buildBatArgv('C:\\Windows', 'C:\\x\\a b.bat')).toThrow();
    expect(() => buildBatArgv('C:\\Windows', 'C:\\x\\tool.exe')).toThrow();
    expect(() => buildBatArgv('C:\\Windows', 'install-service.bat')).toThrow();
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

const SUNSHINE_MANAGED_CONFIG = sunshineManagedConfig(false);

describe('mergeSunshineConf', () => {
  it('adds managed keys to an empty file and is idempotent', () => {
    const a = mergeSunshineConf('', SUNSHINE_MANAGED_CONFIG);
    expect(a.changed).toBe(true);
    expect(parseSunshineConf(a.text)).toEqual({ ...SUNSHINE_MANAGED_CONFIG });
    const b = mergeSunshineConf(a.text, SUNSHINE_MANAGED_CONFIG);
    expect(b).toEqual({ text: a.text, changed: false });
  });

  it('reads sunshine.conf like Sunshine does: first occurrence wins, text after # is a comment; our value always ends up effective', () => {
    expect(parseSunshineConf('upnp = enabled # router\nupnp = disabled\n#hevc_mode = 3\nsunshine_name = Büro PC\n')).toEqual({ upnp: 'enabled', sunshine_name: 'Büro PC' });
    // a user file where an EARLIER duplicate and an inline comment would beat a naive "append our keys" merge
    const user = 'origin_web_ui_allowed = wan # I like danger\r\nupnp = on\r\nupnp = disabled\r\nav1_mode = 0\r\n';
    const m = mergeSunshineConf(user, SUNSHINE_MANAGED_CONFIG);
    expect(m.changed).toBe(true);
    expect(parseSunshineConf(m.text)).toMatchObject({ ...SUNSHINE_MANAGED_CONFIG });
    expect(mergeSunshineConf(m.text, SUNSHINE_MANAGED_CONFIG).changed).toBe(false);
  });

  it('keeps unknown keys, comments, order and CRLF; replaces + dedupes managed keys', () => {
    const src = '# my config\r\nsunshine_name = Gaming PC\r\norigin_web_ui_allowed = wan\r\nencoder = nvenc\r\nupnp = enabled\r\nupnp = enabled\r\n';
    const r = mergeSunshineConf(src, SUNSHINE_MANAGED_CONFIG);
    expect(r.changed).toBe(true);
    expect(r.text).toBe('# my config\r\nsunshine_name = Gaming PC\r\norigin_web_ui_allowed = pc\r\nencoder = nvenc\r\nupnp = disabled\r\naddress_family = ipv4\r\nhevc_mode = 0\r\nav1_mode = 0\r\n');
    expect(mergeSunshineConf(r.text, SUNSHINE_MANAGED_CONFIG).changed).toBe(false);
  });

  it('keeps a BOM and treats already-correct files as unchanged', () => {
    const src = '\uFEFForigin_web_ui_allowed = pc\nupnp = disabled\naddress_family = ipv4\nhevc_mode = 0\nav1_mode = 0\n';
    expect(mergeSunshineConf(src, SUNSHINE_MANAGED_CONFIG).changed).toBe(false);
  });

  it('writes the internet-on values (D08) and switches back off cleanly, keeping the admin page on this PC (D09)', () => {
    const on = sunshineManagedConfig(true);
    expect(on).toMatchObject({ origin_web_ui_allowed: 'pc', upnp: 'enabled', address_family: 'both', hevc_mode: '0', av1_mode: '0' });
    const off = sunshineManagedConfig(false);
    expect(off).toMatchObject({ origin_web_ui_allowed: 'pc', upnp: 'disabled', address_family: 'ipv4' });
    const src = '# mine\nsunshine_name = PC\nupnp = disabled\naddress_family = ipv4\n';
    const a = mergeSunshineConf(src, on);
    expect(a.changed).toBe(true);
    expect(parseSunshineConf(a.text)).toMatchObject({ sunshine_name: 'PC', upnp: 'enabled', address_family: 'both', origin_web_ui_allowed: 'pc' });
    expect(mergeSunshineConf(a.text, on).changed).toBe(false);
    const b = mergeSunshineConf(a.text, off);
    expect(b.changed).toBe(true);
    expect(parseSunshineConf(b.text)).toMatchObject({ sunshine_name: 'PC', upnp: 'disabled', address_family: 'ipv4' });
  });
});
