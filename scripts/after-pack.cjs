// electron-builder afterPack hook: copy the pinned Moonlight.app into LanPlay.app/Contents/Resources/vendor with
// `ditto` (preserves symlinks, xattrs and the notarized code signature), then verify the signature.
// argv arrays only, no shell.
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
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
