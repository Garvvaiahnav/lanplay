# LanPlay 0.5 release plan

Written 2026-11-21 against 0.4.1 (commit 8bc682b). Decisions only; no source file was changed.
Anything marked UNVERIFIED was not checked on a real device, a real network, or in upstream source.
This plan replaces the signal / relay / WireGuard parts of `docs/ONLINE-DESIGN.md`. From that document only
these survive: the uplink budget (4B.1), the per-player bitrate rungs, and the fact that Moonlight switches to
"remote" mode by itself for a non-private address (1.2).

Theme of the release: **type the host's IP, play.** No LanPlay server, no account, no tunnel.

---

## 1. Decision ledger

| ID | Decision | Why | Rejected |
|---|---|---|---|
| D01 | Online = the player types `IP` or `IP:port` (or a DNS name); Moonlight connects straight to it. | Owner's brief. Zero infrastructure. | Signal server, relay, WireGuard sidecar (ONLINE-DESIGN sections 2, 4). |
| D02 | Only a **typed** address may be public. mDNS, UDP probe and port probe keep their private-only filters. | Those sources are unauthenticated; a typed address is the user's own intent. | Relaxing `isPrivateAddress` globally. |
| D03 | `isPrivateAddress` itself does not change. A host is `remote` when its address is not private. 100.64.0.0/10 counts as remote. | LAN guards everywhere keep their meaning. Overlay addresses (for example Tailscale) then work as typed addresses with no extra code. | Adding CGNAT/overlay ranges to the private list (would let auto-approve apply to them). |
| D04 | **The pair agent (47920) is never exposed to the internet.** Its private-source check, Host allow-list, Origin check and rate limits are unchanged. | With auto-approve it hands out full control of the PC. One less forwarded port. Sunshine's own UPnP cannot map it anyway. | Opening the agent to public sources with forced manual approval. |
| D05 | Remote pairing = **code pairing**: the client shows a 4-digit code, the friend reads it out, the host owner types it into LanPlay on the host. | The code never crosses the network in clear; it is the pairing model Sunshine and Moonlight were designed for. | Sending the PIN to the agent over plain HTTP across the internet. |
| D06 | The host screen gets one list, "Add a device with a code", showing every pending Sunshine pairing (LAN and internet). | Same mechanism also pairs the stock Moonlight app on Android, iOS, TV. | A separate internet-only pairing UI. |
| D07 | Host side is opt-in: a switch "Allow connections from the internet", default off, applied through the existing elevated Set up / Repair run. | Nothing changes for LAN-only users. One UAC prompt. | Always-open firewall rule; silent enabling. |
| D08 | When the switch is on, LanPlay writes `upnp = enabled` and `address_family = both` into `sunshine.conf`; off writes `disabled` / `ipv4`. | One config key replaces manual port forwarding on most home routers; the other makes IPv6 hosting possible. Value names UNVERIFIED against Sunshine docs at the pinned tag. | Writing our own UPnP/NAT-PMP client (about 150 lines, more to test). |
| D09 | `origin_web_ui_allowed` changes from `lan` to `pc` for everyone. | LanPlay only calls `https://127.0.0.1:47990`. Shrinks exposure once ports are forwarded. | Leaving the admin UI reachable from the LAN. |
| D10 | Standard ports only, forwarded 1:1. `IP:port` is accepted and means "this host's Sunshine base port"; the whole port family must be forwarded unchanged. | Sunshine derives every port from the base port; Moonlight learns them from the host. | Arbitrary external-to-internal port remapping (cannot work with GameStream). |
| D11 | `IP:port` ships only if `Moonlight list <ip>:<port>` works with the bundled 6.2.0 binary (the binary contains a `moonlight://` URL parser string; behaviour UNVERIFIED). If it does not, the UI rejects a port with "Custom ports are not supported yet". | Do not ship an untested syntax. | Assuming it works. |
| D12 | Bitrate floor drops from 20 to 5 Mbps. New preset "Internet": 1080p, 60 fps, 15 Mbps, codec auto. Adding a remote host selects it once. | 80 Mbps default cannot leave a home uplink. Numbers from ONLINE-DESIGN 4B. | Automatic bitrate probe ("seat probe"): needs our own data channel, which D01 removed. Out. |
| D13 | Uplink budget is shown as text, not measured: players x bitrate x 1.12 must stay under 70% of the host's upload. | Honest and free. | Speed test (needs a server). |
| D14 | Phone controller stays LAN-only and plain HTTP. No phone-to-host path over the internet in 0.5. | URL token over HTTP on the open internet; TCP WebSocket latency; exposes input injection port. A remote friend uses a gamepad or keyboard on their own PC (Moonlight forwards it). | Forwarding 47921; hosted HTTPS page with WebRTC. |
| D15 | Phone page gains: fullscreen + landscape lock + wake lock on first tap (Android), sticky player slot across reconnects, round-trip display, dead-link detection, gzip static files. | Ranked list in section 3. | HTTPS with a self-signed certificate (warning page on every phone). |
| D16 | Phone identity = a random id kept on the phone and sent in `hello`. Slots and layouts key on it, not on the phone's IP. | DHCP changes currently lose or cross layouts; reconnect currently unplugs the virtual pad. | Keeping per-IP keys. |
| D17 | The controller token stays persistent (needed for a home-screen shortcut). The "per-session" wording in code and docs is corrected. "New link" remains the only rotation. | A rotating token would break every saved shortcut. | Per-start token. |
| D18 | Android scope: (a) the controller page in Chrome, (b) documented use of the stock Moonlight Android app as a viewer, paired through D06. No LanPlay Android app. | A native app is a second codebase and a store listing. | Building or bundling an Android client. |
| D19 | Game rumble to the phone (ViGEm notification to `navigator.vibrate`) is out of 0.5. | Needs a koffi callback from a driver thread that cannot be tested on this Mac. | Shipping it untested. |
| D20 | UI cleanup follows the fixed rules in section 5 (3 radii, 4 type sizes, 5 spacing steps, no gradient, advanced settings collapsed). | Removes ad hoc values; keeps the existing vanilla DOM code. | A component library or CSS framework. |
| D21 | No new runtime dependency and no bundler. | Speed of delivery; `dist` is 1.5 MB, the installer is dominated by Sunshine and Moonlight. | esbuild/minifier. |
| D22 | Performance work is limited to: the 60 ms idle timer, `launchctl` before first window, gzip + in-memory static files for the phone page, log level. Lazy role imports only if measured startup misses the target. | Measured or obvious wins only. | Speculative refactors. |
| D23 | Security debts not fixed in 0.5 (recorded in section 7): elevation of user-writable files, staged-update self-check, firewall `-Profile Any`, updater freshness. | Each needs Windows testing and none blocks online play. Owner wants the release quickly. | Folding a security pass into this release. |
| D24 | ECC reference: use `code-reviewer.md` (gating rules), `build-error-resolver.md`, and the red-green loop from `tdd-workflow`. Reject the rest. Install nothing. | Section 8. | Adopting the agents wholesale. |
| D25 | Builders do not commit. One contracts chunk runs first, alone; the rest run in parallel with disjoint files. | Section 9. | Parallel edits to `contracts.ts`. |

