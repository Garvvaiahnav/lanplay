// Platform-specific facts about the Moonlight client (pure; no Electron). darwin = Moonlight.app, win32 = Moonlight.exe.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MOONLIGHT } from '../../contracts.js';

/**
 * Windows Moonlight layout. The portable zip (MoonlightPortable-x64-6.2.0.zip) is extracted by scripts/fetch-vendor.mjs to
 * vendor/moonlight-windows/ and shipped to <resources>/vendor/moonlight-windows/ (electron-builder win.extraResources).
 * Moonlight.exe is a GUI-subsystem Qt app; the CLI (stream/pair/list) is the same as on macOS.
 * Windows firewall: the client only connects OUT (Sunshine 47984/47989/47990/48010 TCP, 47998-48000 UDP, LanPlay agent
 * 47920), and Windows allows outbound by default, so no firewall rule is needed on a client PC. The only inbound traffic
 * is replies to our own outgoing UDP (discovery broadcast, RTP/ENet video+audio), which the stateful firewall allows.
 */
export const MOONLIGHT_WIN = Object.freeze({
  bundledDirName: 'moonlight-windows',
  exeName: 'Moonlight.exe',
  /** Installed by the official Moonlight-<ver>.exe installer (all users). */
  installedDefault: 'C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe',
  installedRelative: path.win32.join('Moonlight Game Streaming', 'Moonlight.exe'),
  /** Same naming as on the Mac: Qt message handler writes %TEMP%\Moonlight-<epoch>.log (app/main.cpp, prunes to 10). */
  logPrefix: MOONLIGHT.macLogPrefix,
  manifestArtifactId: 'moonlight-windows',
});

/** Windows paths are case-insensitive and may mix slashes; compare in one normalised form. */
function winNorm(p: string): string {
  return path.win32.normalize(p).toLowerCase();
}

/** True when `binary` is the bundled / dev-vendor portable Moonlight (not a Program Files install). */
export function isBundledWindowsMoonlight(binary: string): boolean {
  const n = winNorm(binary);
  return n.endsWith(winNorm(path.win32.join(MOONLIGHT_WIN.bundledDirName, MOONLIGHT_WIN.exeName)));
}

/**
 * Moonlight.exe has no Info.plist. For the bundled exe the version is whatever we pinned: the vendor manifest tag when it
 * can be read (dev tree: vendor/manifest.json next to vendor/moonlight-windows), else MOONLIGHT.version. For an exe we did
 * not ship (Program Files install) the version is unknown (null): it is never guessed.
 * @param readFile injected for tests
 */
export function readWindowsMoonlightVersion(binary: string, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  if (!isBundledWindowsMoonlight(binary)) return null;
  try {
    const manifestPath = path.win32.join(path.win32.dirname(path.win32.dirname(binary)), 'manifest.json');
    const m = JSON.parse(readFile(manifestPath)) as { artifacts?: Array<{ id?: string; tag?: string }> };
    const tag = m.artifacts?.find((a) => a.id === MOONLIGHT_WIN.manifestArtifactId)?.tag;
    if (typeof tag === 'string' && /^v?\d+(\.\d+)*$/.test(tag)) return tag.replace(/^v/, '');
  } catch {
    /* packaged builds do not ship the manifest: use the pin below */
  }
  return MOONLIGHT.version;
}

/** CFBundleShortVersionString from <App>.app/Contents/Info.plist (XML plist). */
export function readBundleVersion(binary: string): string | null {
  const plist = path.join(path.dirname(binary), '..', 'Info.plist');
  try {
    const t = readFileSync(plist, 'utf8');
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(t);
    return m ? m[1]!.trim() : null;
  } catch {
    return null;
  }
}

export function readMoonlightVersion(binary: string, platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32' ? readWindowsMoonlightVersion(binary) : readBundleVersion(binary);
}

/** Moonlight's own log folder: /tmp on macOS (observed), %TEMP% on Windows. */
export function moonlightLogDir(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (platform !== 'win32') return MOONLIGHT.macLogGlobDir;
  const temp = env.TEMP || env.TMP;
  if (temp) return temp;
  const local = env.LOCALAPPDATA;
  if (local) return path.win32.join(local, 'Temp');
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'Temp');
}

/** Human-readable name of this computer for user-facing messages. */
export function platformLabel(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Windows PC' : 'Mac';
}
