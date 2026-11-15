// Signed auto-update (pure Node, no Electron). The app fetches manifest.json + manifest.sig from the latest GitHub release,
// checks the Ed25519 signature with the public key below, downloads the installer for this platform, verifies its SHA-256 and
// size from the (signed) manifest, and stages it. Nothing unsigned is ever run. Applying it is src/core/update/apply.ts.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const UPDATE_REPO = 'Garvvaiahnav/lanplay';
export const UPDATE_MANIFEST_URL = `https://github.com/${UPDATE_REPO}/releases/latest/download/manifest.json`;
export const UPDATE_SIGNATURE_URL = `https://github.com/${UPDATE_REPO}/releases/latest/download/manifest.sig`;
/** The only place installers may be downloaded from. */
export const ASSET_URL_PREFIX = `https://github.com/${UPDATE_REPO}/releases/download/`;
/** Public half of the release signing key (base64 SPKI DER). The private half stays on the release machine (scripts/release-sign.mjs). */
export const UPDATE_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAGLBrt/C9Ln1uaY4g+9qnfv6MDwGLu/x+oa6XkcamnD8=';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SIG_BYTES = 1024;
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface UpdateAsset {
  url: string;
  sha256: string;
  size: number;
}
export interface UpdateManifest {
  schema: 1;
  version: string;
  notes: string;
  /** Keyed "<process.platform>-<process.arch>", e.g. "win32-x64", "darwin-arm64". */
  assets: Record<string, UpdateAsset>;
}

export const assetKey = (platform: string, arch: string): string => `${platform}-${arch}`;

function parts(v: string): [number, number, number] {
  if (!SEMVER.test(v)) throw new Error(`not a x.y.z version: "${v}"`);
  const [a, b, c] = v.split('.').map(Number);
  return [a ?? 0, b ?? 0, c ?? 0];
}

/** >0 if a is newer than b. Strict x.y.z only. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function parseManifest(text: string): UpdateManifest {
  const j = JSON.parse(text) as Record<string, unknown>;
  if (!j || typeof j !== 'object' || j['schema'] !== 1) throw new Error('unsupported manifest schema');
  const version = j['version'];
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error('bad manifest version');
  const assetsIn = j['assets'];
  if (!assetsIn || typeof assetsIn !== 'object' || Array.isArray(assetsIn)) throw new Error('bad manifest assets');
  const assets: Record<string, UpdateAsset> = {};
  for (const [key, raw] of Object.entries(assetsIn as Record<string, unknown>)) {
    const a = raw as Partial<UpdateAsset> | null;
    if (!a || typeof a.url !== 'string' || !a.url.startsWith(ASSET_URL_PREFIX)) throw new Error(`asset ${key}: download URL is not a LanPlay GitHub release`);
    if (typeof a.sha256 !== 'string' || !SHA256.test(a.sha256)) throw new Error(`asset ${key}: bad sha256`);
    if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size < 1 || a.size > MAX_ASSET_BYTES) throw new Error(`asset ${key}: bad size`);
    assets[key] = { url: a.url, sha256: a.sha256, size: a.size };
  }
  return { schema: 1, version, notes: typeof j['notes'] === 'string' ? j['notes'] : '', assets };
}

/** True only for a valid Ed25519 signature of exactly these bytes. Never throws. */
export function verifySignature(data: Buffer, signatureB64: string, publicKeyB64: string): boolean {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureB64)) return false;
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, data, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