---

## 2. Direct-IP online design

### 2.1 What changes, file by file

| File | Change | Stays strict |
|---|---|---|
| `src/core/shared/ipnet.ts` | Add `parseHostPort(input)` returning `{ host, port \| null }` for `1.2.3.4`, `1.2.3.4:47989`, `[2001:db8::1]:47989`, bare IPv6, `name`, `name:port`. Add `isRemoteAddress(a)` = valid IP and not private. | `isPrivateAddress`, `parseHostHeader`, the private list. |
| `src/core/client/discovery.ts` `addManual` (lines 275-297) | Delete the private-only throw at 291-293. Parse with `parseHostPort`. Resolve names as now. Confirm with `fetchServerInfo(ip, port ?? 47989, 5000)` for remote, 2500 for LAN. Set `host.remote`, `host.httpPort`. Map socket errors to the messages in 2.6. Skip `agentCheck` for remote hosts (`agentReachable = false`). | Line 143 (mDNS private only), line 177 (UDP private only), `probeHosts` (own subnets only). A public address can enter the host list **only** through `addManual`. |
| `src/core/client/discovery.ts` `merge` | Use the per-host port instead of the constant at line 248. A remote host never merges addresses learned from discovery into its entry and never becomes `preferredAddress` for a LAN entry. | |
| `src/core/client/pairing.ts` | If `host.remote`: skip `callAgent`; generate the PIN, start `Moonlight pair`, emit progress `show-code` with the code, wait up to 180 s for Moonlight to exit (also poll `Moonlight list` every 5 s in case it stays open), then verify with `list`. Timeout gives `code-timeout`. LAN path byte-for-byte unchanged. Whether `Moonlight pair` exits by itself after success is UNVERIFIED; handle both. | PIN generation, redaction, LAN flow, the 409 retry. |
| `src/core/client/moonlight.ts` | `assertHostArg` accepts `ip` or `ip:port` / `[v6]:port` (port 1-65535); still rejects names and anything starting with `-`. Subject to D11. | IP-literal rule, argv arrays. |
| `src/core/client/settings.ts`, `contracts.ts` | Bitrate min 5; preset `internet`. | Clamping. |
| `src/core/client/service.ts` | Persist the last 5 typed remote addresses (`client.recentRemote`) and offer them in the UI. When a remote stream fails or ends non-zero within 15 s, append the UDP hint from 2.6. | |
| `src/core/host/agent.ts` | HTTP handler untouched. Add three local methods used only through IPC: `listPending()` (wraps `getPendingPairings`, adds `remote` flag), `pairWithCode(id, pin, name)` (wraps `submitPin`, writes the ledger with `pairedVia: 'code'`), `rejectPending(id)` (wraps `cancelPairing`). | Line 448 private source, line 453 Host allow-list, line 455 Origin/Referer, rate limits, auto-approve scope (LAN only, by construction). |
| `src/core/host/service.ts`, `steps.ts`, `mac/*` | Setting `host.internet` (default false). Passed through the elevated handoff. `config` step writes D08/D09 values. New step `firewall-internet` (Windows): on creates, off removes, a LanPlay-owned rule "LanPlay Internet Play": TCP 47984, 47989, 48010 and UDP 47998-48000, RemoteAddress Any. Sunshine restarts when the conf changed. | Agent rule and controller rule keep `RemoteAddress LocalSubnet`. |
| `src/core/controller/server.ts` | No online change. `isAllowedAddress` stays `isPrivateAddress` (`main.ts:114`). Host check is tightened, not relaxed (section 7, item 6). | Everything. |

