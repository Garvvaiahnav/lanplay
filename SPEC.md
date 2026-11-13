# LanPlay v1 spec

One Electron + TypeScript app, one codebase. On the **Windows PC** it is the **host**: it installs and configures
Sunshine silently and runs a small LAN-only *pair agent*. On the **Mac mini (M4)** it is the **client**: it finds the
PC, pairs with no PIN typing, and launches the bundled moonlight-qt with the right flags.

Pinned upstreams (all GPL-3.0): Sunshine **v2026.914.233613** (commit `63d35f70`), moonlight-qt **v6.2.0**
(commit `de2467e4`). Hashes are in `vendor/manifest.json`. The single source of truth for types, IPC and
doc-derived constants is **`src/contracts.ts`**.

**Out of scope for v1** (do not build): Windows as client, Mac as host, HDR, surround, gamepad tuning, virtual displays,
Wake-on-LAN, installers/signing/auto-update, tray, multi-host management.

---

## 1. Architecture

```
 Mac mini (client)                                   Windows PC (host)
 ┌──────────────────────────────┐                    ┌───────────────────────────────────────────┐
 │ renderer (sandboxed, CSP)    │                    │ renderer: Setup / Devices / Auto-approve  │
 │  host picker, presets,       │                    │        │ window.lanplay (preload allow-list)
 │  sliders, Stream button      │                    │ main ───┼── HostService                     │
 │        │ window.lanplay      │                    │         ├─ steps (TS) ── ProcessRunner ───┐ │
 │ main ──┼─ ClientService      │   UDP 47920 probe  │         │      execFile(argv[])            │ │
 │        ├─ Discovery ─────────┼──── mDNS _nvstream ┼─────────┤  host/ps/*.ps1 (thin, JSON out)  │ │
 │        │   (mdns/udp/probe)  │   GET :47989/serverinfo      ├─ PairAgent  :47920 (HTTP, LAN)  ◄┘ │
 │        ├─ PairingService ────┼─ POST :47920/v1/pair ──────► │    guards: private IP, Host,      │
 │        └─ MoonlightRunner    │                    │         │    no Origin, JSON, rate limit    │
 │             │ spawn argv[]   │                    │         └─ SunshineClient ──HTTPS pinned──► │
 │       Moonlight.app (bundled)┼── GameStream ──────┼──► Sunshine service (SunshineService)       │
 └──────────────────────────────┘ 47984/89/90 48010  │     https://127.0.0.1:47990 /api/*         │
                                  UDP 47998-48000    └───────────────────────────────────────────┘
```

Role = `darwin → client`, `win32 → host` (override `--role`). Same binary also runs headless for
`--self-check`, `--diagnostics`, `--agent` (login item) and `--host-setup` (elevated child). See `CLI_FLAGS`.

## 2. Module list and ownership

| Path | Owner | What |
|---|---|---|
| `src/contracts.ts` | architect | types, constants, IPC maps. Change only via "Contract changes" below |
| `src/main/main.ts`, `cli.ts`, `ipc.ts`, `security.ts`, `paths.ts`, `secrets.ts`, `settings.ts` | A | Electron shell, CLI dispatch, IPC router with payload validation, `SECURITY` policy, `AppPaths`, `SecretStore`, `KeyValueStore` |
| `src/preload/preload.ts` | A | `window.lanplay` = `LanPlayPreloadApi`, channel allow-list from `IPC_*_CHANNELS` |
| `src/renderer/*` | A | Client screen and Host screen (both talk only through `window.lanplay`) |
| `src/shared/logger.ts`, `redact.ts`, `exec.ts`, `diagnostics.ts` | A | JSONL `Logger`, `Redactor`, `ProcessRunner` (execFile, shell:false, windowsHide), zip (yazl) |
| `src/client/*` (`discovery.ts`, `serverinfo.ts`, `codec.ts`, `chip.ts`, `moonlight.ts`, `pairing.ts`, `selfcheck.ts`, `index.ts`) | A | `ClientService` |
| `src/shared/ipnet.ts` | B | `NormalizeAddress`, `IsPrivateAddress` (used by agent; A may import) |
| `src/host/*` (`sunshine-locate.ts`, `steps/*.ts`, `sunshine-conf.ts`, `sunshine-client.ts`, `agent.ts`, `firewall.ts`, `elevate.ts`, `winargs.ts`, `selfcheck.ts`, `index.ts`) | B | `HostService` |
| `src/host/ps/*.ps1` | B | thin wrappers listed in `PsScriptName` |
| `scripts/check-ps.mjs`, `scripts/build-windows.ps1` | B | PS static check, Windows portable build |
| `scripts/fetch-vendor.mjs` | architect (done) | download + SHA256 verify of pinned binaries |
| `tests/fixtures/mock-sunshine.ts`, `tests/fixtures/sunshine-cert.pem/key.pem` | B | mock Sunshine HTTPS server (section 7) |
| `tests/fixtures/fake-moonlight.mjs` | A | fake moonlight CLI (section 7) |