function sha256File(file: string): string {
  const h = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

export interface StagedUpdate {
  version: string;
  notes: string;
  file: string;
  sha256: string;
  /** Set before the installer is started, so a broken installer is never retried in a loop. */
  attempted: boolean;
}

export type UpdateCheckResult =
  | { status: 'up-to-date'; reason?: 'no-asset' }
  | { status: 'ready'; version: string; notes: string }
  | { status: 'error'; reason: 'network' | 'bad-signature' | 'bad-manifest' | 'hash-mismatch'; message: string };

export interface UpdaterDeps {
  currentVersion: string;
  platform: string;
  arch: string;
  /** Folder for the staged installer and staged.json. */
  stageDir: string;
  /** Tests pass their own key; production uses UPDATE_PUBLIC_KEY_B64. */
  publicKeyB64?: string;
  fetchBytes(url: string, maxBytes: number): Promise<Buffer>;
  /** Download url to destPath (any partial file is the caller's .part). */
  downloadTo(url: string, destPath: string): Promise<void>;
}

export class Updater {
  constructor(private readonly d: UpdaterDeps) {}

  private get statePath(): string {
    return path.join(this.d.stageDir, 'staged.json');
  }

  /** The staged installer if it is still newer than the running app and byte-for-byte what was verified; else null (and cleaned up). */
  staged(): StagedUpdate | null {
    if (!existsSync(this.statePath)) return null;
    try {
      const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as StagedUpdate;
      if (compareVersions(s.version, this.d.currentVersion) > 0 && existsSync(s.file) && sha256File(s.file) === s.sha256) return s;
    } catch {
      /* corrupt state: fall through to cleanup */
    }
    this.clear();
    return null;
  }

  markAttempted(): void {
    const s = this.staged();
    if (s) writeFileSync(this.statePath, JSON.stringify({ ...s, attempted: true }));
  }

  clear(): void {
    try {
      const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<StagedUpdate>;
      if (typeof s.file === 'string') rmSync(s.file, { force: true });
    } catch {
      /* nothing staged */
    }
    rmSync(this.statePath, { force: true });
  }

  async check(): Promise<UpdateCheckResult> {
    let manifestBytes: Buffer;
    let sig: string;
    try {
      manifestBytes = await this.d.fetchBytes(UPDATE_MANIFEST_URL, MAX_MANIFEST_BYTES);
      sig = (await this.d.fetchBytes(UPDATE_SIGNATURE_URL, MAX_SIG_BYTES)).toString('utf8').trim();
    } catch (e) {
      return { status: 'error', reason: 'network', message: (e as Error).message };
    }
    if (!verifySignature(manifestBytes, sig, this.d.publicKeyB64 ?? UPDATE_PUBLIC_KEY_B64)) {
      return { status: 'error', reason: 'bad-signature', message: 'The update manifest is not signed by LanPlay.' };
    }
    let m: UpdateManifest;
    try {
      m = parseManifest(manifestBytes.toString('utf8'));
    } catch (e) {
      return { status: 'error', reason: 'bad-manifest', message: (e as Error).message };
    }
    if (compareVersions(m.version, this.d.currentVersion) <= 0) return { status: 'up-to-date' };
    const asset = m.assets[assetKey(this.d.platform, this.d.arch)];
    if (!asset) return { status: 'up-to-date', reason: 'no-asset' };

    const have = this.staged();
    if (have && have.version === m.version && have.sha256 === asset.sha256) return { status: 'ready', version: m.version, notes: m.notes };

    mkdirSync(this.d.stageDir, { recursive: true });
    const name = path.posix.basename(new URL(asset.url).pathname).replace(/[^A-Za-z0-9._-]/g, '_');
    const dest = path.join(this.d.stageDir, `${m.version}-${name}`);
    const part = `${dest}.part`;
    try {
      this.clear();
      await this.d.downloadTo(asset.url, part);
      if (statSync(part).size !== asset.size || sha256File(part) !== asset.sha256) {
        rmSync(part, { force: true });
        return { status: 'error', reason: 'hash-mismatch', message: 'The downloaded update does not match the signed manifest.' };
      }
      renameSync(part, dest);
    } catch (e) {
      rmSync(part, { force: true });
      return { status: 'error', reason: 'network', message: (e as Error).message };
    }
    const staged: StagedUpdate = { version: m.version, notes: m.notes, file: dest, sha256: asset.sha256, attempted: false };
    writeFileSync(this.statePath, JSON.stringify(staged));
    return { status: 'ready', version: m.version, notes: m.notes };
  }
}
