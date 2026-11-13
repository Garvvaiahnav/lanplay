#!/usr/bin/env node
// Downloads pinned third-party binaries listed in vendor/manifest.json, verifies SHA256, and extracts them.
// Only github.com release URLs of the three allowed repos are accepted. Nothing downloaded is executed.
// Usage: node scripts/fetch-vendor.mjs [--ids id1,id2] [--windows] [--verify-only]
//   default ids on macOS: moonlight-macos,pwsh-macos ; on Windows (or --windows): sunshine-windows-msi
// Extraction (no shell strings, argv arrays only):
//   moonlight-macos: hdiutil attach -nobrowse -readonly -> ditto Moonlight.app (keeps the notarized signature) -> detach
//   pwsh-macos:      tar -xzf into vendor/pwsh-macos/pwsh-7.7.0 ; chmod +x pwsh
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
export const ALLOWED_PREFIXES = [
  'https://github.com/LizardByte/Sunshine/releases/download/',
  'https://github.com/moonlight-stream/moonlight-qt/releases/download/',
  'https://github.com/PowerShell/PowerShell/releases/download/',
];

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const idsArg = args.indexOf('--ids') >= 0 ? args[args.indexOf('--ids') + 1] : undefined;
const windows = args.includes('--windows') || process.platform === 'win32';
const defaultIds = windows ? ['sunshine-windows-msi'] : ['moonlight-macos', 'pwsh-macos'];
const ids = idsArg ? idsArg.split(',') : defaultIds;

const manifest = JSON.parse(readFileSync(join(VENDOR, 'manifest.json'), 'utf8'));

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

function extract(a, dest) {
  const dir = join(VENDOR, a.id);
  if (a.id === 'moonlight-macos') {
    const app = join(dir, 'Moonlight.app');
    if (existsSync(join(app, 'Contents', 'MacOS', 'Moonlight'))) return;
    if (process.platform !== 'darwin') return;
    const mnt = mkdtempSync(join(tmpdir(), 'lanplay-moonlight-'));
    execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, dest], { stdio: 'inherit' });
    try {
      execFileSync('/usr/bin/ditto', [join(mnt, 'Moonlight.app'), app], { stdio: 'inherit' });
    } finally {
      execFileSync('/usr/bin/hdiutil', ['detach', mnt], { stdio: 'inherit' });
    }
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`${a.id}: extracted ${app} (signature verified)`);
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
