import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS, SECURITY } from '../../src/contracts.js';
import { RENDERER_DIR, SCRIPT_ORDER } from './helpers.js';

const read = (f: string): string => readFileSync(join(RENDERER_DIR, f), 'utf8');
const tsFiles = readdirSync(RENDERER_DIR).filter((f) => f.endsWith('.ts'));

describe('renderer security and contract hygiene', () => {
  it('index.html loads only local classic scripts, in order, with no inline script or handlers', () => {
    const html = read('index.html');
    const srcs = [...html.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)].map((m) => m[1]);
    expect(srcs).toEqual(SCRIPT_ORDER.map((n) => n + '.js'));
    expect(html.match(/<script/g)).toHaveLength(srcs.length);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<style|style=|https?:\/\//i);
  });

  it('page CSP equals SECURITY.csp (minus frame-ancestors, which meta tags cannot carry)', () => {
    const meta = /Content-Security-Policy" content="([^"]+)"/.exec(read('index.html'))?.[1];
    expect(meta).toBe(SECURITY.csp.replace(/; frame-ancestors 'none'$/, ''));
  });

  it('no innerHTML, eval, Function, document.write, remote URLs or direct Electron/Node access in the sources', () => {
    for (const f of tsFiles) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|require\(|process\.|ipcRenderer|https?:\/\//);
    }
  });

  it('only allow-listed IPC channels are used', () => {
    const src = tsFiles.map(read).join('\n');
    const invoked = [...src.matchAll(/\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
    const events = [...src.matchAll(/\.on\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(invoked.length).toBeGreaterThan(10);
    for (const c of invoked) expect(IPC_INVOKE_CHANNELS as readonly string[]).toContain(c);
    for (const c of events) expect(IPC_EVENT_CHANNELS as readonly string[]).toContain(c);
  });

  it('stylesheet has dark default, a light scheme query, and visible focus', () => {
    const css = read('styles.css');
    expect(css).toMatch(/prefers-color-scheme: light/);
    expect(css).toMatch(/:focus-visible/);
    expect(css).not.toMatch(/url\(|@import/);
  });
});
