# LanPlay 0.5 build audit (Opus)

Audited 2026-11-21 14:40-15:00 IST against the uncommitted working tree on top of `8bc682b`. Rubric: `docs/RELEASE-0.5-PLAN.md`
section 9 ("Opus audit after the build") with the gating rules of `docs/ecc-reference/code-reviewer.md` (report only above
~80% confidence; HIGH needs a traced path). No file other than this one was written; no git state was changed.
W7 (docs, version) was still running while this was written: docs were read at 14:58 and may have changed since.

## Verdict: SHIP AFTER FIXES

The security invariants hold: the pair agent's `handle()` is unchanged and still refuses public sources; a public address
can enter the client's host list only through `addManual`; the pairing code is never sent to a remote address by LanPlay;
the phone controller server stays private-only with a real `net.isIP` Host check. Typecheck, full suite and the LAN
regression set pass. One medium-high correctness/safety bug in the internet switch revert path must be fixed first
(fix 1). The rest are medium or low.

## Commands run

| Command | Result |
|---|---|
| `npx vitest run tests/core/agent.test.ts tests/core/client-e2e.test.ts tests/core/controller-server.test.ts` | 3 files, 56 tests, all pass |
| `npm run typecheck` | exit 0 (both tsconfigs) |
| `npx vitest run` | 47 files, 1039 tests, all pass |
| `npm run check:ps` | all scripts OK, including the new `set-internet-firewall-rule.ps1` (one pre-existing warning in `setup-controllers.ps1:84`) |
| `git diff src/core/host/agent.ts` | `handle()` body untouched (see rubric 2) |

## Required fixes, ranked

1. **Medium-high. Internet switch revert leaves UPnP/IPv6 on while the UI says off.** `src/core/host/service.ts:444-459`.
   `setInternet(true)` saves the switch, runs every elevated step (the loop in `runElevatedSteps` never stops on a
   failure), and if any of `admin/config/restart-service/firewall-internet` failed it sets the switch back to off. But
   `firewall-internet` is the last elevated step: when it fails, `config` has already written `upnp = enabled` and
   `address_family = both` and `restart-service` has already restarted Sunshine. Result: switch off, banner hidden,
   Sunshine asking the router for port mappings. Same shape on the Mac (`src/core/host/mac/service-mac.ts:321-336`,
   `mac-launch-agent` after `config`). Fix: when an enable attempt fails, run the steps again with `internet = false`
   (or keep the switch on with `lastError` and the banner visible); never report "off" while the conf says on.
   Traced by reading; no test covers it.
2. **Medium. Two setup runs can race.** `src/main/wiring.ts:266` uses `once('setup')`, `:284` uses `once('internet')`.
   Pressing Set up / Repair while the switch is applying starts a second run (second UAC prompt, concurrent writes to
   `sunshine.conf`, firewall rule created by one run and removed by the other). Use one key for both.
3. **Medium. "Press Stream to get a new code" fails once after a code timeout.** `src/core/client/pairing.ts:132`,
   `:243`. The repo's own comment at `pairing.ts:133-139` says Sunshine keeps one pending pairing per Moonlight client
   for up to 5 minutes and answers a second one with 409, and the LAN path retries once for that reason. The remote path
   has no retry: after `code-timeout` (Moonlight killed, Sunshine session still pending) the next Stream ends in
   `moonlight-failed` ("Moonlight pair exited with ..."). Fix: retry once when `Moonlight pair` exits non-zero within a few
   seconds, as the LAN path does. UNVERIFIED on a real Sunshine; traced from the documented behaviour.
4. **Low-medium. Two tabs of the same phone flap forever.** `src/core/controller/server.ts:344` closes the older socket
   with `1000 'replaced'`; `src/controller-ui/controller.ts:1873` treats every close as a lost link and reconnects, which
   replaces the other tab, and so on (both tabs share the stored id). Fix: treat close reason `replaced` as final on the
   page, like `kicked`.
