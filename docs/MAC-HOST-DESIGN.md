# Mac host design

Status: design only, nothing implemented. Written 2026-11-16 against LanPlay 0.3.2 (commit 6fb21cf) and Sunshine
v2026.914.233613. Machine used for local checks: Apple Silicon, macOS 26.4, SIP enabled, Command Line Tools only (no
Xcode), no code-signing identities, macOS firewall off, Karabiner DriverKit dext 1.8.0 installed.

## 1. Goal, non-goals, evidence

### Goal
One LanPlay app on macOS that can be **Host or Client** (chooser, like Windows). As a host it installs and runs the
pinned Sunshine macOS build, walks the user through macOS permissions, pairs through the existing pair agent, starts at
login, keeps working across LanPlay auto-updates, and later gets phone controllers through a virtual gamepad that
LanPlay owns.

### Non-goals
- Intel Macs (the Mac build is arm64 only today; the x86_64 Sunshine dmg exists if this changes).
- Forwarding gamepads that are plugged into the *Moonlight client* to a Mac host. Sunshine on macOS only does that
  through LizardByte's paid, source-available "Virtual HID Broker". LanPlay does not install or depend on it. Phone
  controllers do not need it: phones talk to the LanPlay host directly.
- A DriverKit system extension (rejected, see 3.2). No kernel code of any kind.
- Managing the macOS application firewall (needs root). Phase 1 only detects it and explains.
- Virtual display, HDR, multi-user sessions, streaming the login window.

### Verified (source read or command run on 2026-11-16)
| # | Fact | Evidence |
|---|---|---|
| V1 | Release v2026.914.233613 has `Sunshine-macOS-arm64.dmg` 40375035 bytes sha256 `795f03a389c5726f9a7b15f501dc1ddf204b442cae565859ac83aae027a9e07c`, and `Sunshine-macOS-x86_64.dmg` 43417393 bytes sha256 `764b11674babac0cd838c2883359207a481c462f355ccbfd1ec91f6d44672101` | GitHub release API `digest` field. Not downloaded, not re-hashed locally yet |
| V2 | The API now reports the repo as `SunshineStream/Sunshine`; `LizardByte/Sunshine` URLs redirect | release API `html_url` |
| V3 | macOS config dir is `$HOME/.config/sunshine` | `src/platform/macos/misc.mm` `appdata()` |
| V4 | `Sunshine <config-file> [key=value ...] [--cmd args]`: a positional argument without `=` is the config file; parsing stops at the first `--cmd` | `src/config.cpp` `parse()` |
| V5 | `pkey`, `cert`, `log_path`, `file_state`, `credentials_file`, `file_apps` accept absolute paths (relative ones resolve under the config dir); `system_tray` is a config key | `src/config.cpp` `path_f`, `docs/configuration.md` |
| V6 | `--creds <user> <password>` exists on every platform | `src/entry_handler.cpp` |
| V7 | Bundle id `dev.lizardbyte.app.Sunshine`, `LSUIElement` true, usage strings for microphone, system audio, screen capture, Local Network; `NSBonjourServices` `_nvstream._tcp`; only entitlement is `com.apple.security.device.audio-input` | `Info.plist.in`, `entitlements.plist`, `CMakeLists.txt` |
| V8 | Without Screen Recording permission Sunshine logs `No screen capture permission!`, calls `CGRequestScreenCaptureAccess()` and platform init fails | `misc.mm` `init()` |
| V9 | Keyboard and mouse on macOS are injected with CoreGraphics `CGEventPost`; there is no `AXIsProcessTrusted` check or prompt in that code | libvirtualhid `macos_backend.cpp`, `docs/platform-support.md` |
| V10 | Sunshine macOS gamepads need the separate broker app (entitlement `com.apple.developer.hid.virtual.device`, LaunchDaemon, machine license, LB-SAL source-available license). Upstream docs still say "Gamepads are not currently supported" on macOS | libvirtualhid `docs/macos-gamepad.md`, `LICENSES/license-map.md`; Sunshine `docs/getting_started.md` |
| V11 | Audio: system audio via Audio Tap on macOS 14+, `audio_sink` left blank | `docs/getting_started.md` |
| V12 | mDNS is published with `DNSServiceRegister` | `src/platform/macos/publish.cpp` |
| V13 | CI signs with a Developer ID identity, hardened runtime, and notarizes the dmg when `publish_release` is true | `ci-macos.yml`, `cmake/packaging/macos.cmake`. The shipped artifact itself was not inspected |
| V14 | Installed LanPlay.app is ad-hoc linker-signed, identifier `Electron`, no team | `codesign -dv /Applications/LanPlay.app` |
| V15 | `swiftc`, `notarytool`, `stapler` and the CoreHID, GameController and DriverKit SDK frameworks are present with Command Line Tools alone | `xcrun --find`, SDK listing |
| V16 | Sunshine PR #5171 (IOHIDUserDevice gamepad emulating a Razer Serval, inside Sunshine) was closed unmerged; PR #5807 (gamepads via libvirtualhid broker) merged 2026-09-27 | GitHub API |
| V17 | Apple DTS (forum threads 820708, 840311, 845599): both DriverKit and CoreHID virtual HID need restricted entitlements; CoreHID is recommended over a dext; `com.apple.developer.driverkit.family.hid.virtual.device` "is not a valid entitlement"; CoreHID has no development-only variant (as of mid 2026); the only entitlement-free route is disabling SIP and AMFI, or posting keyboard/mouse events; one request for the CoreHID entitlement sat in "Submitted" for 2.5 months | forum threads listed in section 6 |
| V18 | Karabiner-DriverKit-VirtualHIDDevice is Unlicense, keyboard and pointing only, root-only daemon. OpenJoystickDriver is PolyForm Noncommercial (MIT up to 0.6.0-alpha.1), one dext, virtual profiles "Xbox Wireless Controller" (GameController) and "Xbox Adaptive Controller" (SDL) | project READMEs |