Scope of the upstream "Sunshine" firewall rule (created by `add-firewall-rule.bat`) is UNVERIFIED; the LanPlay-owned rule
makes the result deterministic either way.

### 2.2 What the host owner must do

1. Host screen, switch on **Allow connections from the internet**, approve the Windows prompt.
2. If the router has UPnP on: nothing more (UNVERIFIED on a real router).
3. Otherwise forward these to the host PC's LAN address (shown on the card), same port outside and inside:

| Protocol | Ports | Use |
|---|---|---|
| TCP | 47984 | HTTPS (pairing, launch) |
| TCP | 47989 | HTTP (`/serverinfo`, pairing start) |
| TCP | 48010 | RTSP |
| UDP | 47998, 47999, 48000 | video, control, audio |

   Never forward 47990 (Sunshine admin), 47920 (pair agent), 47921 (phone controllers).
4. Tell the friend the public IP (search "what is my IP"). The card says: if the router's WAN address is different from
   that IP, the provider uses CGNAT and IPv4 hosting cannot work.
5. IPv6 alternative: the card lists this PC's global IPv6 addresses. Both sides need IPv6 and the router's IPv6 firewall
   must allow the ports above to this PC. UNVERIFIED end to end.
6. Turn the switch off when not playing. A banner stays on the host screen while it is on.

LanPlay cannot test the host's reachability from outside without a server. The friend's first attempt is the test.

### 2.3 Client flow: "Connect by IP"

1. Client screen has one input under the host list, label **Connect by IP**, placeholder `203.0.113.7 or 192.168.1.20`.
   Recent remote addresses appear as buttons under it.
2. Add. On success the host appears in the list with a tag `Internet` and its address.
3. A remote host shows a fixed warning line: "Internet host. Video and input go directly to this address. Only connect
   to people you know."
4. First time: Stream shows "Tell the host this code: 4821. Waiting for them to enter it (3 min)". On the host the
   pending row shows the device name and address; the owner types the code and presses Pair.
5. Later: Stream connects directly. Preset defaults to Internet.

### 2.4 Security exposure, stated plainly

Forwarding the six ports puts Sunshine's network code on the open internet.

- Reachable without pairing: `/serverinfo` (host name, unique id, codec support, pair state) and the start of a
  pairing. Anyone can create pending pairings; each needs a code typed by the owner, so the damage is noise in the
  pending list. Pending entries expire after about 5 minutes (per the comment at `pairing.ts:129`).
- A bug in Sunshine's HTTP or RTSP parser would be reachable by anyone. On Windows the Sunshine service runs as
  SYSTEM. This is the real risk and LanPlay cannot remove it.
- A paired device has keyboard and mouse on the host. Pairing a friend is giving them the PC while it is on.
- Not exposed: admin web UI (D09 plus not forwarded), pair agent, phone controllers.
- Stream encryption for non-LAN clients is Sunshine's `wan_encryption_mode`, default on (UNVERIFIED default; LanPlay
  does not write the key).

Mitigation chosen: off by default; explicit switch with this text beside it; code pairing only; admin UI bound to the
PC; Devices list shows each device's last address with Revoke; firewall rule and UPnP removed when switched off.
Not chosen: firewall allow-list of friend IPs (home IPs change; too much friction), automatic timed switch-off (needs
elevation each time).

### 2.5 Testing a public path without a second network

| Method | Exercises | Misses |
|---|---|---|
| Unit tests with injected `fetchServerInfo` (`addManual('203.0.113.7')` accepted and `remote`; public mDNS/UDP answers still dropped) | LanPlay logic | everything real |
| `fake-moonlight.mjs` end to end: remote host, code shown, fake exits 0 after N seconds | client code-pairing flow | Moonlight, Sunshine |
| Same LAN, extra TEST-NET address on both machines. Mac: `sudo ifconfig en0 alias 203.0.113.11 255.255.255.0`. Windows (admin): `netsh interface ipv4 add address "Wi-Fi" 203.0.113.10 255.255.255.0`. Type `203.0.113.10`. Remove afterwards. | LanPlay remote path, Moonlight remote mode (1024-byte packets), Sunshine WAN handling, code pairing | NAT, port forwarding, firewall scope (the alias makes it "local subnet") |
| Same LAN, host's global IPv6 address, if the ISP provides one | IPv6 path, `address_family = both` | NAT |
| **Client on a phone hotspot (mobile data), host at home.** Type the home public IP. | The real thing, with one home network | nothing; this is the acceptance test |

Typing your own public IP from inside the same LAN is not a valid test: many routers do not loop back.

### 2.6 Failure messages (exact text)