5. **Low. Renderer re-applies the Internet preset every session.** `src/renderer/client.ts:280` applies it whenever the
   host is not in the in-memory list, i.e. on every app start when the user re-adds a recent host, overwriting a Custom
   choice. The service (`src/core/client/service.ts` `rememberRemote`) already does the one-time apply correctly. D12 says
   "once". Drop the renderer copy or gate it on the recent list.
6. **Low. Wrong success line after a revert.** `src/renderer/host.ts:249` says "Internet play is on." even when the
   returned state has `enabled: false` and `lastError`. Use `inet.enabled`.
7. **Low (defence in depth).** `src/core/client/pairing.ts` LAN path sends the PIN to `ip` relying only on
   `host.remote` being right. It is right today (traced in rubric 3/4), but add `if (!isPrivateAddress(...)) throw` before
   `callAgent`.
8. **Low. Copy and comment leftovers.** Single ellipsis character in UI strings (`pairing.ts` progress messages, 10 of
   them; `controller.ts:993`, `:997`) against section 5. "session token" at `controller.ts:40` (D17 wording). Stale
   comments `agent.ts:34` and `ps.ts:6` (both say the contract lacks a value it now has; `ps.ts:6` is a dangling doc
   comment, and `ps.ts:50` casts `script as PsScriptName`, weakening the script-name type).
9. **Low.** `src/main/ipc.ts:84` limits the device name to 64 UTF-16 units while `cleanDeviceName` allows 64 code
   points; a name with astral letters near 64 cannot be paired from the UI. Simpler: let the agent use the pending
   entry's own name and drop `name` from the IPC payload.

Not a fix, but note: with `Moonlight list` polled every 5 s while `Moonlight pair` is still running
(`pairing.ts:220-232`), two Moonlight processes run at once for the first time; whether they can clobber each other's
settings file is UNVERIFIED. A `list` in flight when the race settles keeps running up to `listTimeoutMs` (20 s); it is
bounded, not leaked. The Moonlight pair child is always terminated in the `finally` (`pairing.ts:268-272`) and both timers
are cleared.

## Ledger D01-D25

| ID | Status | Evidence / note |
|---|---|---|
| D01 | Implemented | `discovery.ts` `addManual` accepts IP, `IP:port`, `[v6]:port`, names; `moonlightTarget` passes the address straight to Moonlight. |
| D02 | Implemented | mDNS (`discovery.ts:145`) and UDP (`:179`) still filter private; new `lookup()` refuses non-private for any source other than `manual` (stronger than required). |
| D03 | Implemented | `isPrivateAddress` unchanged; `isRemoteAddress` = valid IP and not private, so 100.64/10 is remote. |
| D04 | Implemented | `handle()` unchanged; new methods are not routed. |
| D05 | Implemented | Remote branch at `pairing.ts:132` never calls the agent; code shown via `show-code`. |
| D06 | Implemented | `listPending/pairWithCode/rejectPending`, host "Add a device with a code" polled every 3 s while visible. |
| D07 | Implemented, with bug | Default off, via the elevated Set up / Repair. Revert path bug: fix 1. |
| D08 | Implemented | Values `ipv4`/`both` confirmed from the pinned Sunshine 2026.914.233613 web UI bundle in `vendor/` (option values; defaults `upnp: disabled`, `address_family: ipv4`). `upnp = enabled` relies on Sunshine's bool parser; not run against a live Sunshine (UNVERIFIED). The contract comment still says UNVERIFIED. |
| D09 | Implemented | `origin_web_ui_allowed: 'pc'` for everyone. |
| D10 | Implemented, small deviation | A port on a **LAN** address other than 47989 is rejected ("only supported for internet addresses"). Acceptable. |
| D11 | Shipped on builder evidence | `moonlight.ts` comment says bundled 6.2.0 accepted `ip:port` against a local fake Sunshine. Not reproduced by this audit (UNVERIFIED); no written W1 report found in the repo. Carried into ONLINE.md. |
| D12 | Implemented, small deviation | Floor 5, preset `internet` 1080p60 15 Mbps. "Once" broken by the renderer (fix 5). |
| D13 | Implemented | Text on the host Internet card (`host.ts:107`) and in ONLINE.md. |
| D14 | Implemented | `main.ts:114` still `isPrivateAddress`; no new phone route. |
| D15 | Implemented | Fullscreen/orientation/wake lock/video fallback, sticky slot, ping/RTT, gzip. Page transfer measured: 42.2 KB gzipped text (35.6 KB JS) plus icons, slightly over the 40 KB target. |
| D16 | Implemented | `hello.id`, slots and layouts keyed on it; layout files are `p-<sha256 prefix>.json`, never the raw id. |
| D17 | Implemented, one leftover | Code and docs fixed; `controller.ts:40` still says "session token". |
| D18 | Implemented (docs) | ONLINE.md "Android and iPhone as a viewer". |
| D19 | Implemented (not done, as decided) | No rumble code. |
| D20 | Implemented, copy leftovers | See rubric 9 and fix 8. |
| D21 | Implemented | `package.json`/lock untouched. |
| D22 | Implemented | 60 ms tick only while a stream is active (`createPollWhileActive`); `launchctl` after the window; gzip in memory; `resolveLogLevel` gives `info` packaged. Before/after numbers not found in the repo (UNVERIFIED). |
| D23 | Implemented (deferred, as decided) | The new internet rule also uses `-Profile Any`, consistent with the recorded debt. |
| D24 | Implemented | Nothing installed; `docs/ecc-reference` pre-dates the build. |
| D25 | Implemented | HEAD is still `8bc682b`; no commits. |