### Assumed, to be proven by the T0 spike before dependent code is merged
| # | Assumption | If false |
|---|---|---|
| U1 | The shipped arm64 dmg is Developer ID signed and notarized (`spctl -a -vv` accepts, team id readable) | Do not ship mac host until upstream artifact is signed; record team id in the manifest |
| U2 | Sunshine.app runs from `~/Library/Application Support/LanPlay/sunshine/Sunshine.app` (not `/Applications`) | Install to `~/Applications/LanPlay Sunshine.app` |
| U3 | Started by a per-user LaunchAgent, the Screen Recording and audio prompts are attributed to "Sunshine", not LanPlay | Start with `/usr/bin/open -g -j <app> --args <conf>` and keep the LaunchAgent only for login start |
| U4 | `Sunshine <conf> --creds u p` exits quickly without touching screen capture | Write credentials through the `/welcome` web flow (POST `/api/password`) after first start |
| U5 | A quarantined but notarized Sunshine copy starts under launchd without a Gatekeeper dialog | Start it once through `open` (shows the normal first-open dialog) |
| U6 | The first `CGEventPost` from Sunshine makes macOS add Sunshine to the Accessibility list (possibly with a prompt). Name of the pane on macOS 26: "Accessibility" (libvirtualhid docs mention "Device Control and Data Access" on newer systems) | Onboarding tells the user to add the app by hand with the + button; copy text updated |
| U7 | Sunshine exits (non-zero) when Screen Recording is missing, so launchd restarts it after the grant | Onboarding restarts it with `launchctl kickstart -k` after the user confirms |
| U8 | macOS 15+ shows a recurring "continue to allow screen recording" prompt for Sunshine's capture path | If yes: document it; a headless Mac host needs someone to click it |
| U9 | `system_tray = disabled` hides the menu-bar icon on macOS | Leave the tray icon |

### T0 spike results (run on this Mac, 2026-11-16)
| # | Result |
|---|---|
| V1 | dmg re-hashed locally: sha256 `795f03a3...a9e07c`, equals the GitHub digest. |
| U1 | **True.** `spctl -a -vv`: accepted, source Notarized Developer ID, Authority Developer ID Application: LizardByte LLC, TeamIdentifier `F8XQ7XCN2R`, hardened runtime. No ticket stapled (first launch needs network for the notarization check). Only entitlement: audio-input. |
| U2 | **True.** Runs from `~/Library/Application Support/<dir>/sunshine/Sunshine.app` with a private config file given as argv[1]. |
| U4 | **True.** `Sunshine <conf> --creds user pass` writes `credentials.json` and exits in well under a second ("New credentials have been created"), without starting capture. |
| Run | Started with the private conf: listens on TCP 47984, 47989, 47990, 48010; web UI answers 401 without credentials and `/api/config` answers with them; finds `h264_videotoolbox` and `hevc_videotoolbox`; AV1 videotoolbox fails to open (ignore). No permission prompt appeared at start (capture permission is asked when a stream starts). |
| U3, U5 to U9 | Not yet tested: need launchd start and the user clicking permission prompts (T10). |

## 2. Architecture

### 2.1 Shape
The Windows host stays as it is. macOS gets a sibling implementation behind the existing `HostService` contract. No
elevation exists on macOS in phase 1: everything is per-user.

```
src/core/host/
  common.ts            NEW  platform-neutral pieces moved out of service.ts (re-exported there, no behaviour change)
  service.ts           KEEP WindowsHostService (imports common.ts)
  steps.ts, ps.ts, winargs.ts, sunshine-locate.ts, diagnostics-host.ts   KEEP, Windows only, untouched
  sunshine-client.ts, sunshine-conf.ts, agent.ts, vendor.ts              already platform-neutral (vendor.ts gains mac pins)
  mac/
    sunshine-mac.ts        NEW  locate bundled app, install copy, verify signature, paths
    launchd.ts             NEW  plist text + launchctl argv builders + state parser (pure)
    permissions-mac.ts     NEW  permission model, settings deep links, log-based detection
    steps-mac.ts           NEW  createMacHostSteps(env): HostStep[]
    service-mac.ts         NEW  MacHostService implements PlatformHostService
    diagnostics-host-mac.ts NEW
```

`common.ts` exports (moved verbatim from `service.ts`): `LAST_SETUP_KEY`, `SETUP_EXE_KEY`, `PINNED_CERT_NAME`,
`LazySunshineClient`, `generateAdminPassword`, `defaultLocalIdentity`, and a new free function
`probeAgent(agent: PairAgent): Promise<{ http: boolean; udp: boolean; detail: string }>` (body of
`WindowsHostService.probeAgent`). `service.ts` re-exports all of them so existing imports and tests keep working.

New interface in `service.ts` (type only), used by wiring instead of the concrete class:
```ts
export interface PlatformHostService extends HostService {
  agentIdle(reason: string | undefined): void;
  agentAutoStart(): { start: boolean; reason?: string };
  /** macOS: bundled Sunshine differs from the installed copy. Windows: always null. */
  pendingSunshineUpdate(): { installed: string; bundled: string } | null;
}
```