| Condition | Message |
|---|---|
| Connection refused on the HTTP port | "`<ip>` answered but port `<port>` is closed. On the host: switch on Allow connections from the internet and forward the ports, and check that Sunshine is running." |
| No answer in 5 s | "No answer from `<ip>:<port>`. The IP is wrong, the host PC is off, the ports are not forwarded, or the host's provider uses CGNAT (no public IPv4). LanPlay cannot tell which from here." |
| No route (typical for IPv6) | "This computer has no route to `<ip>`. An IPv6 address needs IPv6 on both sides." |
| Something else answers | "Something answered at `<ip>:<port>` but it is not Sunshine." |
| Code not entered in 180 s | "The host did not enter the code in time. Press Stream to get a new code." |
| Remote stream dies within 15 s | existing message plus "The host answered, so TCP works. If there was no picture, UDP 47998-48000 is probably not forwarded." |
| Port given but D11 failed | "Custom ports are not supported yet. Use the plain IP." |

---

## 3. Phone controller improvements, ranked

Protocol additions (both sides implement exactly this):
`{"t":"hello","name":"..","id":"<16-32 chars A-Za-z0-9_->"}` (id optional, older pages still work);
`{"t":"p","n":<integer>}` phone to host, echoed unchanged host to phone, counted in the frame rate limit.

| # | Change | Acceptance check |
|---|---|---|
| 1 | **Sticky slot.** On socket close the player is detached, not removed: pad held neutral for 15 s. A `hello` with the same `id` inside that window re-attaches to the same pad and slot. Kick and `full` unchanged. | Test: join, close, rejoin with same id within 15 s gives same slot and `createPad` called once. After 15 s the pad closes. Real: toggle phone Wi-Fi for 3 s in a game; the game shows no controller-disconnected prompt. |
| 2 | **Dead-link detection and RTT.** Phone sends `p` every 1 s when connected. No echo for 2 s: close and reconnect at once. Gear card shows "Link: 6 ms". Dot goes amber above 40 ms. | Test with fake socket: missing echo triggers reconnect at 2 s. Real: Wi-Fi off then on, page is green again within 2 s of the network returning, no tap needed. Median RTT on 5 GHz Wi-Fi under 10 ms (target UNVERIFIED). |
| 3 | **Android: fullscreen and landscape lock.** First tap calls `requestFullscreen({ navigationUI: 'hide' })`, then `screen.orientation.lock('landscape')`. When the lock succeeds the "Rotate your phone" overlay is not used. Leaving fullscreen shows a one-tap "Full screen" button. iOS: unchanged (no API). | Pixel or Samsung, Chrome: one tap gives no address bar and no rotation; back gesture leaves fullscreen but not the page. Works over plain HTTP (UNVERIFIED). |
| 4 | **Layouts and identity by phone id** (D16). Existing per-IP files are read once as a fallback and re-saved under the id. | Test: same id from two IPs gets the same layouts; two ids on one IP get separate layouts. |
| 5 | **Wake lock.** Use `navigator.wakeLock` when present. It needs a secure context, so on `http://192.168.x.x` it is normally absent (UNVERIFIED per browser). Fallback: a 1x1 muted looping inline video started on the first tap. Gear card states which is active, or "Not available: set Auto-Lock to Never". | Real: phone untouched for 3 minutes during a cutscene stays on, Android and iPhone. Battery cost of the video fallback noted, not measured. |
| 6 | **Static files from memory, gzip.** Read `dist/controller-ui` once at start, precompress with `node:zlib`, send `Content-Encoding: gzip` when accepted. Add `media-src 'self'` to the CSP for item 5. | Test: second request does no disk read; gzip body decodes to the file. Page transfer under 40 KB total (now about 140 KB; target UNVERIFIED). |
| 7 | **Android haptics** stay as built (10 ms tick per press, pulse train on sticks). Add a strength choice Off / Light / Strong (0 / 10 / 25 ms). iOS stays on the switch-overlay tick. | Real Android: each strength is distinguishable; Off is silent. |
| 8 | **Home screen on Android.** `beforeinstallprompt` needs HTTPS and will not fire on a LAN IP. Gear card shows text steps instead: "Chrome menu, Add to Home screen". Manifest gets 192 and 512 px icons and `display: fullscreen`. The manifest must not get a `start_url`: the saved URL has to keep `?t=`. | Test asserts no `start_url`. Real: shortcut opens the page and connects. Whether it opens without browser UI on an insecure origin is UNVERIFIED; item 3 covers it either way. |
| 9 | **Slot feedback.** On `welcome` show "Player 2" for 1.5 s in the centre. | Visible on connect and on re-attach. |
| 10 | Rotate overlay: static icon, no infinite animation. Accidental-back guard: one `history.pushState`, re-pushed on `popstate`. | No CSS animation runs in portrait. Back gesture does not leave the page. |

Multi-phone: 4 slots as now; items 1, 4 and 9 are the multi-phone work. Per-IP socket cap stays 6.

Input latency facts to confirm, not change: `ws` disables Nagle on its sockets and has per-message deflate off by default
on the server (both UNVERIFIED for 8.22.1; the builder reads `node_modules/ws` and writes one test). Host handling time
from frame to `pad.update` must be under 1 ms p99 in a vitest loop with a fake pad.

Phone over the internet: **not in 0.5** (D14).

---

## 4. Android scope

