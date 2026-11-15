#!/usr/bin/env node
// Downloads pinned third-party binaries listed in vendor/manifest.json, verifies SHA256, and extracts them.
// Only the allow-listed URL prefixes below are accepted (GitHub release assets of five repos, one NuGet package). Nothing downloaded is executed.
// Usage: node scripts/fetch-vendor.mjs [--ids id1,id2] [--windows] [--verify-only]
//   default ids on macOS: moonlight-macos,sunshine-macos-arm64,pwsh-macos ; on Windows (or --windows): sunshine-windows-msi,moonlight-windows,
//   vigembus-windows-installer,vigemclient-windows-x64
// Extraction (no shell strings, argv arrays only):
//   moonlight-macos: hdiutil attach -nobrowse -readonly -> ditto Moonlight.app (keeps the notarized signature) -> detach
//   sunshine-macos-arm64: same, ditto Sunshine.app, then codesign --verify and the pinned TeamIdentifier (darwin only, skipped elsewhere)
//   pwsh-macos:      tar -xzf into vendor/pwsh-macos/pwsh-7.7.0 ; chmod +x pwsh
//   vigemclient-windows-x64: unzip the nupkg into a temp dir, read the CLR resource area of Nefarius.ViGEm.Client.dll (pure
//                    JS, scripts/pe-tools.mjs), take the embedded x64 native PE, check machine/exports/SHA256, write ViGEmClient.dll
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extractEmbeddedNativeDll, MACHINE_X64, parsePe, peExports } from './pe-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
export const ALLOWED_PREFIXES = [
  'https://github.com/LizardByte/Sunshine/releases/download/',
  'https://github.com/moonlight-stream/moonlight-qt/releases/download/',
  'https://github.com/PowerShell/PowerShell/releases/download/',
  'https://github.com/nefarius/ViGEmBus/releases/download/',
  'https://api.nuget.org/v3-flatcontainer/nefarius.vigem.client/',
];

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const idsArg = args.indexOf('--ids') >= 0 ? args[args.indexOf('--ids') + 1] : undefined;
const windows = args.includes('--windows') || process.platform === 'win32';
const defaultIds = windows ? ['sunshine-windows-msi', 'moonlight-windows', 'vigembus-windows-installer', 'vigemclient-windows-x64'] : ['moonlight-macos', 'sunshine-macos-arm64', 'pwsh-macos'];
const ids = idsArg ? idsArg.split(',') : defaultIds;

const manifest = JSON.parse(readFileSync(join(VENDOR, 'manifest.json'), 'utf8'));

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');

/** Checks a file extracted from a download against the manifest's 'extracted' block (size, SHA256, PE machine, exports). */
function checkExtracted(a, buf) {
  const x = a.extracted;
  const problems = [];
  if (buf.length !== x.sizeBytes) problems.push(`size ${buf.length} != ${x.sizeBytes}`);
  const got = sha256Buf(buf);
  if (got !== x.sha256) problems.push(`SHA256 ${got} != ${x.sha256}`);
  try {
    const pe = parsePe(buf);
    if (x.machine === 'x64' && pe.machine !== MACHINE_X64) problems.push(`PE machine 0x${pe.machine.toString(16)} is not x64`);
    if (!pe.isDll) problems.push('not a DLL');
    const have = new Set(peExports(buf));
    for (const name of x.requiredExports ?? []) if (!have.has(name)) problems.push(`missing export ${name}`);
  } catch (e) {
    problems.push(e.message);
  }
  return problems;
}

/** Throws unless the .app's signature is valid and its TeamIdentifier is the pinned one. */
function verifyAppSignature(app, teamId) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const info = spawnSync('/usr/bin/codesign', ['-dv', app], { encoding: 'utf8' }); // codesign -dv writes to stderr
  const got = /^TeamIdentifier=(\S+)$/m.exec(`${info.stdout}${info.stderr}`)?.[1];
  if (got !== teamId) throw new Error(`${app} is signed by team ${got ?? 'none'}, expected ${teamId}`);
}

/** Mounts the dmg read-only, copies <name> out with ditto (keeps the notarized signature) and always detaches. */
function copyAppFromDmg(dmg, name, dest) {
  const mnt = mkdtempSync(join(tmpdir(), 'lanplay-dmg-'));
  try {
    execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, dmg], { stdio: 'inherit' });
    try {
      execFileSync('/usr/bin/ditto', [join(mnt, name), dest], { stdio: 'inherit' });
    } finally {
      // A busy volume (Spotlight, an open Finder window) refuses a plain detach.
      if (spawnSync('/usr/bin/hdiutil', ['detach', mnt], { stdio: 'inherit' }).status !== 0) spawnSync('/usr/bin/hdiutil', ['detach', '-force', mnt], { stdio: 'inherit' });
    }
  } finally {
    // Not recursive: if the volume is somehow still mounted this fails instead of reaching into it.
    try { rmdirSync(mnt); } catch (e) { console.warn(`could not remove ${mnt}: ${e.message}`); }
  }
}

