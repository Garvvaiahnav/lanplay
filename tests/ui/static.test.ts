import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS, SECURITY } from '../../src/contracts.js';
import { RENDERER_DIR, SCRIPT_ORDER } from './helpers.js';

const read = (f: string): string => readFileSync(join(RENDERER_DIR, f), 'utf8');
const tsFiles = readdirSync(RENDERER_DIR).filter((f) => f.endsWith('.ts'));
const CSS_FILES = ['styles.css', 'stream-menu.css'] as const;

/** Every `property: value` of a stylesheet (comments stripped). Custom properties are skipped. */
function declarations(file: string): Array<{ prop: string; value: string }> {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ prop: string; value: string }> = [];
  for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
    for (const d of (block[1] ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const prop = d.slice(0, i).trim();
      if (prop && !prop.startsWith('--')) out.push({ prop, value: d.slice(i + 1).trim() });
    }
  }
  return out;
}
const values = (file: string, re: RegExp): string[] => declarations(file).filter((d) => re.test(d.prop)).flatMap((d) => d.value.split(/\s+/));

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

describe('UI scale (plan section 5), enforced on both stylesheets', () => {
  it('no gradient, glass, blur or shadow', () => {
    for (const f of CSS_FILES) {
      const css = read(f);
      expect(css, f).not.toMatch(/gradient/i);
      expect(css, f).not.toMatch(/backdrop-filter/i);
      expect(css, f).not.toMatch(/box-shadow|text-shadow|drop-shadow/i);
      expect(css, f).not.toMatch(/\bfilter\s*:/i);
    }
  });

  it('border-radius is 6px, 8px, 999px or 50% only', () => {
    for (const f of CSS_FILES) {
      const radii = values(f, /^border(-[a-z]+)*-radius$/);
      expect(radii.length, f).toBeGreaterThan(0);
      for (const r of radii) expect(['6px', '8px', '999px', '50%'], f + ' ' + r).toContain(r);
    }
  });

  it('font-size is 13, 15, 17 or 22 px and font-weight 400 or 600; no font shorthand but inherit', () => {
    for (const f of CSS_FILES) {
      for (const v of values(f, /^font-size$/)) expect(['13px', '15px', '17px', '22px'], f + ' ' + v).toContain(v);
      for (const v of values(f, /^font-weight$/)) expect(['400', '600'], f + ' ' + v).toContain(v);
      for (const d of declarations(f).filter((x) => x.prop === 'font')) expect(d.value, f).toBe('inherit');
    }
  });

  it('padding, margin and gap use only 0, auto, 4, 8, 12, 16 and 24 px', () => {
    const allowed = ['0', 'auto', '4px', '8px', '12px', '16px', '24px'];
    for (const f of CSS_FILES) {
      const spacing = values(f, /^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)?$/);
      expect(spacing.length, f).toBeGreaterThan(0);
      for (const v of spacing) expect(allowed, f + ' ' + v).toContain(v);
    }
  });

  it('controls: 36px on desktop, Stream button 48px / 17px / 600 / radius 6 / full width', () => {
    const rule = (sel: string): string => new RegExp(sel.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}').exec(read('styles.css'))?.[1] ?? '';
    expect(rule('.btn')).toMatch(/min-height:\s*36px/);
    expect(rule('.text')).toMatch(/min-height:\s*36px/);
    expect(rule('.seg-btn')).toMatch(/min-height:\s*36px/);
    const stream = rule('.stream-btn');
    expect(stream).toMatch(/min-height:\s*48px/);
    expect(stream).toMatch(/font-size:\s*17px/);
    expect(stream).toMatch(/font-weight:\s*600/);
    expect(stream).toMatch(/border-radius:\s*6px/);
    expect(stream).toMatch(/width:\s*100%/);
  });

  it('colour-mix only in the error box; the old chooser cards are gone', () => {
    const css = read('styles.css');
    expect([...css.matchAll(/color-mix/g)]).toHaveLength(1);
    expect(css).toMatch(/\.error\s*\{[^}]*color-mix/);
    expect(css).not.toMatch(/\.big\b|\.bigs\b/);
  });
});

describe('UI copy (plan section 5)', () => {
  const sources = (): string => [...tsFiles, 'index.html', 'stream-menu.html'].map(read).join('\n');

  it('the deleted copy and controls are gone', () => {
    const src = sources();
    for (const gone of ['LanPlay sets it up for you', 'Quick starting points', 'Higher looks sharper', '120 feels smoother', 'Stereo only for now', 'HINTS.preset', 'HINTS.resolution', 'HINTS.fps', 'HINTS.audio', 'Computers on your network running', 'You are streaming. What now?', 'Open the link on each phone (same Wi-Fi) or scan the code', "'Audio'", 'big-title', 'big-sub']) {
      expect(src, gone).not.toContain(gone);
    }
  });

  it('no emoji, no single-character ellipsis, no exclamation marks in text', () => {
    for (const f of [...tsFiles, 'index.html', 'stream-menu.html', ...CSS_FILES]) {
      const src = read(f);
      expect(src, f).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(src, f).not.toContain('\u2026');
      expect(src, f).not.toMatch(/[A-Za-z.)]!(?=['"`<])/);
    }
  });
});