### 2.2 Contracts (`src/contracts.ts`), all additive
```ts
export const SUNSHINE_MAC = Object.freeze({
  bundleId: 'dev.lizardbyte.app.Sunshine',
  appName: 'Sunshine.app',
  binaryRelative: 'Contents/MacOS/Sunshine',
  dmgAsset: 'Sunshine-macOS-arm64.dmg',
  launchdLabel: 'dev.lanplay.sunshine',
  agentLaunchdLabel: 'dev.lanplay.agent',
  noScreenPermissionLog: 'No screen capture permission!',
  minMacOS: 14,
});
export type MacHostStepId =
  | 'mac-bundle'          // bundled Sunshine.app present, signature valid, team id pinned, version matches
  | 'mac-install'         // copy in <sharedData>/sunshine/Sunshine.app is current and signature-valid
  | 'config' | 'credentials'
  | 'mac-launch-agent'    // dev.lanplay.sunshine loaded and running
  | 'mac-screen-recording'
  | 'web-ui' | 'api-auth'
  | 'mac-input'           // Accessibility for keyboard/mouse (user-confirmed)
  | 'mac-audio'           // info: macOS >= 14, system audio prompt
  | 'mac-network'         // Local Network + application firewall state (info/warn)
  | 'agent-autostart' | 'agent-listening';
export type HostStepId = /* existing Windows ids */ | MacHostStepId;
export const MAC_HOST_STEP_ORDER: readonly HostStepId[];   // the order above
export type SettingsPane = 'screen-recording' | 'accessibility' | 'microphone' | 'local-network' | 'login-items' | 'firewall';
```
- `SunshineInstall.foundVia` gains `'lanplay-managed'`; on macOS `serviceExe` is `''`.
- `StepRecord.data` convention on macOS: `{ settingsPane?: SettingsPane, userAction?: 'confirm-input' }`. The renderer
  draws a button from it. No free-form URLs cross IPC.
- `HostSetupStatus.isAdmin` is always `false` on macOS.
- IPC invoke additions (also add to `IPC_INVOKE_CHANNELS` and `src/preload/preload.ts`):
  `'host:open-settings': [{ pane: SettingsPane }, void]`, `'host:confirm-input': [{ ok: boolean }, HostSetupStatus]`,
  `'host:sunshine-restart': [void, HostSetupStatus]`.
- `AppInfo` gains `hostSupported?: boolean` (false on a Mac older than macOS 14 or not arm64).
- `SecretKey` unchanged (`sunshine-admin-password`, stored in the Keychain through `safeStorage`).

### 2.3 Role chooser
`src/core/client/role.ts`:
- `canChoose = platform === 'win32' || platform === 'darwin'`.
- `needsChoice` stays Windows-only. A Mac that updates keeps opening as a client with no question; the client screen
  gets the existing "Change role" link. Default role on darwin stays `client`.
- `main.ts`: `roleChoice.stored = resolved.source !== 'default' || !resolved.needsChoice` so the renderer does not show
  the first-run question on a Mac.
- `app:role-set` and relaunch with `--role` are reused unchanged.
- Switching host to client must not leave Sunshine running. On darwin, when the app starts in the client role,
  `main.ts` calls `teardownMacHost(deps)` (exported from `service-mac.ts`): it boots out both LaunchAgents and removes
  their plists if they exist. The Sunshine copy, its config and pairings are kept, so switching back needs no new
  permissions.

### 2.4 Sunshine on disk
- **Bundle, do not download at first run.** `vendor/manifest.json` gets a `sunshine-macos-arm64` artifact (V1 values,
  `extract`: `hdiutil attach -nobrowse -readonly; ditto Sunshine.app vendor/sunshine-macos/Sunshine.app`, `binary`
  `Sunshine.app/Contents/MacOS/Sunshine`, notes with `codesign -dv` team id and `spctl` result, same style as
  `moonlight-macos`). `scripts/fetch-vendor.mjs` fetches it by default on a Mac. `after-pack.cjs` copies it to
  `LanPlay.app/Contents/Resources/vendor/Sunshine.app` with `ditto` and runs `codesign --verify --deep --strict`.
  Reasons: same trust path as Moonlight and the MSI, works offline, no new download code. Cost: about 40 MB per Mac
  build (the app download is already about 80 MB because of Moonlight).
- **Run a copy, not the bundled one.** Setup copies it with `ditto` to
  `<sharedData>/sunshine/Sunshine.app` (`sharedData` = `~/Library/Application Support/LanPlay` on darwin) and verifies
  the signature again. The auto-updater moves the whole LanPlay.app away while it swaps; a Sunshine running from inside
  the bundle would lose its frameworks mid-stream. The copy also lets a stream survive a LanPlay update.
  `<sharedData>/sunshine/installed.json` = `{ version, dmgSha256, teamId, copiedAt }`.
- **Private state, the user's own `~/.config/sunshine` is never touched** (V4, V5). Layout:
  ```
  <sharedData>/sunshine/Sunshine.app
  <sharedData>/sunshine/sunshine.conf
  <sharedData>/sunshine/sunshine_state.json      file_state and credentials_file
  <sharedData>/sunshine/credentials/cakey.pem, cacert.pem
  <sharedData>/sunshine/apps.json
  ~/Library/Logs/LanPlay/sunshine.log            log_path
  ~/Library/Logs/LanPlay/sunshine-launchd.log    stdout/stderr from launchd
  <sharedData>/sunshine-cert.pem                 pinned copy (PINNED_CERT_NAME), as on Windows
  ```
  Managed keys on macOS = `SUNSHINE_MANAGED_CONFIG` plus absolute `pkey`, `cert`, `log_path`, `file_state`,
  `credentials_file`, `file_apps`, and `system_tray = disabled` (U9). `mergeSunshineConf` is reused as is.
- A foreign Sunshine already listening on 47989/47990 (Homebrew or the dmg app) fails `mac-launch-agent` with
  "Another Sunshine is running on this Mac. Quit it, then press Set up again." LanPlay never stops a process it did
  not start.
- Licence: Sunshine is GPL-3.0, redistributed unmodified; add the mac artifact to `SOURCE-OFFER.md`. The Qt
  frameworks inside Sunshine.app are LGPL-3.0: ship the notice file in `licenses/`. Nothing from libvirtualhid's
  broker is shipped.

### 2.5 Launch, stop, autostart
Two per-user LaunchAgents in `~/Library/LaunchAgents`, loaded with `launchctl bootstrap gui/<uid> <plist>`:

| Label | ProgramArguments | Keys |
|---|---|---|
| `dev.lanplay.sunshine` | `[<copy>/Contents/MacOS/Sunshine, <sharedData>/sunshine/sunshine.conf]` | `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`, `LimitLoadToSessionType Aqua`, `ProcessType Interactive`, `StandardOutPath`/`StandardErrorPath` |
| `dev.lanplay.agent` | `[<LanPlay.app>/Contents/MacOS/LanPlay, --agent]` | `RunAtLoad` only, **no KeepAlive** (the updater must be able to quit it), `LimitLoadToSessionType Aqua` |

