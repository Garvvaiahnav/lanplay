#!/usr/bin/env node
// Downloads pinned third-party binaries listed in vendor/manifest.json and verifies SHA256.
// Only github.com release URLs of the three allowed repos are accepted. Nothing is executed.
// Usage: node scripts/fetch-vendor.mjs [--ids id1,id2] [--verify-only]
//   default ids on macOS: moonlight-macos,pwsh-macos ; on Windows: sunshine-windows-msi
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const ALLOWED_PREFIXES = [
  'https://github.com/LizardByte/Sunshine/releases/download/',
  'https://github.com/moonlight-stream/moonlight-qt/releases/download/',
  'https://github.com/PowerShell/PowerShell/releases/download/',
];

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const idsArg = args.indexOf('--ids') >= 0 ? args[args.indexOf('--ids') + 1] : undefined;
const defaultIds = process.platform === 'win32' ? ['sunshine-windows-msi'] : ['moonlight-macos', 'pwsh-macos'];
const ids = idsArg ? idsArg.split(',') : defaultIds;

const manifest = JSON.parse(readFileSync(join(VENDOR, 'manifest.json'), 'utf8'));

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
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
}
process.exit(failed ? 1 : 0);