- **In:** the phone controller page on Android Chrome (items 2, 3, 5, 7, 8 above). Samsung Internet and Firefox: best
  effort, no fixes promised.
- **In, documentation only:** an Android phone, tablet or TV as a *viewer* with the stock Moonlight app from the Play
  Store. On LAN it finds the host by itself; over the internet the user adds the host's IP in Moonlight. Moonlight shows
  a code; the host owner types it in "Add a device with a code" (D06). UNVERIFIED on a device.
- **Out:** a LanPlay Android app, bundling or modifying Moonlight Android, game rumble to the phone (D19), phone
  controller over the internet (D14), phone controller for a Windows *client* PC (first candidate for 0.5.1: the
  controller service on a Windows viewer would create a local virtual pad that Moonlight forwards).

---

## 5. UI cleanup spec

The current renderer is already plain (no blur, no shadows, no emoji, system font). The problems are ad hoc sizes,
too much visible at once, and explanatory copy. Rules:

**Palette.** Keep the existing tokens in `styles.css` lines 4-14 and the light set. One accent. No gradients
(`styles.css:51` goes). `color-mix` only for the error box. No new colours.

**Radius.** Three values: 6 px (buttons, inputs, list rows), 8 px (cards, banners), 999 px (switch, badge).
Today: 8, 10, 12, 14, 18, 20.

**Type.** Base 15 px / 1.4. Four sizes: 13 (hint, sub, badge), 15 (body, buttons), 17 (h2, status), 22 (h1).
Weights 400 and 600 only. Today: nine sizes, three weights.

**Spacing.** 4, 8, 12, 16, 24 px only. Card padding 16. Gap between cards 12.

**Controls.** Height 36 px on desktop (today 44). Stream button 48 px, 17 px / 600, radius 6, full width (today 72 px,
24 px bold, radius 18). The phone page keeps its own touch sizes.

**Copy.** A hint is allowed only if it states a fact the label does not. No sentence explains what a control is.
Use "..." (three dots) everywhere, not the single ellipsis character. Sentence case. No exclamation marks.

**Delete.**
- `HINTS.preset`, `HINTS.resolution`, `HINTS.fps` (`model.ts:103-105`).
- The disabled Audio select with one option (`client.ts:66`).
- "LanPlay sets it up for you." and the second sentences on the chooser buttons (`app.ts:110-116`).
- The 180 px chooser cards (`.big`, `.bigs`); replace with two normal rows.
- `host.ts:107` hint: cut to "Open the link on each phone on the same Wi-Fi, or scan the code."
- `sunHint` (`host.ts:13`, `:23`): one sentence each.
- The rotating-phone animation in `controller.css` (`@keyframes turn`).

**Per-screen checklist**

| Screen | Must be true |
|---|---|
| Mode chooser | Title, one line, two rows. Nothing else. |
| Client | Visible by default: status line, host list, Connect by IP, preset row (Lowest latency, Balanced, Best picture, Internet, Custom), Stream. Resolution, fps, bitrate, codec, 500 Mbps switch sit under one closed "More settings" disclosure. Remote host shows the `Internet` tag and the warning line. Code-pairing state shows the code at 22 px. Escape-keys hint stays (it is a fact). |
| Host, Windows | Cards in this order: This PC (name, IP, status), Devices (paired list, "Add a device with a code", auto-approve switch), Internet (switch, warning, ports table, LAN address, IPv6 list; body hidden while off), Phone controllers, Health. Step list appears only during or after a setup run with a failure. |
| Host, Mac | Same order; permission buttons only while a permission is missing. No Internet firewall text (no rule on macOS). |
| Stream menu | Same radius, type and spacing tokens. Three items, no descriptions. |
| Phone page | No change to control drawing. Gear card: rows are label + control, no paragraphs. Link RTT, wake-lock state, haptic strength, Full screen (Android), Add to Home Screen. |
| Footer | Version, Check for updates, result. 13 px. |

`tests/ui/static.test.ts` gets assertions: no `gradient`, no `backdrop-filter`, no `box-shadow`, `border-radius` values
limited to 6px / 8px / 999px / 50%, `font-size` values limited to the four sizes, in `styles.css` and
`stream-menu.css`.

---

## 6. Performance targets

No baseline was measured for this plan; every target is UNVERIFIED until the first measurement, which the builder
records in the chunk report before changing anything.

| Metric | Target | How to measure |
|---|---|---|
| Cold start to window shown, packed app, M4 Mac | under 1.0 s | Add one log line `startup-ms` from process start to `ready-to-show`. Median of 5 launches of the `pack:mac` build. |
| Same, Windows host | under 2.0 s | Same log line, on the Windows PC. |
| Idle CPU, client window open, no stream | under 0.5% over 60 s, no timer faster than 1 s | `ps -o %cpu= -p <pid>` sampled every 5 s; grep for `setInterval` with period under 1000. Fix: the 60 ms tick at `main.ts:303` runs only while a stream is starting or running. |
| Idle CPU, host in background agent mode | under 0.2% | Same. |
| Mac client: time blocked before first window | 0 process spawns | `releaseMacHost` (`main.ts:178-180`) moves after the window is shown, or is skipped when neither LaunchAgent plist exists. |
| Phone page transfer | under 40 KB | Sum of response sizes with `Accept-Encoding: gzip` in the server test. |
| Host input handling | under 1 ms p99 frame to `pad.update` | vitest loop, 10,000 frames, fake pad. |
| Phone link RTT, 5 GHz Wi-Fi | median under 10 ms | The new RTT readout, 60 s of play. Real phones only. |
| App JS size | no growth over 60 KB in `dist` excluding maps | `du -sk dist` before and after. Maps are already excluded from the package (`electron-builder.config.cjs:22`). |
| Log volume | packaged default level `info` | Check `logger.ts:129`; debug only with a flag. |

