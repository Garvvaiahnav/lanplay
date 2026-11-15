import { describe, expect, it } from 'vitest';
import { SUNSHINE_MAC } from '../../src/contracts.js';
import {
  bootoutArgv,
  bootstrapArgv,
  buildAgentPlist,
  kickstartArgv,
  lanplayAgentSpec,
  parseLaunchctlPrint,
  plistPath,
  printArgv,
} from '../../src/core/host/mac/launchd.js';

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n';

describe('buildAgentPlist', () => {
  it('writes the Sunshine profile: KeepAlive, throttle, interactive, log files', () => {
    const xml = buildAgentPlist({
      label: SUNSHINE_MAC.launchdLabel,
      program: '/Users/me/Library/Application Support/LanPlay/sunshine/Sunshine.app/Contents/MacOS/Sunshine',
      args: ['/Users/me/Library/Application Support/LanPlay/sunshine/sunshine.conf'],
      keepAlive: true,
      stdoutPath: '/Users/me/Library/Logs/LanPlay/sunshine-launchd.log',
      stderrPath: '/Users/me/Library/Logs/LanPlay/sunshine-launchd.log',
    });
    expect(xml).toBe(
      HEAD +
        '\t<key>Label</key>\n\t<string>dev.lanplay.sunshine</string>\n' +
        '\t<key>ProgramArguments</key>\n\t<array>\n' +
        '\t\t<string>/Users/me/Library/Application Support/LanPlay/sunshine/Sunshine.app/Contents/MacOS/Sunshine</string>\n' +
        '\t\t<string>/Users/me/Library/Application Support/LanPlay/sunshine/sunshine.conf</string>\n' +
        '\t</array>\n' +
        '\t<key>RunAtLoad</key>\n\t<true/>\n' +
        '\t<key>KeepAlive</key>\n\t<true/>\n' +
        '\t<key>ThrottleInterval</key>\n\t<integer>10</integer>\n' +
        '\t<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>\n' +
        '\t<key>ProcessType</key>\n\t<string>Interactive</string>\n' +
        '\t<key>StandardOutPath</key>\n\t<string>/Users/me/Library/Logs/LanPlay/sunshine-launchd.log</string>\n' +
        '\t<key>StandardErrorPath</key>\n\t<string>/Users/me/Library/Logs/LanPlay/sunshine-launchd.log</string>\n' +
        '</dict>\n</plist>\n',
    );
  });

  it('writes the LanPlay agent profile without KeepAlive so the updater can quit it', () => {
    const xml = buildAgentPlist(lanplayAgentSpec('/Applications/LanPlay.app/Contents/MacOS/LanPlay'));
    expect(xml).toBe(
      HEAD +
        '\t<key>Label</key>\n\t<string>dev.lanplay.agent</string>\n' +
        '\t<key>ProgramArguments</key>\n\t<array>\n' +
        '\t\t<string>/Applications/LanPlay.app/Contents/MacOS/LanPlay</string>\n' +
        '\t\t<string>--agent</string>\n' +
        '\t</array>\n' +
        '\t<key>RunAtLoad</key>\n\t<true/>\n' +
        '\t<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>\n' +
        '</dict>\n</plist>\n',
    );
    expect(xml).not.toContain('KeepAlive');
  });

  it('escapes & < > in every value and keeps spaces verbatim', () => {
    const xml = buildAgentPlist({
      label: 'dev.lanplay.x',
      program: '/Users/A&B <Co>/My Apps/Sun>shine',
      args: ['--name=a&b', '<c>'],
      keepAlive: false,
      stdoutPath: '/tmp/a & b/out.log',
    });
    expect(xml).toContain('<string>/Users/A&amp;B &lt;Co&gt;/My Apps/Sun&gt;shine</string>');
    expect(xml).toContain('<string>--name=a&amp;b</string>');
    expect(xml).toContain('<string>&lt;c&gt;</string>');
    expect(xml).toContain('<string>/tmp/a &amp; b/out.log</string>');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(xml).not.toContain('StandardErrorPath');
  });

  it('does not double-escape an existing entity text', () => {
    expect(buildAgentPlist({ label: 'l', program: '/p', args: ['&amp;'], keepAlive: false })).toContain('<string>&amp;amp;</string>');
  });
});

describe('plistPath and argv builders', () => {
  it('puts the plist in the per-user LaunchAgents folder', () => {
    expect(plistPath('/Users/me', 'dev.lanplay.sunshine')).toBe('/Users/me/Library/LaunchAgents/dev.lanplay.sunshine.plist');
  });

  it('builds launchctl calls for the gui/<uid> domain as argv arrays', () => {
    const plist = '/Users/me/Library/LaunchAgents/a b.plist';
    expect(bootstrapArgv(501, plist)).toEqual({ file: '/bin/launchctl', args: ['bootstrap', 'gui/501', plist] });
    expect(bootoutArgv(501, 'dev.lanplay.sunshine')).toEqual({ file: '/bin/launchctl', args: ['bootout', 'gui/501/dev.lanplay.sunshine'] });
    expect(printArgv(501, 'dev.lanplay.sunshine')).toEqual({ file: '/bin/launchctl', args: ['print', 'gui/501/dev.lanplay.sunshine'] });
    expect(kickstartArgv(501, 'dev.lanplay.sunshine', false)).toEqual({ file: '/bin/launchctl', args: ['kickstart', 'gui/501/dev.lanplay.sunshine'] });
    expect(kickstartArgv(501, 'dev.lanplay.sunshine', true)).toEqual({ file: '/bin/launchctl', args: ['kickstart', '-k', 'gui/501/dev.lanplay.sunshine'] });
  });

  it.each([-1, 1.5, Number.NaN])('rejects uid %s', (uid) => {
    expect(() => printArgv(uid, 'x')).toThrow(/uid/);
  });
});

