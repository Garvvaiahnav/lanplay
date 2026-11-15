// Release signing for LanPlay auto-update (Ed25519). The app trusts only manifests signed with the key whose PUBLIC half is
// hard-coded in src/core/update/update.ts. The private key never goes into the repo.
//
//   node scripts/release-sign.mjs keygen
//       Creates the private key (once) in ~/Library/Application Support/lanplay-release/update-signing-key.pem (mode 600)
//       and prints the public key (base64 SPKI DER) to paste into update.ts.
//   node scripts/release-sign.mjs manifest --version 0.2.1 [--notes-file notes.txt] --out dir \
//        --asset win32-x64=release/LanPlay-Setup-0.2.1.exe [--asset darwin-arm64=release/LanPlay-mac-arm64.zip]
//       Writes dir/manifest.json + dir/manifest.sig. Upload both next to the installers on the GitHub release v<version>.
//   The key can also come from the UPDATE_SIGNING_KEY environment variable (PEM text), e.g. for CI.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

const REPO = 'Garvvaiahnav/lanplay';
const KEY_DIR = join(homedir(), 'Library', 'Application Support', 'lanplay-release');
const KEY_FILE = join(KEY_DIR, 'update-signing-key.pem');

function fail(msg) {
  console.error(`release-sign: ${msg}`);
  process.exit(1);
}

function publicB64(privateKey) {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
}

function loadPrivate() {
  const pem = process.env.UPDATE_SIGNING_KEY || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8') : null);
  if (!pem) fail(`no signing key: run "keygen" first (expected ${KEY_FILE}) or set UPDATE_SIGNING_KEY`);
  return createPrivateKey(pem);
}

function parseArgs(argv) {
  const o = { assets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asset') o.assets.push(argv[++i]);
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--notes-file') o.notesFile = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else fail(`unknown argument ${a}`);
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'keygen') {
  if (existsSync(KEY_FILE)) {
    console.log(`Key already exists: ${KEY_FILE}`);
    console.log(`Public key (base64): ${publicB64(createPrivateKey(readFileSync(KEY_FILE, 'utf8')))}`);
    process.exit(0);
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  console.log(`Private key written to ${KEY_FILE} (back it up: if it is lost, installed copies can never update again).`);
  console.log(`Public key (base64): ${publicB64(privateKey)}`);
} else if (cmd === 'manifest') {
  const o = parseArgs(rest);
  if (!o.version || !/^\d+\.\d+\.\d+$/.test(o.version)) fail('--version x.y.z is required');
  if (!o.out) fail('--out <dir> is required');
  if (o.assets.length === 0) fail('at least one --asset <platform-arch>=<file> is required');
  const assets = {};
  for (const spec of o.assets) {
    const eq = spec.indexOf('=');
    if (eq < 1) fail(`bad --asset "${spec}" (use win32-x64=path)`);
    const key = spec.slice(0, eq);
    const file = spec.slice(eq + 1);
    const bytes = readFileSync(file);
    assets[key] = {
      url: `https://github.com/${REPO}/releases/download/v${o.version}/${basename(file)}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: statSync(file).size,
    };
  }
  const notes = o.notesFile ? readFileSync(o.notesFile, 'utf8').trim() : '';
  const manifest = JSON.stringify({ schema: 1, version: o.version, notes, assets }, null, 2) + '\n';
  const privateKey = loadPrivate();
  const data = Buffer.from(manifest, 'utf8');
  const sig = sign(null, data, privateKey);
  if (!verify(null, data, createPublicKey(privateKey), sig)) fail('self-check of the signature failed');
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, 'manifest.json'), data);
  writeFileSync(join(o.out, 'manifest.sig'), sig.toString('base64') + '\n');
  console.log(`Wrote ${join(o.out, 'manifest.json')} and manifest.sig for v${o.version} (${Object.keys(assets).join(', ')}).`);
  console.log(`Public key in use (must equal UPDATE_PUBLIC_KEY_B64 in update.ts): ${publicB64(privateKey)}`);
} else {
  fail('usage: release-sign.mjs keygen | manifest --version x.y.z --out dir --asset platform-arch=file ...');
}
