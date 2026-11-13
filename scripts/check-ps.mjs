#!/usr/bin/env node
// Static check of every PowerShell script with the portable pwsh 7.7 (vendor/pwsh-macos, SHA256-pinned in
// vendor/manifest.json). Parses each file with [System.Management.Automation.Language.Parser]::ParseFile, rejects
// PS7-only syntax (the wrappers run on Windows PowerShell 5.1) and enforces the wrapper rules.
// PSScriptAnalyzer: installed once with Save-Module from the PowerShell Gallery into vendor/psmodules (pinned version);
// if that is impossible (offline, gallery down) the analyzer is skipped and the reason is printed.
// Usage: node scripts/check-ps.mjs [--no-analyzer]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PWSH = join(ROOT, 'vendor', 'pwsh-macos', 'pwsh-7.7.0', 'pwsh');
const MODULES = join(ROOT, 'vendor', 'psmodules');
const ANALYZER_VERSION = '1.24.0'; // https://www.powershellgallery.com/packages/PSScriptAnalyzer/1.24.0

if (!existsSync(PWSH)) {
  console.error(`pwsh not found at ${PWSH}. Run: node scripts/fetch-vendor.mjs --ids pwsh-macos`);
  process.exit(1);
}

const wrapperDir = join(ROOT, 'scripts', 'windows');
const wrappers = readdirSync(wrapperDir).filter((f) => f.endsWith('.ps1')).map((f) => join(wrapperDir, f));
const others = [join(ROOT, 'scripts', 'build-windows.ps1')].filter(existsSync);
const files = [...wrappers, ...others];

function pwsh(args, opts = {}) {
  return execFileSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' }, ...opts });
}

// Pinned hashes of the analyzer files (vendor/manifest.json devTools[psscriptanalyzer]).
function analyzerIntact() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'vendor', 'manifest.json'), 'utf8'));
  const tool = (manifest.devTools ?? []).find((t) => t.id === 'psscriptanalyzer');
  if (!tool || tool.version !== ANALYZER_VERSION) return 'no pinned hashes for this version in vendor/manifest.json';
  const dir = join(MODULES, 'PSScriptAnalyzer', ANALYZER_VERSION);
  for (const [rel, want] of Object.entries(tool.sha256)) {
    const got = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex');
    if (got !== want) return `SHA256 mismatch for ${rel} (got ${got})`;
  }
  return null;
}

let analyzerPath = '';
let analyzerSkip = '';
if (process.argv.includes('--no-analyzer')) {
  analyzerSkip = '--no-analyzer given';
} else {
  if (!existsSync(join(MODULES, 'PSScriptAnalyzer', ANALYZER_VERSION))) {
    try {
      pwsh(['-Command', `Save-Module -Name PSScriptAnalyzer -RequiredVersion ${ANALYZER_VERSION} -Repository PSGallery -Path '${MODULES.replace(/'/g, "''")}' -Force -ErrorAction Stop`], { timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      analyzerSkip = String(e.stderr || e.message || e).split('\n').find((l) => l.trim()) ?? 'unknown error';
    }
  }
  if (!analyzerSkip) {
    const bad = analyzerIntact();
    if (bad) analyzerSkip = bad;
    else analyzerPath = MODULES;
  }
}

const args = ['-File', join(ROOT, 'scripts', 'check-ps.ps1'), '-Files', files.join('|'), '-WrapperFiles', wrappers.join('|')];
if (analyzerPath) args.push('-AnalyzerPath', analyzerPath);
const out = JSON.parse(pwsh(args, { timeout: 300_000 }));

let failed = 0;
for (const r of [out.results].flat()) {
  const probs = [r.problems ?? []].flat();
  if (r.ok) console.log(`OK    ${r.file.replace(ROOT + '/', '')}`);
  else {
    failed++;
    console.log(`FAIL  ${r.file.replace(ROOT + '/', '')}`);
    for (const p of probs) console.log(`      - ${p}`);
  }
}
if (out.analyzer.ran) {
  const findings = [out.analyzer.findings ?? []].flat();
  console.log(`PSScriptAnalyzer ${ANALYZER_VERSION}: ${findings.length} finding(s)`);
  for (const f of findings) {
    console.log(`  ${f.severity} ${f.rule} ${f.file.replace(ROOT + '/', '')}:${f.line} ${f.message}`);
    if (f.severity === 'Error') failed++;
  }
} else {
  console.log(`PSScriptAnalyzer skipped: ${analyzerSkip || out.analyzer.reason}`);
}
process.exit(failed ? 1 : 0);