Why launchd and not a child process: the process becomes its own TCC subject (Sunshine's Developer ID identity keeps
its permissions across LanPlay updates, while ad-hoc LanPlay would lose them on every build, V14); it starts at login
without LanPlay; it survives LanPlay quitting, like the Windows service. Electron's `setLoginItemSettings` is not used
on macOS because it cannot pass `--agent` there.

`launchd.ts` (pure, argv arrays only, no shell):
```ts
export interface AgentSpec { label: string; program: string; args: string[]; keepAlive: boolean; stdoutPath?: string; stderrPath?: string }
export function buildAgentPlist(s: AgentSpec): string;                        // XML, values escaped
export function plistPath(home: string, label: string): string;
export function bootstrapArgv(uid: number, plist: string): { file: string; args: string[] };   // /bin/launchctl bootstrap gui/<uid> <plist>
export function bootoutArgv(uid: number, label: string): { file: string; args: string[] };
export function kickstartArgv(uid: number, label: string, kill: boolean): { file: string; args: string[] };
export function printArgv(uid: number, label: string): { file: string; args: string[] };
export function parseLaunchctlPrint(stdout: string): { loaded: boolean; state: string | null; pid: number | null; lastExitCode: number | null };
```
`loginItem` in `WiringEnv` on a darwin host is a launchd-backed `{ get, set }` for `dev.lanplay.agent`, so the existing
`agent-autostart` logic is reused. `SETUP_EXE_KEY` is kept: if LanPlay.app moved, the agent plist is rewritten by
"Set up / Repair".

### 2.6 Setup flow (`MacHostService.runSetup`, all in-process, no handoff file)
1. `mac-bundle`: find `Sunshine.app` (`<vendorDir>/Sunshine.app` packaged, `<repo>/vendor/sunshine-macos/Sunshine.app`
   dev), run `/usr/bin/codesign --verify --deep --strict` and `codesign -dv` and compare `TeamIdentifier` with
   `SUNSHINE_MAC_TEAM_ID` in `vendor.ts`. Fail on macOS < 14 or non-arm64.
2. `mac-install`: if `installed.json` differs from the bundled version: boot out `dev.lanplay.sunshine`, `ditto` the
   app, verify, write `installed.json`.
3. `config`: write managed keys.
4. `credentials`: generate/store the password exactly as on Windows, then run
   `<binary> <conf> --creds lanplay <pw>` (password passed through `secrets` so it is redacted) (U4).
5. `mac-launch-agent`: write plist, `bootstrap` (or `kickstart -k` when already loaded), wait for the pid.
6. `mac-screen-recording`: pass when the web UI port answers; fail with `settingsPane: 'screen-recording'` when the
   tail of `sunshine.log` since this start contains `noScreenPermissionLog`.
7. `web-ui`: TCP 47990 + TLS pin; on first run copy `credentials/cacert.pem` to `sunshine-cert.pem`. `api-auth`:
   `listClients()` with retries. Same logic as the Windows steps, reimplemented in `steps-mac.ts` against the shared
   `HostStepsEnv` shape (about 80 lines; `steps.ts` is not edited because it is untested on real Windows).
8. `mac-input`: `warn` with `settingsPane: 'accessibility'`, `userAction: 'confirm-input'` until
   `host.mac.inputConfirmed` is stored. LanPlay cannot read another app's TCC state, so this is a user confirmation.
9. `mac-audio`, `mac-network`: informational. `mac-network` runs
   `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` (no root) and warns when the firewall is on:
   "Allow incoming connections for Sunshine and LanPlay when macOS asks."
10. `agent-autostart`, `agent-listening`: existing behaviour through the launchd-backed `loginItem` and `probeAgent`.

`runElevatedSetup` on macOS returns 2 and logs "not used on macOS". `--host-setup` is rejected on darwin in `main.ts`.
`agentAutoStart()` on macOS: start once setup has run at least once.
`selfCheck()` runs every step's `probe()` in `MAC_HOST_STEP_ORDER`.

### 2.7 Permission onboarding (what the user sees, in order)
The host screen shows one card "Set up this Mac" with the step list. Steps that need the user carry a button.

| Order | What happens | Button and deep link (opened by main via `shell.openExternal`, fixed map in `permissions-mac.ts`) |
|---|---|---|
| 1 | User presses **Set up this Mac**. macOS shows "Background items added" for Sunshine and LanPlay | none (`login-items`: `x-apple.systempreferences:com.apple.LoginItems-Settings.extension` shown only on failure) |
| 2 | macOS prompt: "Sunshine would like to record this computer's screen and audio". User opens System Settings and switches **Sunshine** on. LanPlay polls every 2 s; launchd restarts Sunshine (U7) | **Open Screen Recording settings** `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` |
| 3 | Steps `web-ui` and `api-auth` turn green by themselves | none |
| 4 | "Let Sunshine control the keyboard and mouse": user switches **Sunshine** on under Accessibility (adds it with + if it is not listed; LanPlay shows the path and a **Show Sunshine in Finder** button), then presses **I did this** | **Open Accessibility settings** `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` |
| 5 | First stream: macOS asks for system audio recording for Sunshine (and microphone only if the client sends one) | `microphone`: `...security?Privacy_Microphone` on demand |
| 6 | Local Network prompt for LanPlay (pair agent replies) and Sunshine (Bonjour) appears on first use; user allows | `local-network`: `x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork` |

Input Monitoring is not needed (nothing reads input events). LanPlay itself needs no TCC permission in phase 1.
The firewall pane link is `x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall`. All six URLs
must be opened once on macOS 26 during T0 and corrected if a pane id differs.