Both sides plug into main via `createClientService(deps)` / `createHostService(deps)` (stubs exist in
`src/client/index.ts`, `src/host/index.ts`). A writes main.ts against the `ClientService`/`HostService` interfaces
and must not import anything else from `src/host`.

## 3. Data flows

### 3.1 Host setup (Windows, "Set up this PC" button or `--host-setup`)
1. Non-elevated app: create `%ProgramData%\LanPlay\logs` (fallback `%LOCALAPPDATA%\LanPlay\logs`), generate admin
   password (32 random bytes, base64url), store it in `SecretStore` (DPAPI via safeStorage), write a
   `HostSetupHandoff` JSON next to the logs, run `invoke-elevated.ps1` → `LanPlay.exe --host-setup --handoff f --result r`
   (args quoted with `QuoteWindowsArg`; UAC prompt is the only user interaction).
2. Elevated child reads + deletes the handoff and runs `HOST_STEP_ORDER` `apply()`; each step is idempotent and
   writes a `StepRecord` to `lanplay-<date>.elevated.log`:
   - `locate-sunshine`: `get-sunshine-facts.ps1` → service `PathName` (strip quotes, `…\tools\sunshinesvc.exe` → root) →
     uninstall `InstallLocation` → fallback `%ProgramW6432%`, `%ProgramFiles%`, `%ProgramFiles(x86)%` + `\Sunshine`.
     All `path.win32`. If an old NSIS install is found (UninstallString ends `uninstall.exe`), FAIL with the upstream
     instruction to uninstall it first (do not auto-uninstall).
   - `install-sunshine` (only if not found): `msiexec.exe /i <bundled msi> /qn /norestart /l*v %ProgramData%\LanPlay\logs\msiexec-<ts>.log`.
     `/qn` ⇒ UILevel 2 ⇒ upstream runs its *silent* custom action (firewall rule, service, autostart). That action has
     `Return="ignore"`, so the following steps **verify and repair** every effect themselves.
   - `service`: SunshineService exists → `sc.exe config SunshineService start= auto` if needed → running.
     If missing: run `<root>\scripts\install-service.bat` and `autostart-service.bat` (upstream scripts).
   - `config`: `MergeSunshineConf(<root>\config\sunshine.conf, SUNSHINE_MANAGED_CONFIG)`; write only if changed.
   - `credentials`: `<root>\sunshine.exe --creds lanplay <password>` (argv array; password registered with Redactor).
   - `restart-service`, `web-ui` (47990 listening; copy `config\credentials\cacert.pem` to
     `%ProgramData%\LanPlay\sunshine-cert.pem`, record `fingerprint256`), `api-auth` (GET /api/clients/list = 200),
     `firewall-sunshine` (rule "Sunshine" present else `<root>\scripts\add-firewall-rule.bat`),
     `firewall-agent` (`set-agent-firewall-rule.ps1`: TCP+UDP 47920, RemoteAddress LocalSubnet, all profiles).
3. Child writes `HostSetupResult`; parent shows per-step pass/fail, then sets the login item (`--agent`) and starts the agent.

### 3.2 Pairing without PIN typing
moonlight-qt does **not** print the PIN; it accepts one (`--pin`). So the client generates it.
1. Client: `Moonlight list <ip>`; exit 0 ⇒ already paired, done.
2. Client: `pin = crypto.randomInt(0,10000)` zero-padded; spawn `Moonlight pair <ip> --pin <pin>` (a small Moonlight window
   appears), then `POST http://<ip>:47920/v1/pair {pin, clientName, clientId}`.
3. Agent: guards (contracts §7) → if auto-approve OFF, park as `PendingApproval` (202, client polls `GET /v1/pair/<id>`,
   host UI shows Approve/Deny, expires after 120 s).
