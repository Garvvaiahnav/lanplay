// electron-builder afterPack hook: copy the pinned Moonlight.app and Sunshine.app into LanPlay.app/Contents/Resources/vendor
// with `ditto` (preserves symlinks, xattrs and the notarized code signatures), then verify each signature (Sunshine also
// its team id, pinned in vendor/manifest.json).
// argv arrays only, no shell.
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function pinnedArtifact(id) {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'vendor', 'manifest.json'), 'utf8'));
  const a = manifest.artifacts.find((x) => x.id === id);
  if (!a) throw new Error(`${id} is not in vendor/manifest.json`);
  return a;
}

/** `TeamIdentifier=ABCDE12345` from `codesign -dv` output; undefined for unsigned or "not set". */
function parseTeamId(codesignOutput) {
  const m = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(codesignOutput);
  return m ? m[1] : undefined;
}

/** Copies a vendored .app into destDir with ditto, verifies its signature and, when teamId is given, that team. Throws on any problem. */
function bundleVendorApp({ name, src, binary, destDir, teamId }) {
  if (!existsSync(path.join(src, binary))) throw new Error(`${name} missing at ${src}. Run: node scripts/fetch-vendor.mjs`);
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  rmSync(dest, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', [src, dest], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', dest], { stdio: 'inherit' });
  if (teamId) {
    // codesign -dv writes to stderr
    const info = spawnSync('/usr/bin/codesign', ['-dv', dest], { encoding: 'utf8' });
    const got = parseTeamId(`${info.stdout}${info.stderr}`);
    if (got !== teamId) throw new Error(`${name} is signed by team ${got ?? 'none'}, expected ${teamId}`);
  }
  console.log(`after-pack: bundled ${dest} (signature verified${teamId ? `, team ${teamId}` : ''})`);
}

// Windows: the phone-controller driver layer needs koffi's win32-x64 addon, outside the asar, and nothing else from koffi.
function assertWindowsKoffi(context) {
  const koromix = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', '@koromix');
  const node = path.join(koromix, 'koffi-win32-x64', 'win32_x64', 'koffi.node');
  if (!existsSync(node)) throw new Error(`koffi win32-x64 addon missing at ${node}. Run: node scripts/ensure-koffi-native.mjs win32-x64`);
  const others = readdirSync(koromix).filter((n) => n !== 'koffi-win32-x64');
  if (others.length) throw new Error(`unexpected koffi platform packages in the Windows build: ${others.join(', ')}`);
  console.log(`after-pack: koffi win32-x64 addon unpacked (${node})`);
}

// macOS: the app is a client and never creates virtual pads, so it must not carry koffi's Windows addon. The shared `files`
// list lets win32-x64 through (it is the only koffi binary kept), and it is present on a Mac after `npm run pack:win`.
function dropKoffiNative(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const unpacked = path.join(context.appOutDir, appName, 'Contents', 'Resources', 'app.asar.unpacked');
  rmSync(path.join(unpacked, 'node_modules', '@koromix'), { recursive: true, force: true });
  if (existsSync(path.join(unpacked, 'node_modules')) && readdirSync(path.join(unpacked, 'node_modules')).length === 0) rmSync(path.join(unpacked, 'node_modules'), { recursive: true });
  if (existsSync(unpacked) && readdirSync(unpacked).length === 0) rmSync(unpacked, { recursive: true });
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return assertWindowsKoffi(context);
  if (context.electronPlatformName !== 'darwin') return;
  dropKoffiNative(context);
  const vendorDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'vendor');
  bundleVendorApp({ name: 'Moonlight.app', src: path.join(ROOT, 'vendor', 'moonlight-macos', 'Moonlight.app'), binary: 'Contents/MacOS/Moonlight', destDir: vendorDir });
  const sunshine = pinnedArtifact('sunshine-macos-arm64');
  bundleVendorApp({ name: 'Sunshine.app', src: path.join(ROOT, 'vendor', sunshine.id, 'Sunshine.app'), binary: 'Contents/MacOS/Sunshine', destDir: vendorDir, teamId: sunshine.teamId });
};
exports.bundleVendorApp = bundleVendorApp;
exports.parseTeamId = parseTeamId;
