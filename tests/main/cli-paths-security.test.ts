import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS, SECURITY } from '../../src/contracts.js';
import { computeAppPaths } from '../../src/core/paths.js';
import { defaultRole, parseCli } from '../../src/main/cli.js';
import { isAllowedAppUrl, isAllowedExternalUrl } from '../../src/main/security.js';

describe('parseCli', () => {
  it('parses each mode', () => {
    expect(parseCli([]).mode).toBe('gui');
    expect(parseCli(['--self-check', '--role', 'host'])).toMatchObject({ mode: 'self-check', role: 'host' });
    expect(parseCli(['--diagnostics', '--out', '/Users/x/Desktop'])).toMatchObject({ mode: 'diagnostics', out: '/Users/x/Desktop' });
    expect(parseCli(['--agent', '-psn_0_12345'])).toMatchObject({ mode: 'agent', ignored: ['-psn_0_12345'] });
    expect(
      parseCli(['--host-setup', '--handoff', 'C:\\Users\\Jörg Müller\\AppData\\Local\\Temp\\h.json', '--result', 'C:\\Users\\山田\\r.json'], 'win32'),
    ).toMatchObject({ mode: 'host-setup', handoff: 'C:\\Users\\Jörg Müller\\AppData\\Local\\Temp\\h.json', result: 'C:\\Users\\山田\\r.json' });
  });
  it('rejects bad combinations and values', () => {
    expect(() => parseCli(['--self-check', '--diagnostics'])).toThrow();
    expect(() => parseCli(['--role', 'server'])).toThrow();
    expect(() => parseCli(['--host-setup', '--handoff', 'C:\\h.json'], 'win32')).toThrow();
    expect(() => parseCli(['--host-setup', '--handoff', 'h.json', '--result', 'C:\\r.json'], 'win32')).toThrow();
    expect(() => parseCli(['--out'])).toThrow();
    expect(() => parseCli(['--out', 'relative'])).toThrow();
  });
  it('default role by platform', () => {
    expect(defaultRole('win32')).toBe('host');
    expect(defaultRole('darwin')).toBe('client');
  });
});

