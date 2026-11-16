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
import type { UpdateStatus } from '../contracts.js';
import type { UpdateCheckResult } from '../core/update/update.js';

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
  /** Tests sign with their own key; production leaves this unset and uses the one built into the app. */
  publicKeyB64?: string;
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void;
}

export interface Updates {
  /** Call before opening any window. True = an installer was started and the app is exiting. */
  applyStagedAtLaunch(): boolean;
  start(): void;
  /** The "Check for updates" button: the timer's check, run now. A ready update opens the same dialog as the timer's. */
  checkNow(): Promise<UpdateStatus>;
}

const allowedUrl = (u: string) => u === UPDATE_MANIFEST_URL || u === UPDATE_SIGNATURE_URL || u.startsWith(ASSET_URL_PREFIX);

export function createUpdates(o: UpdatesOptions): Updates {
  const { app } = o;
  if (!app.isPackaged) {
    const unsupported = async (): Promise<UpdateStatus> => ({
      state: 'unsupported',
      current: app.getVersion(),
      message: 'Updates only work in the installed app, not in a development build.',
    });
    return { applyStagedAtLaunch: () => false, start: () => undefined, checkNow: unsupported };
  }

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
    ...(o.publicKeyB64 ? { publicKeyB64: o.publicKeyB64 } : {}),
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
  let dialogOpen = false;
  /** `again`: the user asked (manual check), so a version they already answered "Later" to is offered once more. */
  const offer = async (version: string, notes: string, again = false): Promise<void> => {
    if (o.mode === 'agent' || dialogOpen || (!again && askedFor.has(version))) return;
    if (o.isStreaming()) {
      setTimeout(() => void offer(version, notes), BUSY_RETRY_MS).unref();
      return;
    }
    askedFor.add(version);
    dialogOpen = true;
    let r: { response: number };
    try {
      r = await o.dialog.showMessageBox({
        type: 'info',
        title: 'LanPlay update',
        message: `LanPlay ${version} is ready.`,
        detail: `${notes ? notes + '\n\n' : ''}LanPlay will close, update and open again. Streams end while it updates.`,
        buttons: ['Restart and update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
    } finally {
      dialogOpen = false;
    }
    if (r.response === 0) {
      const s = updater.staged();
      if (s) apply(s);
    }
  };

  // The timer and the button share one run, so two checks never download the same installer at once.
  let running: Promise<UpdateCheckResult> | null = null;
  const checkOnce = (): Promise<UpdateCheckResult> => (running ??= updater.check().finally(() => (running = null)));

  const check = async (): Promise<void> => {
    const r = await checkOnce();
    if (r.status === 'ready') {
      o.log('info', 'update ready', { version: r.version });
      await offer(r.version, r.notes);
    } else if (r.status === 'error') {
      o.log(r.reason === 'network' ? 'info' : 'warn', 'update check failed', { reason: r.reason, message: r.message });
    }
  };

  const checkNow = async (): Promise<UpdateStatus> => {
    const current = app.getVersion();
    let r: UpdateCheckResult;
    try {
      r = await checkOnce();
    } catch (e) {
      o.log('warn', 'update check crashed', { error: (e as Error).message });
      return { state: 'error', current, message: `Could not check for updates: ${(e as Error).message}` };
    }
    if (r.status === 'error') {
      o.log('warn', 'manual update check failed', { reason: r.reason, message: r.message });
      return { state: 'error', current, message: `Could not check for updates: ${r.message}` };
    }
    if (r.status === 'up-to-date') {
      const message = r.reason === 'no-asset' ? 'A newer version exists but is not available for this computer yet.' : 'You have the latest version.';
      return { state: 'up-to-date', current, message };
    }
    // Not awaited: the dialog stays open until the user answers, and the screen should show its result now.
    void offer(r.version, r.notes, true).catch((e: Error) => o.log('warn', 'update dialog failed', { error: e.message }));
    const message = o.isStreaming() ? `Update ${r.version} is ready. It will be offered when your stream ends.` : `Update ${r.version} is ready to install.`;
    return { state: 'ready', current, latest: r.version, message };
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
    checkNow,
  };
}