// Shaped like `launchctl print gui/501/<label>` on macOS 26 (the Finder fixture is verbatim output trimmed to the
// interesting keys; nested blocks keep their deeper indentation, which the parser must not read).
const RUNNING = [
  'gui/501/dev.lanplay.sunshine = {',
  '\tactive count = 1',
  '\tpath = /Users/me/Library/LaunchAgents/dev.lanplay.sunshine.plist',
  '\ttype = LaunchAgent',
  '\tstate = running',
  '',
  '\tprogram = /Users/me/Library/Application Support/LanPlay/sunshine/Sunshine.app/Contents/MacOS/Sunshine',
  '\targuments = {',
  '\t\t/Users/me/Library/Application Support/LanPlay/sunshine/Sunshine.app/Contents/MacOS/Sunshine',
  '\t\t/Users/me/Library/Application Support/LanPlay/sunshine/sunshine.conf',
  '\t}',
  '',
  '\tdomain = gui/501 [100002]',
  '\tminimum runtime = 1',
  '\truns = 1',
  '\tpid = 4242',
  '\timmediate reason = ipc (mach)',
  '\tlast exit code = (never exited)',
  '',
  '\tendpoints = {',
  '\t\t"dev.lanplay.sunshine" = {',
  '\t\t\tport = 0x1b03',
  '\t\t\tactive = 1',
  '\t\t\tpid = 1',
  '\t\t\tstate = active',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

const EXITED_WITH_CODE = [
  'gui/501/dev.lanplay.sunshine = {',
  '\tactive count = 0',
  '\ttype = LaunchAgent',
  '\tstate = not running',
  '',
  '\tdomain = gui/501 [100002]',
  '\texit timeout = 5',
  '\truns = 7',
  '\tlast exit code = 1',
  '',
  '\tendpoints = {',
  '\t\t"x" = {',
  '\t\t\tstate = active',
  '\t\t\tpid = 77',
  '\t\t}',
  '\t}',
  '\tproperties = keepalive | exponential throttling',
  '}',
  '',
].join('\n');

const KILLED_BY_SIGNAL = [
  'gui/501/dev.lanplay.sunshine = {',
  '\tstate = spawn scheduled',
  '\truns = 3',
  '\tlast exit code = (never exited)',
  '\tlast terminating signal = Segmentation fault: 11',
  '}',
  '',
].join('\n');

const LOADED_NEVER_RUN = [
  'gui/501/dev.lanplay.agent = {',
  '\tstate = not running',
  '\truns = 0',
  '\tlast exit code = (never exited)',
  '}',
  '',
].join('\n');

describe('parseLaunchctlPrint', () => {
  it('reads a running job: state, pid, no exit yet', () => {
    expect(parseLaunchctlPrint(RUNNING)).toEqual({ loaded: true, state: 'running', pid: 4242, lastExitCode: null, lastSignal: null });
  });

  it('reads the exit code of a job that stopped, ignoring state and pid inside nested blocks', () => {
    expect(parseLaunchctlPrint(EXITED_WITH_CODE)).toEqual({ loaded: true, state: 'not running', pid: null, lastExitCode: 1, lastSignal: null });
  });

  it('reads the terminating signal of a crashed job waiting to respawn', () => {
    expect(parseLaunchctlPrint(KILLED_BY_SIGNAL)).toEqual({ loaded: true, state: 'spawn scheduled', pid: null, lastExitCode: null, lastSignal: 'Segmentation fault: 11' });
  });

  it('reads a loaded job that never ran', () => {
    expect(parseLaunchctlPrint(LOADED_NEVER_RUN)).toEqual({ loaded: true, state: 'not running', pid: null, lastExitCode: null, lastSignal: null });
  });

  it('reads a zero exit code as 0, not as missing', () => {
    expect(parseLaunchctlPrint(EXITED_WITH_CODE.replace('last exit code = 1', 'last exit code = 0')).lastExitCode).toBe(0);
  });

  it.each([
    ['empty stdout (the error text goes to stderr)', ''],
    ['the error text if a caller merged stderr', 'Bad request.\nCould not find service "dev.lanplay.sunshine" in domain for user gui: 501\n'],
  ])('reports not loaded for %s', (_n, out) => {
    expect(parseLaunchctlPrint(out)).toEqual({ loaded: false, state: null, pid: null, lastExitCode: null, lastSignal: null });
  });

  it('copes with CRLF output', () => {
    expect(parseLaunchctlPrint(RUNNING.replace(/\n/g, '\r\n')).pid).toBe(4242);
  });
});