### 2.8 Pairing, credentials, discovery
Unchanged. `LanPairAgent` + `LazySunshineClient` talk to `https://127.0.0.1:47990` with the pinned certificate and the
Keychain-stored password. Clients find the host by Sunshine's own mDNS record (V12), the agent's UDP reply on 47920 and
the port probe. `HostInfo`, agent routes and the ledger (`paired-devices.json` in `sharedData`) are unchanged.
The LanPlay Info.plist already has `NSLocalNetworkUsageDescription` and `NSBonjourServices`; reword the description so
it also covers hosting.

### 2.9 Main process and wiring
- `wiring.ts`: `Services.host: PlatformHostService | null`; `buildServices` picks `createMacHostService` when
  `platform === 'darwin'`. Host diagnostics, `system` and `listeners` branch on platform. New handlers for the three
  IPC channels (the Windows service answers `host:open-settings` with an error, `host:confirm-input` and
  `host:sunshine-restart` with the current status).
- `main.ts`: darwin host gets the launchd `loginItem`; phone-controller backend selection becomes
  `createPadBackendFor(process.platform, ...)` in a new `src/core/controller/backend.ts` (phase 1: darwin returns the
  existing "not available" stub with the text "Phone controllers on a Mac host come in a later version").
- Dock: host in `--agent` mode already hides the dock icon; unchanged.

### 2.10 Renderer
- `host.ts`: all Windows wording ("Windows will ask for permission once", the admin warning, "firewall") becomes
  platform-aware through `AppInfo.platform`. Step rows render `data.settingsPane` as a button
  (`host:open-settings`) and `data.userAction === 'confirm-input'` as **I did this** (`host:confirm-input`).
  While any step has a `settingsPane`, the screen polls `host:setup-status` every 2 s. A banner "Sunshine update
  ready" with **Restart Sunshine** appears when `pendingSunshineUpdate()` is not null (through `HostSetupStatus`
  extension `sunshineUpdate?: { installed: string; bundled: string }`).
- Phone controllers card is hidden on darwin in phase 1.
- `app.ts`: chooser copy "Host: play games that run on this computer from another device".

### 2.11 Diagnostics on darwin (`diagnostics-host-mac.ts`)
Files: `sunshine.json` (install record, conf text, `launchctl print` for both labels, `codesign -dv` of the copy,
pinned cert present, API version), `logs/sunshine.log` (tail of `log_path`, API fallback), `logs/sunshine-launchd.log`,
`launchagents/*.plist`, `firewall.json` (`socketfilterfw --getglobalstate`), `host-commands.json`.
Listeners: `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -Fpcn` filtered to `LANPLAY.listenPortsToCheck`.
System info: reuse `macSystemInfo(runner)` from `client/diagnostics-client.ts`. Logs stay in `~/Library/Logs/LanPlay`.

### 2.12 Auto-update interaction
- The updater replaces LanPlay.app only. Sunshine runs from the copy under launchd, so a stream continues.
- `dev.lanplay.agent` has no `KeepAlive`, so quitting for the update does not respawn the old binary;
  `apply-update.sh` already reopens the app. In agent mode updates are staged and applied at next launch (existing).
- After an update that carries a newer Sunshine: nothing restarts by itself. The host screen offers
  **Restart Sunshine** (`host:sunshine-restart` = steps 2, 3, 5 to 7). TCC permissions persist because Sunshine's
  designated requirement (bundle id + Developer ID team) does not change between versions.
- The darwin update asset was never shipped before ("UNTESTED-ON-MAC" in `apply.ts`): T10 tests it for real.

## 3. Virtual gamepad on macOS (phase 3)

### 3.1 What "porting ViGEm" means here
ViGEmBus = a kernel bus driver that makes fake Xbox 360 / DS4 devices, plus a user-mode client library. On macOS the
kernel half already exists inside the OS (the service behind `IOHIDUserDevice` / CoreHID `HIDVirtualDevice`). What
LanPlay writes itself is the user-mode half: a helper that owns the virtual devices, the report descriptors, the
translation from the Xbox 360 report, and the client in TypeScript. An Xbox 360 wired pad is not a HID device (vendor
USB class, macOS has no driver for it), so the 360 *report model* is kept as the internal format (`PadState`, already
the wire format from the phones) and translated to a HID identity that macOS recognises.

### 3.2 Decision: CoreHID helper app, not a dext, not in-process
| Option | Verdict |
|---|---|
| DriverKit dext (Karabiner / OpenJoystickDriver style) | Rejected. Needs Xcode, a paid account, several DriverKit entitlements, a system-extension approval step for the user, and Apple DTS says it gives nothing CoreHID does not (V17) |
| CoreHID inside the Electron process | Rejected. The restricted entitlement would have to be on LanPlay.app itself with a provisioning profile, which forces signing the whole Electron app |
| **Small helper app `LanPlayPad.app`** using CoreHID `HIDVirtualDevice` (macOS 15+) | Chosen. Only the helper carries the entitlement and profile. Built with `swiftc` from Command Line Tools (V15). `IOHIDUserDeviceCreateWithProperties` is the fallback API if macOS 14 must be supported (same entitlement) |

Layout: `native/macpad/` (Swift, GPL-3.0, ours): `Sources/lanplay-pad/{main.swift, Protocol.swift, Descriptors.swift,
Translate.swift, Device.swift}`, `Info.plist` (bundle id `dev.lanplay.pad`, `LSUIElement`), `entitlements.plist`
(`com.apple.developer.hid.virtual.device` only), `build.sh` (swiftc, bundle, embed `embedded.provisionprofile`,
`codesign --options runtime`, notarize, staple, zip). The signed zip is published as a release asset of the LanPlay
repo and pinned in `vendor/manifest.json` (`lanplay-pad-macos-arm64`), so ordinary builds need no certificate.

Clean-room rule: do not read or copy `src/platform/macos/broker/**` of libvirtualhid (LB-SAL, not GPL compatible) or
OpenJoystickDriver after 0.6.0-alpha.1 (PolyForm Noncommercial). Allowed references: Karabiner (Unlicense), the MIT
parts of libvirtualhid (for example `macos_xbox_transport.hpp`, with attribution), Apple headers, SDL's HIDAPI
drivers (zlib), descriptor dumps from real controllers.

