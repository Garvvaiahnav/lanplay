// electron-builder afterPack hook: copy the pinned Moonlight.app into LanPlay.app/Contents/Resources/vendor with
// `ditto` (preserves symlinks, xattrs and the notarized code signature), then verify the signature.
// argv arrays only, no shell.
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs');
const path = require('node:path');

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
  const src = path.resolve(__dirname, '..', 'vendor', 'moonlight-macos', 'Moonlight.app');
  if (!existsSync(path.join(src, 'Contents', 'MacOS', 'Moonlight'))) {
    throw new Error(`Moonlight.app missing at ${src}. Run: node scripts/fetch-vendor.mjs`);
  }
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const destDir = path.join(context.appOutDir, appName, 'Contents', 'Resources', 'vendor');
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'Moonlight.app');
  execFileSync('/usr/bin/ditto', [src, dest], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', dest], { stdio: 'inherit' });
  console.log(`after-pack: bundled ${dest} (signature verified)`);
};
