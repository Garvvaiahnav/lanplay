// electron-builder config (use: electron-builder --config scripts/electron-builder.config.cjs ...).
// macOS: unsigned local build (dir, arm64); Moonlight.app is copied by scripts/after-pack.cjs with `ditto` so its
//        notarized signature stays intact (no signing step touches it because identity is null).
// Windows: portable dir + zip + one-click per-user NSIS setup. Ships Sunshine MSI (host) and portable Moonlight (client). signAndEditExecutable:false avoids rcedit/wine when building on a Mac.
//          Also ships the phone-controller pieces: ViGEmClient.dll (loaded through koffi) and the ViGEmBus driver installer.
// koffi (FFI, node_modules/koffi + one prebuilt-binary package per platform, @koromix/koffi-<os>-<arch>): only the Windows
//   x64 binary is packed (into the Windows build, unpacked from the asar so it can be dlopen()ed). The Mac app is a client
//   only (never creates virtual pads): it carries koffi's small JS loader but no native binary, and never loads it. `npm run pack:win` runs
//   scripts/ensure-koffi-native.mjs first because npm on a Mac does not install the win32 package by itself.
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.lanplay.app',
  productName: 'LanPlay',
  copyright: 'LanPlay contributors, GPL-3.0-only',
  directories: { output: 'release' },
  asar: true,
  // Every native .node must live outside the asar. koffi only: its win32-x64 package (see files).
  asarUnpack: ['node_modules/@koromix/koffi-win32-x64/**'],
  files: [
    'package.json',
    'dist/**/*',
    '!dist/**/*.map',
    '!**/*.ts',
    // koffi ships C++ sources, docs and build tooling next to its JS loader (src/koffi/index.cjs and src/koffi/src/*.cjs are the loader).
    '!node_modules/koffi/{doc,lib,vendor}/**',
    '!node_modules/koffi/{cnoke.cjs,CHANGELOG.md,README.md}',
    '!node_modules/koffi/src/koffi/CMakeLists.txt',
    '!node_modules/koffi/src/koffi/src/**/*.{cc,hh,inc,def,S,asm,masm}',
    '!node_modules/koffi/src/koffi/src/abi/**',
    // One koffi binary per app: win32-x64 only (scripts/after-pack.cjs asserts it). Not a per-platform `files` list on purpose:
    // electron-builder prepends '**/*' to a platform list that starts with '!', which packs the whole project dir.
    '!node_modules/@koromix/koffi-{android-*,darwin-*,freebsd-*,linux-*,openbsd-*,win32-arm64,win32-ia32}/**',
  ],
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
  nsis: {
    oneClick: true,          // double-click setup .exe: no wizard, installs per-user (no admin prompt)
    perMachine: false,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    artifactName: 'LanPlay-Setup-${version}.${ext}',
  },
  win: {
    target: [
      { target: 'dir', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
      { target: 'nsis', arch: ['x64'] },
    ],
    signAndEditExecutable: false,
    extraResources: [
      { from: 'vendor/sunshine-windows-msi/Sunshine-Windows-AMD64-installer.msi', to: 'vendor/Sunshine-Windows-AMD64-installer.msi' },
      { from: 'scripts/windows', to: 'ps', filter: ['*.ps1'] },
      // Phone controllers: ViGEmClient.dll (MIT, loaded by koffi) and the ViGEmBus (BSD-3-Clause) driver installer.
      { from: 'vendor/vigemclient-windows-x64/ViGEmClient.dll', to: 'vendor/ViGEmClient.dll' },
      { from: 'vendor/vigembus-windows-installer/ViGEmBus_1.22.0_x64_x86_arm64.exe', to: 'vendor/ViGEmBus_1.22.0_x64_x86_arm64.exe' },
      { from: 'third-party-licenses/ViGEmBus-BSD-3-Clause.txt', to: 'licenses/ViGEmBus-BSD-3-Clause.txt' },
      { from: 'third-party-licenses/ViGEmClient-MIT.txt', to: 'licenses/ViGEmClient-MIT.txt' },
      { from: 'third-party-licenses/koffi-MIT.txt', to: 'licenses/koffi-MIT.txt' },
      // Portable moonlight-qt for the Windows client role (Moonlight.exe at the folder root). The source zip is not shipped.
      { from: 'vendor/moonlight-windows', to: 'vendor/moonlight-windows', filter: ['**/*', '!MoonlightPortable-*.zip'] },
    ],
  },
};