4. Agent: poll `GET /api/pin` every 500 ms (≤ 20 s) for a pending pairing whose `address` equals the requester's
   normalised IP. **No address match ⇒ refuse** (`no-pending-pairing`, log the addresses seen). Then
   `POST /api/pin {pairing_id, pin, name: clientName}`; Sunshine holds it until the handshake ends → `{"status":true}`.
5. Agent records the device in `%ProgramData%\LanPlay\paired-devices.json`, answers `paired`.
6. Client: wait `PAIR_TIMING.postSuccessFlushMs` (Moonlight flushes hosts on a worker thread), terminate the pair window
   if still open, then `Moonlight list <ip>` must exit 0, else `verify-failed`.
Revoke = `POST /api/clients/unpair {uuid}` from the Devices list.

### 3.3 Discovery
In parallel: mDNS browse `_nvstream._tcp` (`bonjour-service` 1.4.4, MIT, maintained); UDP `LANPLAY-DISCOVER-1` to
255.255.255.255 and each interface's directed broadcast on 47920 (agent replies `AgentDiscoveryReply`); after 3 s with no
host, TCP-probe 47989 on each local IPv4 subnet (cap 1024 addresses, 300 ms timeout, 64 concurrent). Every candidate is
confirmed with `GET http://<ip>:47989/serverinfo` (XML: `hostname`, `uniqueid`, `ServerCodecModeSupport`). Manual IP entry
uses the same confirmation. macOS needs `NSLocalNetworkUsageDescription` and `NSBonjourServices = [_nvstream._tcp]`
in Info.plist (electron-builder `mac.extendInfo`), or the local-network prompt/denial will silently break discovery.

### 3.4 Stream
`['stream', ip, appName, --1080|--1440|--4K, --fps N, --bitrate Mbps*1000, --video-codec auto|H.264|HEVC|AV1,
--audio-config stereo, --display-mode M, --vsync|--no-vsync, --frame-pacing|--no-frame-pacing]`.
Codec Auto (`ResolveCodec`): AV1 only if chip generation ≥ 3 (`os.cpus()[0].model` = "Apple M4" on this Mac) **and** the
host advertises AV1 in `ServerCodecModeSupport`; else HEVC; else H.264. Keyboard/mouse are Moonlight's own.

## 4. Security
- Electron: `SECURITY` in contracts (contextIsolation, sandbox, no nodeIntegration, CSP, navigation and `window.open`
  denied except listed license URLs via `shell.openExternal`, all permission requests denied). Main validates every IPC
  payload; errors cross as `IpcEnvelope`.