### 3.3 Node side
`PadBackend` / `VirtualPad` in `src/core/controller/vigem.ts` are reused unchanged. New
`src/core/controller/macpad.ts`:
```ts
export interface MacPadBackendOptions { helperApp: string; socketPath: string; spawnHelper(): Promise<void>; connect(path: string): Duplex; token: Buffer }
export function createMacPadBackend(o: MacPadBackendOptions): PadBackend & { dispose(): void };
export function encodeFrame(op: number, slot: number, report?: PadState): Buffer;   // 16 bytes
export function decodeFrame(b: Buffer): { op: number; slot: number; code: number; payload: Buffer } | null;
```
Transport: the helper is started with `/usr/bin/open -g -j -n <LanPlayPad.app> --args --socket <path>` so it is its
own TCC subject, listens on a Unix socket `<userData>/pad/pad.sock` (directory mode 0700), accepts one client whose
peer uid equals its own (`getpeereid`) and whose first frame is followed by a 32-byte token read from
`<userData>/pad/token` (0600). It exits 10 s after the client disconnects; devices vanish with it, which is the safe
neutral state.

Frames, 16 bytes, little endian:
| Byte | Node to helper | Helper to Node |
|---|---|---|
| 0, 1 | `0x4C`, version `1` | same |
| 2 | op: 1 HELLO, 2 CREATE, 3 UPDATE, 4 CLOSE, 5 PING | op: 0x81 STATUS, 0x82 RUMBLE, 0x83 ERROR |
| 3 | slot 1..4 | slot |
| 4..15 | UPDATE: `XUSB_REPORT` (u16 buttons, u8 lt, u8 rt, i16 lx, ly, rx, ry). CREATE: byte 4 = profile id | STATUS: code (0 ok, 1 no-entitlement, 2 permission, 3 create-failed). RUMBLE: u8 low, u8 high |

`status()` maps helper codes to the existing `PadBackendStatus` (`driver-missing` = helper absent or code 1,
`error` otherwise). `ControllerService`, `ControllerManager`, the server and the phone page do not change.

### 3.4 HID identity and report (candidate, decided by gate G2)
Game compatibility depends on the emulated identity, not on the API:
- Apple's GameController framework matches known vendor/product ids and descriptors (undocumented, per Apple DTS).
- SDL and Steam match their own controller database and, for Xbox ids, pick a decoder by transport.
- Raw IOKit HID consumers read the descriptor as is. Some ignore devices whose transport is "Virtual" (reported by
  OpenJoystickDriver).

Profile 1 (default): **Xbox Wireless Controller, Bluetooth HID layout** (Microsoft vendor id 0x045E; exact product id
from a descriptor dump of a real pad in G2). Input report id 1: LX, LY, RX, RY as u16 0..65535 (centre 32768, Y grows
downward, so `hidY = 32767 - xusbY`), LT and RT as 10-bit values (`xusbTrigger * 1023 / 255`), hat switch 1..8 with 0 =
released, then the button bits. libvirtualhid's MIT code documents two findings to reuse: GameController decodes only
this Bluetooth report, and Steam needs an extra vendor collection carrying the wired GIP report because the transport
shows as Virtual. Profile 2 (fallback): **DualShock 4 v2** (0x054C:0x09CC, 64-byte USB report id 1), natively known to
GameController and SDL. Rumble comes back as an output report and is forwarded as a RUMBLE frame (the phone page
already has a vibration path).