## Rubric

1. **Ledger coverage:** all 25 accounted for above; deviations D10, D12 (fix 5), D17 leftover, D07 bug.
2. **Agent:** the diff adds imports, `cleanDeviceName`, the three local methods, `sunshineMessage`, and a ledger type.
   `handle()` (`agent.ts:526`) is byte-identical; the private-source deny at `:542` and Host check at `:547` precede every
   route. The new methods are reachable only through IPC handlers built for the host role. `pairWithCode` validates id
   (32 hex) and pin (4 digits), runs under the same `pairMutex` as LAN pairing, re-reads the pending list inside the mutex,
   writes the ledger only on success. LAN `doPair` matches pending pairings by private addresses only, so a LAN agent
   request cannot approve an internet device's pending pairing. **Pass.**
3. **Discovery:** `confirm` now has three callers (mDNS `:145`, UDP `:180`, port probe `:212`), all with private filters
   before the call, and `confirm` is typed `Exclude<DiscoverySource,'manual'>`. `lookup()` throws for a non-private
   address unless the source is `manual`; `addManual` is its only `manual` caller. `merge` keys a remote host as
   `remote:<ip:port>` with a single address, so discovery never merges into it and it never becomes a LAN entry's
   `preferredAddress`. **Pass.** Nit: typing `0.0.0.0` counts as remote and probes the local machine.
4. **Pairing code:** remote path never calls `agentRequest`; the PIN goes only into `Moonlight pair` argv (pre-existing,
   documented) and the `client:pair-progress` event to the renderer (by design). `log.redactor.addSecret(pin)` is called;
   the progress log line excludes the code. Host side never logs the pin. **Pass** (see fix 7 for hardening).
5. **Controller server:** `main.ts:114` private-only; `guard()` uses `isIP(host.host)`. Static serving is a fixed map
   lookup (no path from the URL reaches the filesystem; no traversal). Range: single range only, multi-range falls back to
   200, bad/unsatisfiable gives 416, suffix and open ranges correct. Gzip only for text and only when smaller; `Vary` set;
   cache cleared on stop; a missing file is retried per request (minor disk I/O, not a risk). Phone id: 16-32 chars
   `[A-Za-z0-9_-]`, hashed for file names. Takeover of a slot needs the token **and** the victim's id; the id is not exposed
   to other phones (host list omits it), so a LAN attacker who can read it can also read the token. Acceptable.
   Flapping bug: fix 4. **Pass with fix 4.**
