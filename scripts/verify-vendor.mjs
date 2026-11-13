#!/usr/bin/env node
// `npm run vendor:verify`: re-hash every vendored binary that is present against vendor/manifest.json (no downloads).
// Usage: node scripts/verify-vendor.mjs [--windows]
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.includes('--windows') ? ['--windows'] : [];
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'fetch-vendor.mjs'), '--verify-only', ...extra], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