### 3.5 What Apple gates, precisely
| Activity | Needs |
|---|---|
| Node side, protocol, translation, descriptors as bytes, helper socket server with `--dry-run` (no device) | Nothing. Works on this Mac today, SIP on |
| Creating a real virtual device with a development build | The CoreHID entitlement in a provisioning profile. That requires the **paid Apple Developer Program** and Apple approving the "HID Virtual Device" capability request. No development-only variant existed as of mid 2026; whether one exists now is unknown |
| Creating a real device with no Apple account | Boot into Recovery, `csrutil disable`, lower Startup Security to permissive, set boot-arg `amfi_get_out_of_my_way=1`, then ad-hoc sign the helper with the entitlement. This weakens the whole Mac at boot level and is known to break unrelated apps. Use a spare Mac or a macOS VM, never the daily machine. Not shippable |
| Shipping to other Macs | Developer ID Application certificate, the approved entitlement in a Developer ID provisioning profile for `dev.lanplay.pad`, hardened runtime, notarization |
| User side at run time | Accessibility-class permission for LanPlayPad (libvirtualhid's docs require it for their broker; unverified for a user-session helper) |

### 3.6 Risks
1. Apple may reject or sit on the entitlement request (one public case: 2.5 months without an answer).
2. GameController or specific games may not accept a device whose transport is "Virtual"; more than one profile may be
   needed, selectable per game.
3. The paid account is a recurring cost and the Developer ID certificate becomes release-critical (like the update key).
4. CoreHID needs macOS 15; a macOS 14 host would need the older C API.
5. The helper is the only signed, entitled binary inside an otherwise ad-hoc app; an entitled helper that accepts
   commands over a socket is an input-injection surface, hence uid check + token + private directory.
6. macOS updates have broken virtual HID before (forum thread 817009, macOS 26.4 beta).

### 3.7 Phases and gates
| Gate | Question | Go | No-go |
|---|---|---|---|
| G0 | Will the owner pay for the Apple Developer Program and request the entitlement? | File the request the same day; start P3a | Phase 3 stops. Phone controllers on a Mac host stay on the keyboard/mouse fallback |
| P3a | Build everything that needs no entitlement (3.5 row 1), fully unit-tested | | |
| G1 | Entitlement granted, or a SIP/AMFI-off spare machine or VM is available | P3b | Wait; re-ask Apple monthly |
| P3b | Compatibility spike with the real helper: profile 1 and 2 against `GCController.controllers()`, Steam's controller test, one native game, one CrossOver game | | |
| G2 | GameController **and** Steam see all buttons, axes and triggers for at least one profile | P3c with that profile as default | Try other identities (Xbox Adaptive, Serval); if none works, stop and keep the fallback |
| P3c | Sign, notarize, publish helper asset, pin it, bundle it, wire `createPadBackendFor('darwin')` to try macpad first and fall back | | |
| G3 | Clean Mac with SIP on: install, one permission, phone drives a game through a stream | Ship | Fix or pull the feature flag |

## 4. Task breakdown

Conventions for every task: Node 22 (`PATH=/opt/homebrew/opt/node@22/bin:$PATH`), TDD (write the failing vitest
first), no shell strings (argv arrays through `ProcessRunner`), pure logic separated from I/O with injected fakes like
`HostStepsEnv`, `npm run typecheck && npm test` green before hand-off, no edits outside the owned files.

### Phase 1 (first shippable): "Mac host: stream + keyboard/mouse + chooser + updates"

| Task | Owner files (exclusive) | Depends | Summary |
|---|---|---|---|
| T0 spike (lead, on this Mac, not code) | none; results go into section 1 of this file | user OK to download the dmg | Prove U1 to U9 by hand: fetch + hash dmg, `spctl`, copy to Application Support, hand-written LaunchAgent, grant permissions, `--creds`, pair and stream from the bundled Moonlight on the same Mac, open all six deep links |
| T1 contracts + role | `src/contracts.ts`, `src/core/client/role.ts`, `src/preload/preload.ts`, `tests/contracts.test.ts`, `tests/core/role.test.ts` (new) | none | Section 2.2 and 2.3 types, constants, channel lists |
| T2 vendor + packaging | `vendor/manifest.json`, `scripts/fetch-vendor.mjs`, `scripts/after-pack.cjs`, `scripts/electron-builder.config.cjs`, `src/core/host/vendor.ts`, `tests/core/vendor.test.ts`, `SOURCE-OFFER.md`, `third-party-licenses/*` | T0 (team id) | Pin, fetch, extract, bundle, verify Sunshine.app; `SUNSHINE_MAC_DMG_SHA256`, `SUNSHINE_MAC_TEAM_ID` |
| T3 launchd + install (pure) | `src/core/host/mac/launchd.ts`, `src/core/host/mac/sunshine-mac.ts`, `tests/core/host-mac-launchd.test.ts`, `tests/core/host-mac-install.test.ts` | T1 | Section 2.4, 2.5 |
| T4 common extraction | `src/core/host/common.ts`, `src/core/host/service.ts` (move + re-export + `PlatformHostService` only) | none | Existing `host-service.test.ts` must pass unchanged |
| T5 mac steps + service | `src/core/host/mac/steps-mac.ts`, `src/core/host/mac/service-mac.ts`, `src/core/host/mac/permissions-mac.ts`, `tests/core/host-mac-steps.test.ts`, `tests/core/host-mac-service.test.ts` | T1, T3, T4 | Section 2.6, 2.7 |
| T6 mac diagnostics | `src/core/host/mac/diagnostics-host-mac.ts`, `tests/core/host-mac-diagnostics.test.ts` | T1, T3 | Section 2.11 |
| T7 main wiring | `src/main/wiring.ts`, `src/main/main.ts`, `src/core/controller/backend.ts` (new), `tests/main/wiring.test.ts`, `tests/main/ipc-wiring.test.ts` | T1, T5, T6 | Section 2.9 |
| T8 renderer | `src/renderer/host.ts`, `src/renderer/app.ts`, `src/renderer/model.ts`, `src/renderer/styles.css`, `tests/ui/host.test.ts`, `tests/ui/app.test.ts`, `tests/ui/host-controllers.test.ts` | T1 | Section 2.10 |
| T9 docs | `README.md`, `docs/RELEASING.md`, `docs/MAC-HOST-TEST.md` (manual checklist, like `WINDOWS-TEST.md`) | T5 | |
| T10 end-to-end on this Mac (lead) | none | all | See acceptance below |

T1, T3 (after T1), T4 and T8 (after T1) run in parallel; T2 in parallel once T0 has the team id.

TDD notes and acceptance per task:
- **T1**: `resolveRole` darwin cases (`canChoose` true, `needsChoice` false, default client, stored host wins, flag
  wins); `MAC_HOST_STEP_ORDER` has no duplicates and every id has a title; preload channel list equals contracts
  (existing test).
- **T2**: vendor test: manifest entry equals `vendor.ts` constants; `after-pack` throws when Sunshine.app is missing.
  Acceptance on this Mac: `node scripts/fetch-vendor.mjs && npm run pack:mac`, then
  `codesign --verify --deep --strict release/mac-arm64/LanPlay.app/Contents/Resources/vendor/Sunshine.app`.
- **T3**: snapshot tests for both plists (XML escaping of `&`, `<`, spaces in paths); argv builders; parser against
  captured `launchctl print` output for running, crashed and not-loaded jobs; install planner (`needsCopy` matrix:
  absent, same version, different version, signature invalid) with a fake fs.
- **T4**: no new behaviour; diff is move-only.
- **T5**: each step's `probe` never mutates (fake env records writes); `apply` idempotent (second run: no writes, no
  launchctl calls except `print`); screen-recording detection from log fixtures; foreign-Sunshine detection;
  `runSetup` happy path with fakes ends `ok`, with `mac-input` as `warn`; password never appears in recorded commands.
- **T6**: file list and redaction (password, PIN) with fakes.
- **T7**: `buildServices({ platform: 'darwin', role: 'host' })` returns a Mac host service and host handlers;
  `host:open-settings` rejects unknown panes; Windows wiring tests unchanged.
- **T8**: happy-dom tests: mac wording, settings button calls `host:open-settings` with the pane, **I did this** calls
  `host:confirm-input`, controllers card hidden on darwin, chooser reachable from the client screen on darwin.
