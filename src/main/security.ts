// Electron security policy (contracts SECURITY). Pure helpers are exported for tests; applySecurity wires Electron.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECURITY } from '../contracts.js';
import type { App, Session } from 'electron';

/** Only file:// URLs inside the renderer folder may be loaded or navigated to. */
export function isAllowedAppUrl(url: string, rendererDir: string): boolean {
  if (!SECURITY.allowedNavigationPrefixes.some((p) => url.startsWith(p))) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:' || (u.host !== '' && u.host !== 'localhost')) return false;
    const p = path.resolve(fileURLToPath(u));
    const root = path.resolve(rendererDir) + path.sep;
    return p.startsWith(root);
  } catch {
    return false;
  }
}

/** window.open / external links: exact allow-listed URLs only (opened in the system browser). */
export function isAllowedExternalUrl(url: string): boolean {
  return (SECURITY.allowedExternalUrls as readonly string[]).includes(url);
}

export interface ElectronSecurityApi {
  app: App;
  session: Session;
  openExternal: (url: string) => Promise<void>;
  protocol: { handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void };
  netFetch: (url: string, init: RequestInit & { bypassCustomProtocolHandlers?: boolean }) => Promise<Response>;
}

export function applySecurity(e: ElectronSecurityApi, rendererDir: string, log: (msg: string, data?: Record<string, unknown>) => void): void {
  if (SECURITY.denyAllPermissions) {
    e.session.setPermissionRequestHandler((_wc, permission, cb) => {
      log('denied permission request', { permission });
      cb(false);
    });
    e.session.setPermissionCheckHandler(() => false);
  }
  // Serve file:// only from the renderer folder, with the CSP as a real header (in addition to the <meta>).
  e.protocol.handle('file', async (request) => {
    if (!isAllowedAppUrl(request.url, rendererDir)) {
      log('blocked file:// request outside the renderer', { url: request.url });
      return new Response('Forbidden', { status: 403 });
    }
    const res = await e.netFetch(request.url, { bypassCustomProtocolHandlers: true });
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', SECURITY.csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
  e.app.on('web-contents-created', (_ev, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (!isAllowedAppUrl(url, rendererDir)) {
        ev.preventDefault();
        log('blocked navigation', { url });
      }
    });
    contents.on('will-redirect', (ev, url) => {
      if (!isAllowedAppUrl(url, rendererDir)) ev.preventDefault();
    });
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void e.openExternal(url);
      else log('blocked window.open', { url });
      return { action: 'deny' };
    });
  });
}