describe('computeAppPaths', () => {
  const base = { homedir: 'C:\\Users\\Jörg Müller', userData: 'C:\\Users\\Jörg Müller\\AppData\\Roaming\\LanPlay', desktop: 'C:\\Users\\Jörg Müller\\Desktop', resourcesPath: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay-win\\resources', appRoot: 'C:\\src\\lanplay' };
  it('Windows packaged: ProgramData logs, resources\\vendor, resources\\ps', () => {
    const p = computeAppPaths({ ...base, platform: 'win32', env: { ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\Jörg Müller\\AppData\\Local' }, isPackaged: true, canWrite: () => true });
    expect(p).toEqual({
      logDir: 'C:\\ProgramData\\LanPlay\\logs',
      userData: base.userData,
      sharedData: 'C:\\ProgramData\\LanPlay',
      resources: base.resourcesPath,
      vendorDir: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay-win\\resources\\vendor',
      psDir: 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay-win\\resources\\ps',
      diagnosticsOutDir: base.desktop,
      logDirFellBack: false,
    });
  });
  it('Windows falls back to LOCALAPPDATA when ProgramData is not writable; dev paths', () => {
    const p = computeAppPaths({ ...base, platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\山田\\AppData\\Local' }, isPackaged: false, canWrite: () => false });
    expect(p.logDir).toBe('C:\\Users\\山田\\AppData\\Local\\LanPlay\\logs');
    expect(p.logDirFellBack).toBe(true);
    expect(p.sharedData).toBe('C:\\ProgramData\\LanPlay');
    expect(p.vendorDir).toBe('C:\\src\\lanplay\\vendor\\sunshine-windows-msi');
    expect(p.psDir).toBe('C:\\src\\lanplay\\scripts\\windows');
  });
  it('macOS: ~/Library/Logs/LanPlay', () => {
    const p = computeAppPaths({ platform: 'darwin', env: {}, homedir: '/Users/garv', userData: '/Users/garv/Library/Application Support/LanPlay', desktop: '/Users/garv/Desktop', isPackaged: true, resourcesPath: '/Applications/LanPlay.app/Contents/Resources', appRoot: '/x', canWrite: () => true });
    expect(p.logDir).toBe('/Users/garv/Library/Logs/LanPlay');
    expect(p.vendorDir).toBe('/Applications/LanPlay.app/Contents/Resources/vendor');
    expect(p.sharedData).toBe(p.userData);
  });
});

describe('security policy', () => {
  const dir = '/Applications/LanPlay.app/Contents/Resources/app.asar/dist/renderer';
  it('allows only file:// inside the renderer folder', () => {
    expect(isAllowedAppUrl(pathToFileURL(path.join(dir, 'index.html')).toString(), dir)).toBe(true);
    expect(isAllowedAppUrl(pathToFileURL(path.join(dir, 'styles.css')).toString(), dir)).toBe(true);
    expect(isAllowedAppUrl(pathToFileURL('/etc/passwd').toString(), dir)).toBe(false);
    expect(isAllowedAppUrl(pathToFileURL(path.join(dir, '..', 'main', 'main.js')).toString(), dir)).toBe(false);
    expect(isAllowedAppUrl('file://evil.example/share/index.html', dir)).toBe(false);
    expect(isAllowedAppUrl('https://example.com/', dir)).toBe(false);
    expect(isAllowedAppUrl('javascript:alert(1)', dir)).toBe(false);
  });
  it('Windows: drive-letter / path case never blocks the app\'s own page, and traversal is still refused', () => {
    const winDir = 'c:\\Users\\Jörg Müller\\Downloads\\LanPlay-win32-x64\\resources\\app.asar\\dist\\renderer';
    // what Chromium asks for after canonicalising the drive letter and percent-encoding
    const page = 'file:///C:/Users/J%C3%B6rg%20M%C3%BCller/Downloads/LanPlay-win32-x64/resources/app.asar/dist/renderer/index.html';
    expect(isAllowedAppUrl(page, winDir, true)).toBe(true);
    expect(isAllowedAppUrl(page.replace('/renderer/index.html', '/RENDERER/styles.css'), winDir, true)).toBe(true);
    expect(isAllowedAppUrl('file:///C:/Users/J%C3%B6rg%20M%C3%BCller/Downloads/LanPlay-win32-x64/resources/app.asar/dist/renderer/../main/main.js', winDir, true)).toBe(false);
    expect(isAllowedAppUrl('file:///C:/Windows/System32/drivers/etc/hosts', winDir, true)).toBe(false);
    expect(isAllowedAppUrl('file:///D:/Users/J%C3%B6rg%20M%C3%BCller/Downloads/LanPlay-win32-x64/resources/app.asar/dist/renderer/index.html', winDir, true)).toBe(false);
    // UNC / remote hosts are never the app
    expect(isAllowedAppUrl('file://fileserver/share/app.asar/dist/renderer/index.html', winDir, true)).toBe(false);
    // POSIX stays case-sensitive
    expect(isAllowedAppUrl(pathToFileURL(path.posix.join(dir.toUpperCase(), 'index.html')).toString(), dir, false)).toBe(false);
  });
  it('external URLs: exact allow-list only', () => {
    expect(isAllowedExternalUrl('https://www.gnu.org/licenses/gpl-3.0.html')).toBe(true);
    expect(isAllowedExternalUrl('https://www.gnu.org/licenses/gpl-3.0.html?x')).toBe(false);
    expect(isAllowedExternalUrl('https://evil.example')).toBe(false);
  });
  it('webPreferences are locked down', () => {
    expect(SECURITY.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false });
  });
});

describe('preload allow-lists', () => {
  it('equal the contract channel lists', () => {
    const src = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'preload', 'preload.ts'), 'utf8');
    const grab = (name: string) => {
      const m = new RegExp(`const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`).exec(src);
      return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    expect(grab('INVOKE_CHANNELS')).toEqual([...IPC_INVOKE_CHANNELS]);
    expect(grab('EVENT_CHANNELS')).toEqual([...IPC_EVENT_CHANNELS]);
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/require\(|from '\.\.\/(?!contracts\.js)/); // sandboxed preload: only 'electron' at runtime
    expect(code.match(/^import (?!type)/gm)).toHaveLength(1);
    expect(src).toMatch(/import type \{[^}]+\} from '\.\.\/contracts\.js'/);
  });
});