6. **LAN regression:** passes. `agent.test.ts` and `controller-server.test.ts` unchanged. `client-e2e.test.ts` has one
   edited test: the assertion "public addresses are refused (manual entry)" became "a typed public address is probed".
   This encodes behaviour the plan replaces (D01/D02) and is acceptable; it also dropped the public IPv6 assertion
   without a replacement in that file.
7. **Chunk boundaries:** every modified or new file maps to its chunk's list (W0 contracts/ipc/preload; W1 client core
   + `online-client.test.ts`; W2 host + new PS script + `host-internet*.test.ts`; W3 controller + `controller-*` tests;
   W4 controller-ui, three assets, `copy-static.mjs`; W5 main/wiring/logger; W6 renderer + UI tests; W7 docs).
   `src/link-contract.ts`, `src/main/updates.ts`, `sunshine-conf.ts` untouched. **Pass.**
8. **Dependencies:** `package.json` and lock unchanged (version still `0.4.1`; W7 pending). **Pass so far.**
9. **CSS:** `styles.css`: radii 6/8/999/50%; sizes 13/15/17/22; weights 400/600; spacing 4/8/12/16/24; controls 36 px,
   Stream 48 px/17 px/600/radius 6; no gradient, blur, shadow or keyframes. `stream-menu.css` same. `controller.css`: no
   `@keyframes`, gradient, shadow; uses 6/8/999/50% plus side-specific 8 px corners (phone page keeps its own sizes, as
   allowed). Static tests pass. Deleted-strings list: none remain; "More settings" `<details>` present. The visual check
   of the three screens in the running app was not done (UNVERIFIED).
10. **UNVERIFIED carry-over** (docs/ONLINE.md as of 14:57, 206 lines): carried — Moonlight pair exit behaviour, UPnP on
    real routers, firewall rule on Windows, `origin_web_ui_allowed = pc` on Windows, code pairing against real Sunshine,
    Sunshine value names (with the vendor-bundle evidence), Mac host, sticky slot with ViGEmBus, CGNAT/messages, IPv6,
    two remote players, D11 `IP:port`, `wan_encryption_mode` default, all phone items, stock Moonlight Android, cold
    start / idle CPU. **Not carried:** the 40 KB page target (measured 42 KB, missed), the 10 ms RTT target (only the
    readout is listed), `ws` Nagle/deflate facts (a test exists in `controller-server-v2.test.ts`, so resolved), whether
    the home-screen shortcut opens without browser UI on an insecure origin (partly), the router-SNAT case below.
    W7 still open at audit time: `package.json` version, `docs/WINDOWS-TEST.md`, superseded note in
    `docs/ONLINE-DESIGN.md`. Port numbers in README, SPEC, ONLINE.md, PHONE-CONTROLLER.md all match `SUNSHINE`.

## Other checks requested

- **Firewall step on/off:** `firewall-internet` is elevated, idempotent, checks the named rules (both protocols, inbound
  Allow, ports covered, RemoteAddress Any) and removes every inbound rule with the display name when off. Correct; the
  ordering problem is fix 1.
- **IPC validators** for the six new channels: present and tight (`on` boolean, id 32 hex, pin `^[0-9]{4}$`, name
  charset). Preload lists match. Fix 9 is an edge case.
- **recentRemote:** stored only after a successful remote `addManual`, newest first, de-duplicated case-insensitively,
  max 5, filtered to strings on read; rendered with `textContent`.
- **Renderer XSS:** no `innerHTML`/`insertAdjacentHTML` anywhere in `src/renderer` or `src/controller-ui`; `h()` sets
  only `value/checked/disabled/hidden/selected` as properties, everything else via `setAttribute` or text nodes.
  Device names and addresses from Sunshine/Moonlight are safe.
- **Router SNAT (UNVERIFIED, new known unknown):** a router that source-NATs forwarded connections makes internet clients
  appear with the router's LAN address. Sunshine would then treat them as LAN (`lan_encryption_mode`, default off) and
  the pending row would not carry the `Internet` tag. Worth one line in ONLINE.md.
