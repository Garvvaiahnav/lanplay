// Electron glue for auto-update: fetch over net, show one dialog, start the staged installer. Logic and verification live in
// src/core/update (tested without Electron). Packaged builds only; a dev checkout never updates itself.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { App, Dialog, Net } from 'electron';
import { ASSET_URL_PREFIX, UPDATE_MANIFEST_URL, UPDATE_SIGNATURE_URL, Updater } from '../core/update/update.js';
import type { StagedUpdate } from '../core/update/update.js';
import { planApply, runApply } from '../core/update/apply.js';

const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const BUSY_RETRY_MS = 5 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

export interface UpdatesOptions {
  app: App;
  net: Net;
  dialog: Dialog;
  stageDir: string;
  /** 'agent' = background host agent without a window: stage only, apply at the next launch. */
  mode: 'gui' | 'agent';
  isStreaming(): boolean;
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void;
}

export interface Updates {
  /** Call before opening any window. True = an installer was started and the app is exiting. */
  applyStagedAtLaunch(): boolean;
  start(): void;
}

const allowedUrl = (u: string) => u === UPDATE_MANIFEST_URL || u === UPDATE_SIGNATURE_URL || u.startsWith(ASSET_URL_PREFIX);

export function createUpdates(o: UpdatesOptions): Updates {
  const { app } = o;
  if (!app.isPackaged) return { applyStagedAtLaunch: () => false, start: () => undefined };

  const fetchOk = async (url: string) => {
    if (!allowedUrl(url)) throw new Error('refusing to fetch a URL outside the LanPlay release');
    const res = await o.net.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  };
  const updater = new Updater({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    stageDir: o.stageDir,
    async fetchBytes(url, maxBytes) {
      const res = await fetchOk(url);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > maxBytes) throw new Error('response too large');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('response too large');
      return buf;
    },
    async downloadTo(url, dest) {
      const res = await fetchOk(url);
      if (!res.body) throw new Error('empty download');
      mkdirSync(path.dirname(dest), { recursive: true });
      const out = createWriteStream(dest);
      let n = 0;
      try {
        for await (const chunk of Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])) {
          n += (chunk as Buffer).length;
          if (n > MAX_DOWNLOAD_BYTES) throw new Error('download too large');
          if (!out.write(chunk)) await once(out, 'drain');
        }
      } finally {
        await new Promise<void>((r) => out.end(r));
      }
    },
  });

  const macAppPath = (): string | null => {
    const root = path.resolve(process.execPath, '..', '..', '..');
    return process.platform === 'darwin' && root.endsWith('.app') ? root : null;
  };

  /** Start the staged installer and exit. False when this platform/build cannot self-update. */
  const apply = (s: StagedUpdate): boolean => {
    const plan = planApply({ platform: process.platform, file: s.file, appPath: macAppPath(), pid: process.pid, stageDir: o.stageDir });
    if (!plan) {
      o.log('warn', 'update cannot be applied on this build', { platform: process.platform });
      return false;
    }
    updater.markAttempted();
    o.log('info', 'applying update', { from: app.getVersion(), to: s.version });
    try {
      runApply(plan, o.stageDir, spawn);
    } catch (e) {
      o.log('error', 'could not start the update installer', { error: (e as Error).message });
      return false;
    }
    app.exit(0);
    return true;
  };

  const askedFor = new Set<string>();
  const offer = async (version: string, notes: string): Promise<void> => {
    if (o.mode === 'agent' || askedFor.has(version)) return;
    if (o.isStreaming()) {
      setTimeout(() => void offer(version, notes), BUSY_RETRY_MS).unref();
      return;
    }
    askedFor.add(version);
    const r = await o.dialog.showMessageBox({
      type: 'info',
      title: 'LanPlay update',
      message: `LanPlay ${version} is ready.`,
      detail: `${notes ? notes + '\n\n' : ''}LanPlay will close, update and open again. Streams end while it updates.`,
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response === 0) {
      const s = updater.staged();
      if (s) apply(s);
    }
  };

  const check = async (): Promise<void> => {
    const r = await updater.check();
    if (r.status === 'ready') {
      o.log('info', 'update ready', { version: r.version });
      await offer(r.version, r.notes);
    } else if (r.status === 'error') {
      o.log(r.reason === 'network' ? 'info' : 'warn', 'update check failed', { reason: r.reason, message: r.message });
    }
  };

  return {
    applyStagedAtLaunch() {
      const s = updater.staged();
      // attempted = the installer already ran once for this version and the app is still old: do not loop, only offer it again.
      if (!s || s.attempted) return false;
      return apply(s);
    },
    start() {
      const run = () => void check().catch((e: Error) => o.log('warn', 'update check crashed', { error: e.message }));
      setTimeout(run, FIRST_CHECK_MS).unref();
      setInterval(run, CHECK_EVERY_MS).unref();
    },
  };
}