function extract(a, dest) {
  const dir = join(VENDOR, a.id);
  if (a.id === 'vigemclient-windows-x64') {
    const out = join(dir, a.extracted.file);
    if (existsSync(out) && checkExtracted(a, readFileSync(out)).length === 0) return;
    const tmp = mkdtempSync(join(tmpdir(), 'lanplay-vigemclient-'));
    try {
      if (process.platform === 'win32') execFileSync('tar', ['-xf', dest, '-C', tmp], { stdio: 'inherit' });
      else execFileSync('/usr/bin/ditto', ['-xk', dest, tmp], { stdio: 'inherit' });
      const dll = extractEmbeddedNativeDll(readFileSync(join(tmp, 'lib', 'netstandard2.0', 'Nefarius.ViGEm.Client.dll')), MACHINE_X64);
      const problems = checkExtracted(a, dll);
      if (problems.length) throw new Error(`extracted ${a.extracted.file} rejected: ${problems.join('; ')}`);
      writeFileSync(out, dll);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`${a.id}: extracted ${out} (x64 PE, SHA256 ${a.extracted.sha256}, required exports present)`);
    return;
  }
  if (a.id === 'moonlight-macos') {
    const app = join(dir, 'Moonlight.app');
    if (existsSync(join(app, 'Contents', 'MacOS', 'Moonlight'))) return;
    if (process.platform !== 'darwin') return;
    copyAppFromDmg(dest, 'Moonlight.app', app);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`${a.id}: extracted ${app} (signature verified)`);
  } else if (a.id === 'sunshine-macos-arm64') {
    const app = join(dir, 'Sunshine.app');
    if (!existsSync(join(app, 'Contents', 'MacOS', 'Sunshine'))) copyAppFromDmg(dest, 'Sunshine.app', app);
    verifyAppSignature(app, a.teamId);
    console.log(`${a.id}: extracted ${app} (signature verified, team ${a.teamId})`);
  } else if (a.id === 'moonlight-windows') {
    const exe = join(dir, 'Moonlight.exe');
    if (existsSync(exe)) return;
    // Portable zip: Moonlight.exe at the zip root (checked after extraction; moved up if nested one level).
    if (process.platform === 'win32') execFileSync('tar', ['-xf', dest, '-C', dir], { stdio: 'inherit' });
    else execFileSync('/usr/bin/ditto', ['-xk', dest, dir], { stdio: 'inherit' });
    if (!existsSync(exe)) {
      const nested = readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && existsSync(join(dir, e.name, 'Moonlight.exe')));
      if (nested) {
        for (const f of readdirSync(join(dir, nested.name))) renameSync(join(dir, nested.name, f), join(dir, f));
        rmSync(join(dir, nested.name), { recursive: true, force: true });
      }
    }
    if (!existsSync(exe)) throw new Error('Moonlight.exe not found after extracting the portable zip');
    console.log(`${a.id}: extracted ${dir}`);
  } else if (a.id === 'pwsh-macos') {
    const out = join(dir, 'pwsh-7.7.0');
    if (existsSync(join(out, 'pwsh'))) return;
    mkdirSync(out, { recursive: true });
    execFileSync('/usr/bin/tar', ['-xzf', dest, '-C', out], { stdio: 'inherit' });
    chmodSync(join(out, 'pwsh'), 0o755);
    console.log(`${a.id}: extracted ${out}`);
  }
}

let failed = 0;
for (const id of ids) {
  const a = manifest.artifacts.find((x) => x.id === id);
  if (!a) { console.error(`unknown artifact id: ${id}`); failed++; continue; }
  if (!ALLOWED_PREFIXES.some((p) => a.url.startsWith(p))) { console.error(`${id}: URL not on allow-list: ${a.url}`); failed++; continue; }
  if (a.platform === 'darwin' && process.platform !== 'darwin') { console.log(`${id}: skipped (macOS only)`); continue; }
  const dir = join(VENDOR, id);
  const dest = join(dir, a.asset);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(dest)) {
    if (verifyOnly) { console.error(`${id}: missing ${dest}`); failed++; continue; }
    console.log(`${id}: downloading ${a.url}`);
    const res = await fetch(a.url, { redirect: 'follow' });
    // GitHub redirects release assets to its CDN; only the first URL is ours to choose and it is allow-listed.
    if (!res.ok || !res.body) { console.error(`${id}: HTTP ${res.status}`); failed++; continue; }
    const tmp = `${dest}.partial`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    renameSync(tmp, dest);
  }
  const got = await sha256(dest);
  if (got !== a.sha256) {
    console.error(`${id}: SHA256 MISMATCH expected ${a.sha256} got ${got}; deleting ${dest}`);
    rmSync(dest, { force: true });
    failed++;
    continue;
  }
  console.log(`${id}: OK ${got}`);
  if (verifyOnly && a.extracted) {
    const out = join(dir, a.extracted.file);
    if (!existsSync(out)) { console.error(`${id}: missing extracted ${out}`); failed++; continue; }
    const problems = checkExtracted(a, readFileSync(out));
    if (problems.length) { console.error(`${id}: extracted ${a.extracted.file} FAILED: ${problems.join('; ')}`); failed++; continue; }
    console.log(`${id}: extracted ${a.extracted.file} OK ${a.extracted.sha256}`);
  }
  if (!verifyOnly) {
    try {
      extract(a, dest);
    } catch (e) {
      console.error(`${id}: extraction failed: ${e.message}`);
      failed++;
    }
  }
}
process.exit(failed ? 1 : 0);
