# LanPlay

One small app that replaces the Sunshine + Moonlight setup dance on your own home network.
Windows PC = **host** (installs and configures Sunshine for you). Mac mini = **client** (finds the PC, pairs without
typing a PIN, and starts Moonlight with good settings). Status: **v0.1, not yet run on real hardware**; see `SPEC.md`.

## Use it
- **Windows PC (host):** build it there once with `scripts\build-windows.ps1`, run `release\win-unpacked\LanPlay.exe`
  (normally, not "as administrator"), click **Install and set up**, accept the one Windows admin prompt. Leave
  "Auto-approve devices on my network" on. **Paired devices** lets you revoke a Mac. Closing the window keeps it running.
- **Mac mini (client):** `npm ci && node scripts/fetch-vendor.mjs && npm run pack:mac` (`npm ci` fetches the Electron
  runtime from github.com/electron/electron, checksum-verified), open `release/mac-arm64/LanPlay.app`, pick a preset,
  press **Pair and stream**. Allow "Local Network" when macOS asks.
- Something wrong? **Run self-check**, then **Copy diagnostics** and send the zip
  (CLI: `LanPlay --self-check`, `LanPlay --diagnostics`).
- If Sunshine is already installed it is kept, but its web login becomes a LanPlay-managed one. An old (NSIS) Sunshine
  must be uninstalled first; setup says so.

## Tested vs not tested
- Tested on the Mac: `npm run typecheck`, `npm test` (unit + end-to-end against a mock Sunshine HTTPS server and a fake
  Moonlight CLI), PowerShell parse + PSScriptAnalyzer with pinned pwsh 7.7 (`npm run check:ps`), vendor hashes
  (`npm run vendor:verify`), the real Moonlight 6.2.0 `--help` flags, and the screens in a browser with a stub backend.
- **Not tested:** the app has never been started under Electron (the Electron binary comes from
  github.com/electron/electron, outside the download allow-list: your decision) and was never packaged; the real
  Windows host (MSI, service, firewall, UAC, Windows PowerShell 5.1); real pairing; real streaming.
  The first run on the PC is the test; diagnostics are built to fix a failure in one round.

## License and source
LanPlay is GPL-3.0-only (`LICENSE`). It bundles Sunshine v2026.914.233613 and moonlight-qt v6.2.0, both GPL-3.0;
their licenses ship with the app and their exact sources are listed in `SOURCE-OFFER.md`.

## Security notes
- Home network only: no cloud, no accounts, no telemetry. Sunshine's web UI is LAN-only, UPnP off.
- With auto-approve ON, any device on your LAN can pair (your choice); switch it OFF to approve each device.
- The pair agent (port 47920, plain HTTP) answers private addresses only, rejects browser requests and is rate limited.
- Sunshine's random admin password is kept by Windows (DPAPI); logs and diagnostics never contain it or PINs.
- Third-party binaries are pinned by SHA256 in `vendor/manifest.json`; Sunshine's certificate is pinned, never ignored.
