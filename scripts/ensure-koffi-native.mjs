#!/usr/bin/env node
// Makes sure the koffi prebuilt-binary package for the TARGET platform is in node_modules before electron-builder runs.
// koffi 3 ships its native addon in one optional package per platform (@koromix/koffi-<os>-<arch>); npm only installs the
// one matching the machine running `npm ci`, so a Windows build made on a Mac would otherwise pack the wrong binary.
// The version is read from the installed koffi and the install is resolved from package-lock.json, which pins the tarball
// by its sha512 integrity (npm refuses a tarball that does not match). No package.json / lockfile change (--no-save).
// Usage: node scripts/ensure-koffi-native.mjs win32-x64
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!/^(win32|darwin|linux)-(x64|arm64)$/.test(target ?? '')) {
  console.error('usage: node scripts/ensure-koffi-native.mjs <win32|darwin|linux>-<x64|arm64>');
  process.exit(2);
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const version = readJson(join(ROOT, 'node_modules', 'koffi', 'package.json')).version;
const name = `@koromix/koffi-${target}`;
const pkgJson = join(ROOT, 'node_modules', name, 'package.json');
const lockEntry = readJson(join(ROOT, 'package-lock.json')).packages?.[`node_modules/${name}`];
if (!lockEntry || lockEntry.version !== version || !/^sha512-/.test(lockEntry.integrity ?? '')) {
  console.error(`${name}@${version} is not pinned with an integrity hash in package-lock.json`);
  process.exit(1);
}
if (existsSync(pkgJson) && readJson(pkgJson).version === version) {
  console.log(`ensure-koffi-native: ${name}@${version} already installed`);
} else {
  // argv array, no shell. --force only lifts the os/cpu check (the package is for another platform on purpose).
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', '--force', '--ignore-scripts', '--no-audit', '--no-fund', `${name}@${version}`], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(`ensure-koffi-native: installed ${name}@${version} (integrity ${lockEntry.integrity.slice(0, 23)}... from package-lock.json)`);
}