- Agent: private-range sources only (IPv4-mapped IPv6 unmapped first), Host header allow-list (DNS rebinding), any
  Origin/Referer ⇒ 403 (CSRF), JSON content-type only, no CORS, 4 KiB bodies, token-bucket rate limit, PIN must be 4
  digits, client name sanitised, Sunshine address match, auto-approve switch (default ON, Garv's choice), Devices list
  with Revoke. Transport is plain HTTP on the LAN: with auto-approve ON any LAN device can pair anyway, so this is
  accepted for v1 and documented.
- Sunshine REST: only `https://127.0.0.1:47990`, Basic auth, **no Origin/Referer**, TLS `ca=[pinned cacert.pem]`,
  `rejectUnauthorized: true`, `checkServerIdentity` compares `fingerprint256` (checked locally: Node 26 accepts an
  extension-less self-signed cert this way). Never `rejectUnauthorized:false`.
- Secrets: `safeStorage` (Keychain / DPAPI) else 0600 file. Redactor masks passwords, PINs, `pairing_id`,
  `Authorization`, `--creds` and `--pin` argv values in logs, step records, REST records and diagnostics.
  Known exposure: `sunshine.exe --creds` puts the password on a process command line for < 1 s (upstream has no other
  non-interactive way without existing creds).
- Processes: `execFile`/`spawn` with argv arrays, `shell:false`; absolute tool paths from `%SystemRoot%`.
- Downloads: only `scripts/fetch-vendor.mjs` (allow-listed GitHub release URLs, SHA256 enforced) and npm.

## 5. Diagnostics and self-check
JSONL logs: `%ProgramData%\LanPlay\logs\lanplay-<date>.log` (+ `.elevated.log`), macOS `~/Library/Logs/LanPlay`.
"Copy diagnostics" / `--diagnostics` writes one zip; layout is in `DiagnosticsService` (contracts). It must contain
app/OS/GPU versions + admin status, every `StepRecord` (command, argv, exit code, stdout/stderr tails, duration),
Sunshine version/service state/`sunshine.log` tail, every `RestCallRecord` (redacted), firewall rules, listen state of
47984/47989/47990/48010/47920, local IPs, resolved paths, installer logs, Moonlight logs (`/tmp/Moonlight-*.log`).
"Run self-check" / `--self-check` runs every step's `probe()` independently (a failed probe never stops the next one).

## 6. Packaging
- macOS: `electron-builder --mac dir --arm64`; `extraResources`: `vendor/moonlight-macos/Moonlight.app` (copy with
  `ditto`-equivalent, keep its notarized signature). Our own app is unsigned (local build, not quarantined).
- Windows: portable `dir`/zip only (no NSIS). On the Mac, `win.signAndEditExecutable: false` avoids rcedit/wine; the
  full build is `scripts/build-windows.ps1` on the PC (fetch + verify MSI, `npm ci`, `electron-builder --win dir --x64`, zip).
  `extraResources`: MSI → `vendor/`, `src/host/ps/*.ps1` → `ps/`, `LICENSE`, `SOURCE-OFFER.md`.
- GPL: LanPlay is GPL-3.0-only; ship `LICENSE`, upstream license texts, and a source offer pointing to the exact tags.

## 7. Testing (what "correct without being run" means)
- **Mock Sunshine** (`tests/fixtures/mock-sunshine.ts`, Builder B): Node `https` server on 127.0.0.1:0 with a committed
  test-only self-signed cert. Reproduces, from the quotes in §9: Basic auth (307 to `/welcome` when no user),
  403 for disallowed origins, `Content-Type: application/json` check, CSRF rule (Origin/Referer without token ⇒ 400/403),
  `GET/POST/DELETE /api/pin` (32-hex id, 4-digit PIN, 1..128-byte name, POST held until a scripted handshake result),
  `/api/clients/list`, `/api/clients/unpair`, `/api/config`. Also a "wrong cert" mode for pin-mismatch tests.
- **Fake Moonlight** (`tests/fixtures/fake-moonlight.mjs`, Builder A): `pair <host> --pin dddd` registers a pending
  pairing on the mock (via a test hook URL in env) and stays alive until terminated; `list <host>` exits 0/255 from a
  state file; `stream` records argv and exits 0. Run through `MoonlightRunnerOptions.prefixArgs`.
- Unit tests: argv builders, codec rule, chip parse, presets clamp, `ipnet` (IPv4, IPv6, `::ffff:` mapped, zone ids),
  `QuoteWindowsArg` + `path.win32` with `C:\Program Files\Sunshine`, `C:\Users\Jörg Müller\…`, `C:\Users\山田\…`,
  trailing backslashes; `LocateSunshine` for each `foundVia` branch; `MergeSunshineConf` idempotence; agent guards
  (each rejection path) + rate limit + approval flow; Redactor on every record type; step `probe()` with a fake
  `ProcessRunner` returning recorded PS JSON.
- PowerShell: `scripts/check-ps.mjs` runs `vendor/pwsh-macos/pwsh-7.7.0/pwsh` with
  `[System.Management.Automation.Language.Parser]::ParseFile` on every `.ps1`, rejects PS7-only syntax (ternary, `??`,
  `&&`/`||` chains) because wrappers run on Windows PowerShell 5.1, and runs PSScriptAnalyzer if `Save-Module` from
  PowerShell Gallery works (otherwise prints "PSScriptAnalyzer skipped: <reason>").

## 8. Contract changes
Append here: date, what changed, why. Both builders re-run `npm run typecheck && npm test` after any change.

## 9. Verified facts (exact quotes)

**Sunshine** (tag v2026.914.233613)
- API auth — [docs/api.md](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/api.md):
  "You can authenticate using basic authentication with the admin username and password." and "Requests with no
  `Origin` or `Referer` header (as is typical for non-browser clients) are automatically allowed without a CSRF token".
- Pending pairings — [confighttp.cpp#L1741-L1763](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/confighttp.cpp#L1741-L1763):
  "List client pairing requests that are waiting for PIN approval." Output `{"pairings":[{"id","name","address"}]}`.
- Submit PIN — [confighttp.cpp#L1810-L1869](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/confighttp.cpp#L1810-L1869):
  "The request remains open for up to the configured `ping_timeout` while Moonlight completes the cryptographic
  handshake. A wrong PIN, protocol failure, cancellation, or timeout returns `{"status":false}`." Body
  `{"pairing_id": "<pairing_id>", "pin": "<pin>", "name": "Friendly Client Name"}`; errors
  "pairing_id must contain exactly 32 hexadecimal characters", "PIN must contain exactly 4 numeric digits".
  **Changed vs older Sunshine** (which took only `{pin,name}`): a `pairing_id` from `GET /api/pin` is now mandatory.
- Pending address — [nvhttp.cpp#L979](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/nvhttp.cpp#L979):
  `sess.async_insert_pin.address = net::addr_to_normalized_string(request->remote_endpoint().address());`
- Clients — [confighttp.cpp#L1255-L1275](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/confighttp.cpp#L1255-L1275)
  (`GET /api/clients/list` → `named_certs[{name,uuid,enabled}]`), unpair
  [#L1332-L1380](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/confighttp.cpp#L1332-L1380) body `{"uuid": "<uuid>"}`.
- Credentials — [logging.cpp#L272](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/logging.cpp#L272):
  "--creds username password | set user credentials for the Web manager".
- Config — [docs/configuration.md](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/configuration.md):
  "Windows | %ProgramFiles%\\Sunshine\\config"; `origin_web_ui_allowed` "lan — Only LAN devices may access the web ui";
  `hevc_mode` "0 — advertise support for HEVC based on encoder capabilities (recommended)"; `encoder` default
  "Sunshine will use the first encoder that is available."; `port` default 47989; `log_path` default `sunshine.log`.
  Config dir in code: `std::filesystem::path {sunshine_path}.remove_filename() / L"config"sv`
  ([misc.cpp#L147-L150](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/platform/windows/misc.cpp#L147-L150)).
- Installer — [docs/getting_started.md](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/getting_started.md):
  "The msi installer is preferred moving forward." and "Installer logs can be found in the following directory:
  `%%TEMP%/Sunshine/logs/install/`". Silent path:
  [sunshine-installer.wxs#L55-L67](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/cmake/packaging/wix_resources/sunshine-installer.wxs#L55-L67)
  `Condition="NOT Installed AND UILevel &lt;= 3"` → `sunshine-setup.ps1 -Action install -Silent`, `Return="ignore"`.
- Service — [install-service.bat#L7-L8](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src_assets/windows/misc/service/install-service.bat#L7-L8):
  "set SERVICE_NAME=SunshineService", `SERVICE_BIN=%ROOT_DIR%\tools\sunshinesvc.exe`. Firewall rule name "Sunshine"
  ([add-firewall-rule.bat#L6](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src_assets/windows/misc/firewall/add-firewall-rule.bat#L6)).
- mDNS — [platform/common.h#L1286-L1287](https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/platform/common.h#L1286-L1287):
  `SERVICE_NAME = "Sunshine"`, `SERVICE_TYPE = "_nvstream._tcp"`.
- Ports: nvhttp.h `PORT_HTTPS = -5`, confighttp.h `PORT_HTTPS = 1`, rtsp.h `RTSP_SETUP_PORT = 21`, stream.h 9/10/11.
- Release assets (GitHub API digest = local `shasum`): `Sunshine-Windows-AMD64-installer.msi` sha256 `1d7fed8b…0ccf`.

**moonlight-qt** (tag v6.2.0)
- Pair — [commandlineparser.cpp#L260-L283](https://github.com/moonlight-stream/moonlight-qt/blob/v6.2.0/app/cli/commandlineparser.cpp#L260-L283):
  `parser.addValueOption("pin", "4 digit pairing PIN");` … `parser.showError("PIN must be 4 digits");`.
  `Moonlight pair --help` on this Mac prints `--pin <pin>    Specify 4 digit pairing PIN to use.`
- PIN is shown in the GUI, not stdout — [CliPair.qml#L11-L13](https://github.com/moonlight-stream/moonlight-qt/blob/v6.2.0/app/gui/CliPair.qml#L11-L13):
  `qsTr("Pairing... Please enter '%1' on %2.")`; without `--pin` it calls `generatePinString()` (pair.cpp#L59-L61).
- List — [listapps.cpp#L100-L112](https://github.com/moonlight-stream/moonlight-qt/blob/v6.2.0/app/cli/listapps.cpp#L100-L112):
  `QCoreApplication::exit(0)` on success, "Computer %1 has not been paired." then `exit(-1)`.
- Stream flags — [commandlineparser.cpp#L338-L373](https://github.com/moonlight-stream/moonlight-qt/blob/v6.2.0/app/cli/commandlineparser.cpp#L338-L373)
  and `Moonlight stream --help` here: `--1080`, `--1440`, `--4K`, `--fps`, "--bitrate <bitrate> Specify bitrate in Kbps
  to use." (range 500..500000), `--video-codec` auto/H.264/HEVC/AV1, `--audio-config` stereo/5.1-surround/7.1-surround,
  `--display-mode` borderless/fullscreen/windowed, `--vsync/--no-vsync`, `--frame-pacing/--no-frame-pacing`.
- Bundle: DMG contains `Moonlight.app/Contents/MacOS/Moonlight` (universal), CFBundleShortVersionString 6.2.0,
  notarized (spctl "accepted"). CLI logs go to `/tmp/Moonlight-<epoch>.log` (observed).
- Codec bits — [Limelight.h#L506-L520](https://github.com/moonlight-stream/moonlight-common-c/blob/f900dd4767759c7b9d0e93bcea666b55c69ea62f/src/Limelight.h#L506-L520).

**Other**: Apple chip via `os.cpus()[0].model` → "Apple M4" on this Mac mini. mDNS lib `bonjour-service@1.4.4` (MIT,
published 2026-07-28). PowerShell portable `powershell-7.7.0-osx-arm64.tar.gz` sha256 `76449f07…f10d`, parser runs here.

## 10. Could NOT be verified here (Garv's PC is the test)
1. Silent MSI end-to-end (`msiexec /qn`) incl. whether the silent custom action really creates firewall rule + service.
2. `sunshine.exe --creds` exits immediately without starting a server, and that a service restart is required/enough.
3. That a non-elevated user can read `config\credentials\cacert.pem` (we copy it to ProgramData during setup anyway).
4. Real pairing: timing between `Moonlight pair` and `GET /api/pin`; address equality when the Mac has several IPs;
   whether terminating the pair window after `postSuccessFlushMs` always keeps the pairing (verified by `list`).
5. Moonlight `--video-codec AV1` behaviour when the host lacks AV1 (we avoid it via `ServerCodecModeSupport`).
6. Real streaming quality/latency, macOS local-network permission prompt for the packaged app.
7. PowerShell wrappers under Windows PowerShell 5.1 (only parsed with pwsh 7.7 here).
8. Electron runtime: `npm install` ran with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` because the Electron binary comes from
   github.com/electron/electron releases, which is outside the download allow-list. **Decision needed** to fetch it
   (checksum-verified by `@electron/get`) before `npm start` / packaging.

## 11. Build order (test first, commit per step, aim for 80%+ line coverage on src/shared, src/client, src/host)
**Builder A:** (1) `exec.ts` + `redact.ts` + `logger.ts` → (2) `chip.ts`, `codec.ts`, presets clamp, `moonlight.ts` argv
builders + fake CLI → (3) `serverinfo.ts` + `discovery.ts` → (4) `pairing.ts` against a stub agent server → (5) main,
preload, IPC router, security → (6) renderer screens → (7) `diagnostics.ts`, client self-check → (8) macOS dir build.
**Builder B:** (1) `ipnet.ts`, `winargs.ts` (`QuoteWindowsArg`, `BuildPsArgv`, `BuildMsiexecArgs`) → (2) `sunshine-locate.ts`
+ `sunshine-conf.ts` → (3) mock Sunshine + `sunshine-client.ts` (pinning, redaction) → (4) `agent.ts` (guards, rate limit,
approval, address match) → (5) PS wrappers + `check-ps.mjs` → (6) steps probe/apply with fake runner, elevated flow,
host self-check → (7) `build-windows.ps1`.
**Risks:** Sunshine API drift (pinned tag + mock built from quotes); Moonlight pair window lifecycle (verify with
`list`); Windows ACLs on ProgramData (fallback dir + `logDirFellBack` in diagnostics); UAC/standard-user accounts
(handoff file, not DPAPI, crosses the elevation boundary).