- **T10** (real machine, this Mac, all verifiable here): fresh user data; choose Host; run setup; grant Screen
  Recording and Accessibility; `LanPlay --self-check --role host` exits 0; pair with
  `vendor/moonlight-macos/Moonlight.app` against this Mac's LAN address through the pair agent; stream the desktop to
  the same Mac in a window (video, audio, mouse click and a typed key arrive); log out and in: Sunshine and the agent
  are back; quit LanPlay: stream continues; build 0.4.1 over 0.4.0 with a signed manifest from a local file server and
  confirm the darwin update applies while Sunshine keeps running; switch to Client: both LaunchAgents are gone.
  Not verifiable on this Mac alone: a second device on Wi-Fi (use the iPhone with Moonlight iOS for one pass), an
  Intel Mac, macOS 14/15, firewall-on behaviour (toggle it once by hand).

### Phase 2 (recommended, optional): "phone controllers via keyboard/mouse fallback"
Not in phase 1 because it makes LanPlay itself need Accessibility, and an ad-hoc signed LanPlay loses that grant on
every update (V14). Ship it only together with a stable signing identity for the Mac build.

| Task | Owner files | Summary |
|---|---|---|
| K1 stable identity | `scripts/electron-builder.config.cjs` (mac block), `scripts/after-pack.cjs` (sign step), `docs/RELEASING.md` | Sign the Mac app with one long-lived certificate (self-signed "LanPlay Local Signing" if no Developer ID). Spike first: confirm an Accessibility grant survives an update |
| K2 backend | `src/core/controller/keymap-mac.ts`, `tests/core/controller-keymap.test.ts` | `createKeymapBackend({ koffi, trusted(), mapping }): PadBackend`. Diffs `PadState`, posts `CGEvent` key and mouse events through koffi (CoreGraphics). Left stick to WASD with hysteresis, right stick to relative mouse at 120 Hz, triggers to mouse buttons, buttons to keys; player 1 only gets the mouse. `status()` is `driver-missing` until `AXIsProcessTrusted` |
| K3 packaging | `scripts/electron-builder.config.cjs` (koffi darwin-arm64 unpacked), `scripts/after-pack.cjs` | Pack `@koromix/koffi-darwin-arm64` in the Mac build |
| K4 wiring + UI | `src/core/controller/backend.ts`, `src/main/main.ts`, `src/renderer/host.ts`, `src/contracts.ts` (`ControllersState.kind: 'gamepad' \| 'keyboard-mouse'`), tests | "Phones act as keyboard and mouse on a Mac host" notice, permission button, default mapping table |

K1 touches files T2 owns: run phase 2 after phase 1 is merged. Limits to state in the UI: games see a keyboard and
mouse, not a controller; no analog movement; one mapping for all games in the first version.
Verifiable on this Mac: yes (a gamepad-tester page will show nothing by design; test with a text editor and a game).

### Phase 3: "own virtual gamepad"
| Task | Owner files | Verifiable here |
|---|---|---|
| P1 protocol + backend | `src/core/controller/macpad.ts`, `tests/core/controller-macpad.test.ts` | yes (fake socket) |
| P2 helper, dry-run | `native/macpad/**` | yes: build with `swiftc`, socket + translation tests, `--dry-run` |
| P3 descriptors + translation tests | `native/macpad/Sources/lanplay-pad/{Descriptors,Translate}.swift`, `native/macpad/Tests/**` | yes (byte-level) |
| P4 real device spike (P3b) | none | only with the entitlement, or on a SIP/AMFI-off spare Mac or VM |
| P5 sign, notarize, pin, bundle | `native/macpad/build.sh`, `vendor/manifest.json`, `scripts/after-pack.cjs`, `scripts/fetch-vendor.mjs` | only with the paid account |
| P6 wiring + UI | `src/core/controller/backend.ts`, `src/main/main.ts`, `src/renderer/host.ts` | yes with the dry-run helper |

## 5. Open questions for the owner
1. **Apple Developer Program (about 99 USD per year): yes or no?** It decides whether phase 3 can ever ship, and it
   would also remove the unsigned-app friction in phases 1 and 2. If yes, the entitlement request should be filed now
   because of the waiting time.
2. **May the T0 spike download and run the pinned Sunshine dmg (40 MB) on this Mac** and grant it Screen Recording and
   Accessibility? Phase 1 cannot be verified otherwise.
3. **Phase 2 yes or no?** Phones as keyboard/mouse on a Mac host is a stopgap with real limits; skipping it means no
   phone controllers on a Mac host until phase 3.
4. Is there a spare Mac (or is a macOS VM acceptable) for SIP/AMFI-off prototyping in phase 3? The daily Mac should
   not be used for that.

## 6. Sources
- Sunshine at tag v2026.914.233613: `docs/getting_started.md`, `docs/configuration.md`, `src/config.cpp`,
  `src/entry_handler.cpp`, `src/platform/macos/{misc.mm,input.cpp,publish.cpp,display.mm}`,
  `src_assets/macos/{entitlements.plist,build/Info.plist.in}`, `cmake/packaging/macos.cmake`,
  `.github/workflows/ci-macos.yml`; PRs https://github.com/LizardByte/Sunshine/pull/5171 and
  https://github.com/LizardByte/Sunshine/pull/5807
- libvirtualhid (master, 2026-11-12): https://github.com/LizardByte/libvirtualhid `docs/macos-gamepad.md`,
  `docs/platform-support.md`, `LICENSES/license-map.md`, `src/platform/macos/macos_xbox_transport.hpp`
- https://github.com/pqrs-org/Karabiner-DriverKit-VirtualHIDDevice
- https://github.com/xsyetopz/OpenJoystickDriver
- Apple Developer Forums: https://developer.apple.com/forums/thread/820708 ,
  https://developer.apple.com/forums/thread/840311 , https://developer.apple.com/forums/thread/845599 ,
  https://developer.apple.com/forums/thread/843327 (HID entitlement guide, not read in full),
  https://developer.apple.com/forums/thread/764540 , https://developer.apple.com/forums/thread/817009
