# LanPlay

One small app that replaces the Sunshine + Moonlight setup dance on your own home network.
Windows PC = **host** (installs and configures Sunshine for you). Mac mini = **client** (finds the PC, pairs without
typing a PIN, and starts Moonlight with good settings). Status: **v0.1 skeleton**; see `SPEC.md`.

## Use it
- **Windows PC (host):** unzip the portable build, run `LanPlay.exe`, click **Set up this PC**, accept the one
  Windows admin prompt. Leave "Auto-approve devices on my network" on. Check **Devices** to revoke a Mac.
- **Mac mini (client):** open `LanPlay.app`, pick your PC, pick a preset (Lowest latency / Balanced / Best picture),
  press **Stream**. First time it pairs automatically.
- Something wrong? Click **Run self-check**, then **Copy diagnostics** and send the zip
  (CLI: `LanPlay --self-check`, `LanPlay --diagnostics`).

## Tested vs not tested
- Tested on the Mac: unit tests (`npm test`), type check (`npm run typecheck`), mock Sunshine server, fake Moonlight
  CLI, PowerShell syntax check with portable pwsh 7.7.
- **Not tested yet:** the real Windows host (installer, service, firewall), real pairing and real streaming.
  The first run on the PC is the test; diagnostics are built to fix any failure in one round.

## License and source
LanPlay is GPL-3.0-only (`LICENSE`). It bundles Sunshine v2026.914.233613 and moonlight-qt v6.2.0, both GPL-3.0;
their licenses ship with the app and their exact sources are listed in `SOURCE-OFFER.md`.

## Security notes
- Works only on your LAN: no cloud, no accounts, no telemetry. Sunshine's web UI is LAN-only, UPnP off.
- The pair agent (port 47920) only answers private-network addresses and rejects browser requests.
- Sunshine gets a random admin password stored in the OS keychain (DPAPI on Windows); logs never contain it or PINs.
- Third-party binaries are pinned by SHA256 in `vendor/manifest.json` and verified by `scripts/fetch-vendor.mjs`.