Lazy per-role imports (`main.ts:8-11`, `wiring.ts:7-19`) are done only if the cold-start target is missed after the
other fixes.

---

## 7. Codebase review: top 10

Lines marked [S] come from a delegated read of the non-network files; I re-checked the ones quoted here except where
noted.

| # | Severity | Where | Problem | 0.5 action |
|---|---|---|---|---|
| 1 | High | `src/core/host/agent.ts:300` (auto-approve default true) with `scripts/windows/set-agent-firewall-rule.ps1:39` (`-Profile Any`) | On a public network (hotel, cafe) any device on the subnet can pair with no prompt and control the PC. | Not changed (restricting profiles would break homes marked "Public"). Recorded; owner decision for 0.5.1: auto-approve off when Windows reports a Public network. |
| 2 | High | `src/contracts.ts:104` | `origin_web_ui_allowed: 'lan'` leaves Sunshine's admin UI reachable from the LAN although LanPlay only uses 127.0.0.1. | Fix now (D09). |
| 3 | High | `scripts/electron-builder.config.cjs:59-60`; `src/core/host/service.ts:327`, `src/core/controller/setup.ts:38` [S, last two not re-read] | Per-user install, yet files in that user-writable folder are run elevated. Same-user malware gets admin at the next UAC prompt. | Deferred (D23). |
| 4 | Medium | `src/core/update/update.ts:137` | A staged update is validated only against a hash stored next to it in unsigned `staged.json`, then executed at next launch. | Deferred (D23): re-verify the signed manifest at apply time. |
| 5 | Medium | `src/core/controller/service.ts:73-78`; comment at `server.ts:4` | The "per-session" token is persistent, in plain `settings.json`, and travels in the URL over HTTP. A shared QR screenshot works until "New link". | Keep behaviour (D17); fix the wording in code, docs and host UI. |
| 6 | Medium | `src/core/controller/server.ts:128` | The "IP-literal Host" check is the regex `^[0-9a-f.:]+$`, which also matches DNS names made of hex letters (for example `dead.be`). The DNS-rebinding guard can be bypassed; the token still protects the API and socket. | Fix now: use `net.isIP` on the parsed host. |
| 7 | Medium | `src/core/controller/server.ts:191`, `:206` | Layouts are keyed by phone IP. A DHCP change loses a phone's layouts or hands it another phone's. | Fix now (D16). |
| 8 | Medium | `src/core/controller/server.ts:271-275` into `manager.ts:118-124` | A closed socket destroys the virtual pad at once. A one-second Wi-Fi drop is a controller unplug to the game, and the slot can change. | Fix now (section 3, item 1). |
| 9 | Low | `src/main/main.ts:303` (60 ms timer for the app's lifetime), `:178-180` (two `launchctl` spawns before the first window), `:8-11` (both roles imported eagerly) | Idle wakeups and slower start. | Fix the first two now; third only if measured. |
| 10 | Low | `src/main/updates.ts:68-71` (unbounded `arrayBuffer()`), `src/core/update/update.ts:179` (no manifest freshness) [S, not re-read] | Memory blow-up on a hostile or broken download; an older signed manifest can be replayed. | Deferred (D23). |

Also found, not ranked: `HostInfo.httpPort` is written from a constant and never read (`discovery.ts:248`); the
bitrate floor of 20 Mbps (`contracts.ts:283`) makes internet play impossible; `agent.ts:65` and `server.ts:152` clear
whole rate-limit maps when they fill (resets every limit at once; the global limiter still holds); secrets appear
briefly in argv (`moonlight.ts:57`, `steps.ts:438` [S]), already documented in SPEC section 4.

Checked and sound: Electron isolation and IPC validation [S]; argv-only process spawning [S]; agent guard order;
token comparison in constant time (`server.ts:144`); input clamping (`protocol.ts`).

---

## 8. Use of `docs/ecc-reference`

Vetted by reading each file. MIT licensed. Every agent file opens with the same "Prompt Defense Baseline" boilerplate,
which adds nothing here. Nothing is installed into `~/.claude`; files are read as reference by whoever needs them.

| File | Verdict | Use |
|---|---|---|
| `code-reviewer.md` | **Use, in part.** | The Opus audit follows its gating rules: report only above 80% confidence, HIGH and CRITICAL need proof (file:line plus a failing test or a traced path), zero findings is acceptable, and the listed false positives are skipped. Ignore the React/Next.js and database sections. |
| `build-error-resolver.md` | **Use.** | Brief for a Sonnet fixer when `npm run typecheck` or `npm test` breaks after merge: minimal diffs, no design changes. |
| `tdd-workflow/SKILL.md` | **Use the loop only.** | For the client-core, host and controller-host chunks: write the failing vitest first, then the code. Reject the 80% coverage rule, Playwright, the Supabase/Redis mocks, the evidence report and the git checkpoints. |
| `security-review/SKILL.md` | **Reject, except three headings.** | It is a web-app checklist (SQL injection, Supabase, a Solana section). Only "input validation", "rate limiting" and "sensitive data exposure" are used as a checklist for the agent and controller-server diffs. |
| `security-review/cloud-infrastructure-security.md` | Reject. | There is no cloud. |
| `planner.md`, `architect.md` | Reject. | Generic templates with Stripe and Next.js examples; this document already is the plan and the decision record. |
| `network-architect.md` | Reject. | Enterprise multi-site routing; unrelated to NAT traversal for a game stream. |
| `performance-optimizer.md` | Reject. | React, Lighthouse, Web Vitals, SQL. Only "measure first" applies, and section 6 does that. |
| `windows-desktop-e2e/SKILL.md` | Reject for 0.5. | pywinauto targets WPF, Win32, Qt; it would add a Python toolchain for an Electron app. `docs/WINDOWS-TEST.md` stays the manual checklist. |

---

## 9. Build work-breakdown

Rules for every builder: no commits, no git commands that change state; no new dependencies; run
`npm run typecheck && npm test` before reporting; report measured numbers, not expectations. New tests go in new files
unless an old assertion encodes behaviour this plan replaces. No file appears in two chunks.

**W0 runs first, alone. W1 to W6 run in parallel after it. W7 last.**

| Chunk | Files | Work | Acceptance |
|---|---|---|---|
| **W0 Contracts** | `src/contracts.ts`, `src/link-contract.ts`, `src/main/ipc.ts`, `src/preload/preload.ts`, `tests/contracts.test.ts`, `tests/main/ipc-wiring.test.ts` | `HostInfo.remote?: boolean`; `PresetId` + preset `internet`; `BITRATE_LIMITS_MBPS.min = 5`; `PairProgress.phase` adds `show-code`, field `code?: string`; `PairErrorCode` adds `code-timeout`; `sunshineManagedConfig(internet)` replacing the constant (D08, D09); step id `firewall-internet` in `HOST_STEP_ORDER`; handoff field `internet`; types `InternetHostState { enabled, lanAddresses, globalIpv6, lastError? }`, `PendingCodePairing { id, name, address, remote }`; IPC `host:internet-get`, `host:internet-set {on}`, `host:pending-list`, `host:pending-pair {id, pin, name}`, `host:pending-reject {id}`, event `host:internet-changed`; `HostService` and `PairAgent` interface methods for these; `client:recent-remote` invoke; validators for all. | Typecheck passes with stubs; validators reject a non-4-digit pin and a malformed id. |
| **W1 Client core** | `src/core/shared/ipnet.ts`, `src/core/shared/netprobe.ts`, `src/core/client/discovery.ts`, `serverinfo.ts`, `pairing.ts`, `moonlight.ts`, `settings.ts`, `service.ts`, `tests/core/client-*.test.ts`, `tests/core/shared.test.ts`, `tests/fixtures/fake-moonlight.mjs`, new `tests/core/online-client.test.ts` | Section 2.1 client rows, 2.6 messages, D11 check with the bundled Moonlight (`list 127.0.0.1:47989` vs a wrong port). | `addManual('203.0.113.7')` and `('203.0.113.7:47989')` and `('[2001:db8::1]:47989')` succeed with `remote: true`; a public mDNS or UDP answer is still dropped; LAN pairing tests pass unmodified; remote pairing emits `show-code`, never calls `agentRequest`, succeeds when fake Moonlight exits 0, returns `code-timeout` otherwise; each 2.6 condition yields its exact message; D11 result written in the report. |
| **W2 Host** | `src/core/host/agent.ts`, `service.ts`, `steps.ts`, `sunshine-conf.ts`, `ps.ts`, `mac/service-mac.ts`, `mac/steps-mac.ts`, `mac/sunshine-mac.ts`, new `scripts/windows/set-internet-firewall-rule.ps1`, `tests/core/agent.test.ts`, `host-*.test.ts`, `ps-wrappers.test.ts`, `winargs-locate-conf.test.ts`, `tests/fixtures/mock-sunshine.ts`, `fake-windows.ts`, `fake-mac-host.ts` | Section 2.1 host rows. Do the pending-code methods first; UPnP and `address_family` second (drop them rather than slip the release, and say so). Confirm the two Sunshine value names in its docs at the pinned tag. | Every existing agent guard test passes unmodified; a request from `203.0.113.7` to the agent still gets 403 with internet on; `pairWithCode` pairs through mock Sunshine and writes the ledger; wrong code returns a failure and leaves no ledger entry; conf written for on and off matches D08/D09; the PS script passes `npm run check:ps`. |
| **W3 Controller, host side** | `src/core/controller/protocol.ts`, `manager.ts`, `server.ts`, `layout-store.ts`, `service.ts`, `tests/core/controller-*.test.ts` | Section 3 items 1, 2 (echo), 4, 6; Host check fix (section 7 item 6); static entries `/icon-192.png`, `/icon-512.png`, `/wake.mp4`; CSP `media-src 'self'`; wording fix for D17. | Tests named in section 3; `Host: dead.be:47921` gets 421; `Host: 192.168.1.5:47921` passes; a hello without `id` still joins. |
| **W4 Controller page** | `src/controller-ui/*` (including the three new asset files), `src/renderer/copy-static.mjs`, `tests/ui/controller-page.test.ts` | Section 3 items 2 (send, timeout, readout), 3, 5, 7, 8, 9, 10; send `id` in hello; gear card rows per section 5. | Mirror test still passes; fake-socket tests for ping timeout and re-attach; manifest has no `start_url`; no `@keyframes` left; page still works when `requestFullscreen`, `wakeLock`, `orientation.lock` and `vibrate` are all missing. |
| **W5 Main and performance** | `src/main/main.ts`, `wiring.ts`, `updates.ts`, `src/core/shared/logger.ts`, `tests/main/wiring.test.ts`, `tests/main/cli-paths-security.test.ts` | Wire the W0 channels to the `HostService` / `ClientService` interfaces; section 6 fixes; `startup-ms` log line. Record baseline numbers first. | New channels reachable only in the right role; no interval under 1 s while idle (test with fake timers); before and after numbers for startup and idle CPU on this Mac in the report. |
| **W6 Renderer** | `src/renderer/*`, `tests/ui/app.test.ts`, `client.test.ts`, `host.test.ts`, `host-controllers.test.ts`, `model.test.ts`, `static.test.ts`, `helpers.ts` | Section 2.3 flow, section 5 in full, host Internet card and "Add a device with a code". | Static assertions from section 5; client test: remote host shows tag, warning and code; host test: pending row pairs with a code, Internet card body hidden while off; no string in the deleted list remains. |
| **W7 Docs and version** | `README.md`, `SPEC.md`, `docs/PHONE-CONTROLLER.md`, `docs/WINDOWS-TEST.md`, `docs/ONLINE-DESIGN.md` (superseded note at the top only), new `docs/ONLINE.md`, `package.json`, `package-lock.json` | Port-forward guide from 2.2, exposure text from 2.4, Android viewer steps, test list from section 10, version 0.5.0. | Every port number in the docs equals the `SUNSHINE` constants. |

**Opus audit after the build** (rubric: `docs/ecc-reference/code-reviewer.md` gating rules):

1. Each of D01 to D25 is either implemented as written or the deviation is listed with a reason.
2. `git diff` of `agent.ts`: the `handle()` function body is unchanged. A public source cannot reach `/v1/pair`.
3. `discovery.ts`: the only path that can add a non-private address is `addManual`. Trace all four callers of `confirm`.
4. No code path sends the pairing code to a remote address.
5. `controller/server.ts`: `isAllowedAddress` still private-only in `main.ts`; Host check uses `net.isIP`.
6. The LAN regression set passes without edits: `tests/core/agent.test.ts`, `client-e2e.test.ts`, `controller-server.test.ts` (apart from the documented Host and slot changes).
7. Every chunk stayed inside its file list (`git status` against the table).
8. `package.json` dependencies unchanged except the version field.
9. CSS rules of section 5 hold by test, and by reading the three screens in the running app on this Mac.
10. Every UNVERIFIED item in this plan is either resolved with evidence or carried into `docs/ONLINE.md` as a known unknown.

---

## 10. Cannot be verified on this Mac: owner's test list

**Windows host**
- Elevated run with the internet switch: firewall rule created and removed; `sunshine.conf` has the D08/D09 values; Sunshine restarts and LAN play still works.
- Whether Sunshine's UPnP actually maps the six ports on the home router, and removes them when switched off.
- `origin_web_ui_allowed = pc`: Set up / Repair and the self-check still pass.
- Code pairing through the real Sunshine API (pending list shows the friend, right code pairs, wrong code fails cleanly).
- Sticky slot with the real ViGEmBus pad: a short disconnect does not show as an unplug in a game.

**Real internet**
- Client on a phone hotspot to the home public IP: add host, code pairing, 1080p60 at 15 Mbps for 10 minutes.
- Behaviour with ports not forwarded, with only TCP forwarded, and with a wrong IP: the messages in 2.6 match reality.
- Whether the home connection is behind CGNAT (router WAN address against the public IP).
- IPv6 end to end, if the provider offers it.
- Two remote players at once on one host: upload use against the 70% rule.
- `IP:port` against a host with a non-default Sunshine port (D11), if it shipped.

**Real phones**
- Android Chrome: fullscreen and landscape lock over plain HTTP; wake lock or the video fallback; three haptic strengths; home-screen shortcut opens and connects.
- iPhone Safari: nothing regressed (switch-overlay tick, Add to Home Screen sheet); the wake fallback keeps the screen on.
- Link RTT readout on 5 GHz and 2.4 GHz; Wi-Fi off and on recovers in 2 s with the same player number.
- Four phones at once, each with its own layout.

**Other**
- Stock Moonlight on an Android device pairing through "Add a device with a code".
- Cold-start and idle-CPU numbers on the Windows PC.
- A Mac as host with the internet switch (no firewall rule on macOS; UPnP and code pairing only).
