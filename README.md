# LanPlay

One small app that replaces the Sunshine + Moonlight setup dance on your own home network.
One installer per OS does both jobs: on Windows you choose **host** (installs and configures Sunshine for you) or
**viewer** (finds the host, pairs without typing a PIN, streams with Moonlight). Status: **v0.2, early; the Windows-to-Windows
path has not been verified on real hardware yet**; see `SPEC.md` and `docs/WINDOWS-TEST.md`.

## Install
Download the latest installer from **Releases**: `LanPlay-Setup-<version>.exe` for Windows. Run it (per-user, no admin
prompt for LanPlay itself). Windows SmartScreen may say "Windows protected your PC" because the app is unsigned: More info,
then Run anyway. The first time, pick **Host** on the PC that has the games and **Viewer** on the PC you play from.
The macOS build (Apple Silicon) can be a viewer or a host: a Mac host runs the bundled Sunshine for macOS under per-user LaunchAgents (see docs/MAC-HOST-DESIGN.md and docs/MAC-HOST-TEST.md). Phone controllers need a virtual gamepad driver, which does not exist on macOS yet, so they work on a Windows host only for now.

## While streaming
- Windows key, Alt+Tab and other system keys go to the host PC, not your own computer.
- Rest the mouse in any screen corner for half a second: a menu appears with **Close stream**, **Change settings**,
  **Reconnect** and **Keep playing**. In-game mouse lock hides the pointer from LanPlay, so use Ctrl+Alt+Shift+Q to quit there.

## Phone as controller
The host PC can turn phones into Xbox controllers (no app on the phone, fully customizable layouts saved on the host). See `docs/PHONE-CONTROLLER.md`.

## Updates
LanPlay checks GitHub Releases at start and every 6 hours. A new version is downloaded, verified against an Ed25519-signed
manifest (public key in `src/core/update/update.ts`) and its SHA-256, then offered: "Restart and update". Nothing
unsigned is ever run. The footer of every screen shows the version and a "Check for updates" button that runs the same check
on demand. See `docs/RELEASING.md` for how a release is signed and published.

## Build from source
- **Windows host or viewer:** `npm ci`, `node scripts/fetch-vendor.mjs --windows`, then
  `npx electron-builder --config scripts/electron-builder.config.cjs --win nsis --x64 --publish never`
  (or `scripts\build-windows.ps1` on Windows).
- **Mac viewer or host:** `npm ci && node scripts/fetch-vendor.mjs && npm run pack:mac`, open `release/mac-arm64/LanPlay.app`,
  allow "Local Network" when macOS asks.
- Something wrong? **Run self-check**, then **Copy diagnostics** and send the zip
  (CLI: `LanPlay --self-check`, `LanPlay --diagnostics`).
- If Sunshine is already installed it is kept, but its web login becomes a LanPlay-managed one. An old (NSIS) Sunshine
  must be uninstalled first; setup says so.

## Tested vs not tested
- Tested on a Mac: `npm run typecheck`, `npm test` (unit + end-to-end against a mock Sunshine HTTPS server and a fake
  Moonlight CLI), the corner-menu window in real Electron, PowerShell parse + PSScriptAnalyzer (`npm run check:ps`), vendor hashes
  (`npm run vendor:verify`).
- **Not tested on real Windows yet:** system-key capture, the corner menu over a fullscreen stream, the silent self-update
  installer, the Sunshine MSI/service/firewall/UAC steps, real pairing and streaming. The first run on the PCs is the test;
  diagnostics are built to fix a failure in one round.

## License and source
LanPlay is GPL-3.0-only (`LICENSE`). It bundles Sunshine v2026.914.233613 and moonlight-qt v6.2.0, both GPL-3.0;
their licenses ship with the app and their exact sources are listed in `SOURCE-OFFER.md`.

## Security notes
- Home network only: no cloud, no accounts, no telemetry. Sunshine's web UI is LAN-only, UPnP off.
- With auto-approve ON, any device on your LAN can pair (your choice); switch it OFF to approve each device.
- The pair agent (port 47920, plain HTTP) answers private addresses only, rejects browser requests and is rate limited.
- Sunshine's random admin password is kept by Windows (DPAPI); logs and diagnostics never contain it or PINs.
- Third-party binaries are pinned by SHA256 in `vendor/manifest.json`; Sunshine's certificate is pinned, never ignored.
