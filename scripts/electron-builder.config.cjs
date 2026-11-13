// electron-builder config (use: electron-builder --config scripts/electron-builder.config.cjs ...).
// macOS: unsigned local build (dir, arm64); Moonlight.app is copied by scripts/after-pack.cjs with `ditto` so its
//        notarized signature stays intact (no signing step touches it because identity is null).
// Windows: portable dir + zip only (no NSIS). signAndEditExecutable:false avoids rcedit/wine when building on a Mac.
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.lanplay.app',
  productName: 'LanPlay',
  copyright: 'LanPlay contributors, GPL-3.0-only',
  directories: { output: 'release' },
  asar: true,
  files: ['package.json', 'dist/**/*', '!dist/**/*.map', '!**/*.ts'],
  extraResources: [
    { from: 'LICENSE', to: 'LICENSE' },
    { from: 'SOURCE-OFFER.md', to: 'SOURCE-OFFER.md' },
    // Sunshine and moonlight-qt are GPL-3.0 (same license text as LanPlay's LICENSE).
    { from: 'LICENSE', to: 'licenses/Sunshine-GPL-3.0.txt' },
    { from: 'LICENSE', to: 'licenses/moonlight-qt-GPL-3.0.txt' },
  ],
  afterPack: './scripts/after-pack.cjs',
  mac: {
    // dir only: a dmg would make electron-builder download extra helper binaries (outside the download allow-list).
    target: [{ target: 'dir', arch: ['arm64'] }],
    category: 'public.app-category.games',
    identity: null,
    hardenedRuntime: false,
    extendInfo: {
      // Without these, macOS silently blocks LAN discovery (Local Network privacy).
      NSLocalNetworkUsageDescription: 'LanPlay looks for your gaming PC on your home network and connects Moonlight to it.',
      NSBonjourServices: ['_nvstream._tcp'],
    },
  },
  win: {
    target: [
      { target: 'dir', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    signAndEditExecutable: false,
    extraResources: [
      { from: 'vendor/sunshine-windows-msi/Sunshine-Windows-AMD64-installer.msi', to: 'vendor/Sunshine-Windows-AMD64-installer.msi' },
      { from: 'scripts/windows', to: 'ps', filter: ['*.ps1'] },
    ],
  },
};
