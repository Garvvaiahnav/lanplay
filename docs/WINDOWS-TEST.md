# LanPlay first test: Windows PC (host) + Mac mini M4 (client)

## TL;DR
1. PC: unzip `LanPlay-windows-x64.zip` to `C:\LanPlay`, double-click `C:\LanPlay\win-unpacked\LanPlay.exe`, click **Install and set up**, say Yes to the one Windows admin prompt.
2. Mac: right-click `LanPlay.app` > Open, allow Local Network, pick the PC, press **Pair and stream**. No PIN to type.
3. Stream at 4K, 60, 80 Mbps, codec HEVC, with the TV in game mode.
4. Film the PC screen and the TV together in slow motion to measure delay.
5. If anything fails: on the PC press **Copy diagnostics**; on the Mac run the `--diagnostics` command in section F. Send the one zip.

Do the sections in order (A, B, C, D, E). Stop at the first failure and go to F. Section G is the 0.5 list of checks that
could not be done on a Mac (internet play, Windows firewall, real phones); do it after A to C pass.

## Before you start
- PC and Mac mini on the same router. Use Ethernet on both if you can (80 Mbps over Wi-Fi is risky).
- PC has a monitor plugged in and switched on. Do not use Remote Desktop on the PC while testing.
- The PC needs the admin password once (Windows shows it as a prompt).

## A. Windows PC: install the host
Files: `release/LanPlay-windows-x64.zip` (about 190 MB). Copy it to the PC with a USB stick or a shared folder.

A1. Unzip to a normal folder (not Downloads, not Program Files). In PowerShell:
```
Expand-Archive -Path "$HOME\Downloads\LanPlay-windows-x64.zip" -DestinationPath C:\LanPlay
```
(Or right-click the zip > Extract All, and pick `C:\LanPlay`.)
Check: `C:\LanPlay\win-unpacked\LanPlay.exe` exists, and
`C:\LanPlay\win-unpacked\resources\vendor\Sunshine-Windows-AMD64-installer.msi` exists.

A2. Double-click `LanPlay.exe`. Start it normally, NOT "Run as administrator".
- Windows says "Windows protected your PC" (the app is unsigned): click **More info**, then **Run anyway**.
- The window is titled **LanPlay host**. Cards: "This PC", "Devices", "Internet", "Phone controllers", "Health".
- First run: Sunshine chips say "Installed: no" and "Running: no". Write down the PC name.

A3. Click **Install and set up**. Windows shows one admin prompt: click **Yes**. Takes 1 to 3 minutes.
- The list fills in this order, each with a **Pass** badge:
  Running as administrator, Find Sunshine, Install Sunshine, Sunshine service, Sunshine settings, Sunshine admin login, Restart Sunshine, Sunshine web API reachable, Sunshine API login works, Firewall rule "Sunshine", Firewall rule "LanPlay Pair Agent", Firewall rule "LanPlay Internet Play" (internet switch), Start LanPlay pair agent at login, LanPlay pair agent answering.
- "Skipped" is fine (for example "Install Sunshine" if it was already there). A "Warning" is fine. A **Fail** is not: go to F.
- Done message at the top: **Setup finished. This PC is ready.** Chips now say Installed: yes, Running: yes. The Devices card says "Pair agent is listening on port 47920."

A4. Leave "Allow connections from the internet" OFF for now (sections A to F are LAN only; G switches it on). Leave "Auto-approve devices on my network" ON (it is on by default). Closing the window keeps LanPlay running in the background; that is what the Mac needs.

A5. Optional check in PowerShell (no admin needed). Expect Running, two rules, and five listening ports:
```
Get-Service SunshineService
Get-NetFirewallRule -DisplayName "Sunshine","LanPlay Pair Agent" | Select DisplayName,Enabled,Direction,Action
Get-NetTCPConnection -State Listen -LocalPort 47984,47989,47990,48010,47920 | Select LocalPort
```
You can also press **Run self-check** in the Health card: it should say "All checks passed".

## B. Mac mini: open the app and pair
App: `/Users/garv/lanplay/release/mac-arm64/LanPlay.app` (Moonlight is bundled inside; you install nothing).

B1. First open: right-click `LanPlay.app` > **Open** > **Open**. It is unsigned (ad-hoc only).
- If macOS says it is "damaged" or "can't be opened": run this, then open it again:
  `xattr -dr com.apple.quarantine /Users/garv/lanplay/release/mac-arm64/LanPlay.app`
- macOS asks to find devices on the local network: click **Allow**. If you clicked Don't Allow: System Settings > Privacy & Security > Local Network > turn LanPlay on, then reopen the app.

B2. The window is titled **LanPlay**. The PC should appear in the host list within about 6 seconds with the status "Needs pairing". If not: press **Search again**, or type the PC's IP address in **Connect by IP** and press **Add** (find it on the PC with `ipconfig`).

B3. Select the PC. Press **Pair and stream**. The line at the top changes: Checking the PC... > Starting Moonlight... > Asking the PC to accept... > Confirming... > Making sure it worked... > Paired.
- A small Moonlight pairing window may flash up. Do not type anything; LanPlay supplies the code.
- On the PC, the "Paired devices" card now lists the Mac ("paired with LanPlay").
- After this the button says **Stream** and the PC says "Ready".

## C. First stream: 4K, 60 fps, HEVC, 80 Mbps
C1. TV: switch it to Game mode. Mac mini: System Settings > Displays > 3840x2160 at 60 Hz.

C2. In LanPlay open **More settings** (before pressing Stream):
- Resolution: **4K**. Frames per second: **60**. Video codec: **HEVC** (do not use Auto: Auto picks AV1 on an M3 or newer Mac).
- Bitrate: drag the slider to **80 Mbps** (steps of 5, from 5 Mbps; arrow keys work once it is clicked).
- The Preset line then shows **Custom**. That is expected. Leave the sliders alone after this; the settings are saved.

C3. Press **Stream**. The button goes Starting... > Streaming, and Moonlight goes full screen on the TV showing the PC desktop (app "Desktop").
- Move the mouse, type, play a video or a game for 2 minutes. Note stutter, blur, blocky picture, no sound, or lag.
- Moonlight's own shortcuts (not LanPlay): Ctrl+Option+Shift+S shows the stats overlay, Ctrl+Option+Shift+Q ends the stream.
- To stop: use that shortcut, or in LanPlay press **Stop streaming**.

## D. Latency check (phone, slow motion)
1. On the PC open any millisecond stopwatch (for example search "online stopwatch ms") and start it.
2. Stream it to the TV (section C settings). Put the PC monitor and the TV side by side.
3. Phone in slow-motion video (240 fps if it has it). Film the PC monitor and the TV in the same shot, about 10 seconds.
4. Pause on any frame. Read both numbers: the PC time minus the TV time is the total delay. Do it for 5 frames and write down all 5.
5. Also write the numbers from the Moonlight stats overlay (Ctrl+Option+Shift+S): network latency, decode time, dropped frames.
6. Run it again with the Preset **Lowest latency** (1080p, 120) and note the difference. Send the numbers back; there is no pass mark yet.

## E. Call of Duty (keyboard and mouse only)
- LanPlay sets up NO virtual gamepad. Use the Mac's keyboard and mouse only. A controller connected to the Mac is not a supported test.
- Go offline first: start with campaign, a private match with bots, or a training mode. Do not join online or ranked games yet; anti-cheat may object to streaming software, and we do not know yet.
- Note: does the mouse feel right, does the game keep focus, does the picture stay full screen. Play 10 minutes.

## F. What to send back
Send ONE zip from each computer that had a problem (both is best). The zip has logs, self-check, network and settings with passwords and PINs removed.

PC (host): in the **Health** card press **Copy diagnostics**. The zip is saved on the PC's Desktop as
`LanPlay-diagnostics-<PC name>-<date>-<time>.zip`. The full path is shown with a **Show file** link and copied to the clipboard.
Backup (PowerShell): `& "C:\LanPlay\win-unpacked\LanPlay.exe" --diagnostics | Write-Output` prints the zip path (same Desktop folder).

Mac (client): the Mac screen has no diagnostics button, so use Terminal:
```
/Users/garv/lanplay/release/mac-arm64/LanPlay.app/Contents/MacOS/LanPlay --diagnostics
```
It prints the path and saves `LanPlay-diagnostics-<Mac name>-<date>-<time>.zip` on the Mac Desktop.
Self-check (optional, same app path, `--self-check` instead): prints a report; a copy goes to `~/Library/Logs/LanPlay/`.

Also send: what you pressed last, the exact words on screen, the section letter, and the delay numbers from D.

## Most likely failures
| Where | Message you see | Try this one thing |
|---|---|---|
| PC | "Windows protected your PC" | More info > Run anyway |
| PC | "The Windows admin prompt was cancelled." | Press the setup button again and choose Yes (button is **Set up / Repair** once installed; the message may still say "Set up this PC") |
| PC | LanPlay was started with "Run as administrator" (red hint) | Close it and start it by double-click |
| PC | "An old Sunshine installer (NSIS...) is installed" | Windows Settings > Apps > Sunshine > Uninstall, then set up again |
| PC | "Another installation is running (msiexec 1618)" | Wait a minute, set up again |
| PC | "The bundled Sunshine installer is missing" or "does not match its pinned SHA256" | Delete `C:\LanPlay`, unzip again |
| PC | "Sunshine reports it found no working video encoder or display" | Update the graphics driver, plug in and turn on a monitor, no Remote Desktop |
| PC | "Pair agent is not running." | Press **Set up / Repair**; if it stays, send diagnostics |
| Mac | "No PC found yet. Check that LanPlay is running on it, or use Connect by IP." | Check LanPlay is open on the PC and Local Network is allowed; else add the IP |
| Mac | "Needs pairing (LanPlay not found on that PC)" | Open LanPlay on the PC, then Search again |
| Mac | "Could not reach LanPlay on the PC. Is it running there, on the same network?" | Same router? Check the Windows firewall rule "LanPlay Pair Agent" (A5) |
| Mac | "The PC refused this request. Both computers must be on the same home network." | Put both on the same router, not guest Wi-Fi |
| Mac | "Sunshine is not ready on the PC. Open LanPlay there and press Set up / Repair." | Do that, then try again |
| Mac | "The PC did not see the pairing request. Try again." / "Pairing took too long." | Press Pair and stream once more |
| Mac | "Moonlight stopped before pairing finished." / "Moonlight is missing from this app." | Open the app again; if it repeats, re-copy `LanPlay.app` |
| Mac | "Moonlight exited right away (code ...)" | Press Stream again; send the Mac diagnostics zip |
| Mac | "Too many tries. Wait a minute and press Stream again." | Wait one minute |
| Mac | Stutter or blocks at 4K60 | Use Ethernet, then try 60 fps at 50 Mbps and compare |

## G. 0.5 checks that need real Windows, a real network or real phones
Tick each box; write down the exact words on screen for anything that differs from "Expect". Nothing here has been run yet. Background
and the port table: `docs/ONLINE.md`. If something fails, go to F.

**G1. Windows host with the internet switch (needs admin)**
- [ ] Press the **Allow connections from the internet** switch on the Internet card and say Yes to the admin prompt. Expect: the setup list shows Firewall rule "LanPlay Internet Play" as Pass, a banner "Internet play is on" appears, and the Sunshine settings step passes.
- [ ] In PowerShell: `Get-NetFirewallRule -DisplayName "LanPlay Internet Play" | Select DisplayName,Enabled,Direction,Action`. Expect two inbound Allow rules (TCP 47984, 47989, 48010 and UDP 47998-48000), remote address Any.
- [ ] In `C:\Program Files\Sunshine\config\sunshine.conf`: `upnp = enabled`, `address_family = both`, `origin_web_ui_allowed = pc`. Sunshine restarted (`Get-Service SunshineService` is Running).
- [ ] LAN play still works from the Mac (section C) with the switch on.
- [ ] **Run self-check**: it passes with the switch on and with it off (this covers `origin_web_ui_allowed = pc`: Set up / Repair must still reach Sunshine's web API on this PC).
- [ ] Switch it off, approve the prompt. Expect: the rule is gone (the `Get-NetFirewallRule` command finds nothing), `sunshine.conf` has `upnp = disabled` and `address_family = ipv4`, the banner goes away, LAN play still works.
- [ ] On the router's UPnP or port-mapping table: with the switch on, are TCP 47984, 47989, 48010 and UDP 47998-48000 listed? Are they gone after switching off? (A router that does not list them needs manual forwarding.)

**G2. Code pairing against the real Sunshine**
- [ ] A device that is not paired (Mac client or the stock Moonlight app) starts pairing. Expect: a row under **Add a device with a code** with the device name and address (an internet device has the `Internet` tag).
- [ ] Type a wrong code and press Pair. Expect: a failure message on that row, no new entry in the Devices list.
- [ ] Start pairing again, type the right code. Expect: the device is paired and listed with Revoke.
- [ ] Does `Moonlight pair` on the client exit by itself after the host types the code, or stay open? Write down which.

**G3. Real internet (client on a phone hotspot)**
- [ ] Join the Mac to a phone's mobile-data hotspot. Type the home public IP in **Connect by IP**. Expect: the host appears with the `Internet` tag and the warning line.
- [ ] Press Stream. Expect: a 4-digit code and "Waiting for the host to enter the code". Host types it. Expect: paired, then the stream starts with the Internet preset (1080p, 60 fps, 15 Mbps).
- [ ] Stream 10 minutes. Write down picture, delay, any stutter, and the Moonlight stats (Ctrl+Option+Shift+S).
- [ ] Failure messages. Compare each with the table in `docs/ONLINE.md` and write down any difference: (a) switch off on the host or ports not forwarded, (b) only the TCP ports forwarded (expect a stream that fails within 15 s with the UDP hint), (c) a wrong IP.
- [ ] CGNAT: compare the router's WAN address with the public IP.
- [ ] IPv6, if the provider gives it: type the host's global IPv6 address and repeat the pairing and stream.
- [ ] Two remote players at once: upload used against the rule players x bitrate x 1.12 under 70% of upload.
- [ ] Non-default Sunshine port: `IP:port` against a host whose Sunshine base port was changed (skip if you keep the default).

**G4. Windows virtual pad**
- [ ] Phone controller connected, a gamepad tester page open on the host. Turn the phone's Wi-Fi off for 3 seconds, then on. Expect: the page returns within 2 seconds as the same player number and the tester shows no unplug.
- [ ] Closing the phone's tab for more than 15 seconds frees the slot and removes the pad from the tester.
- [ ] Four phones at once, each with its own layout (change a layout on one; the others keep theirs).

**G5. Real phones** (controller page, home Wi-Fi)
- [ ] Android Chrome: one tap gives full screen and landscape lock (or the page still plays if Chrome refuses). Write down what was refused.
- [ ] Android: **Stay awake** says what is used; leave the phone untouched for 3 minutes during a long scene. The screen stays on, or the card says to set Auto-Lock to Never.
- [ ] Android: Haptics Off, Light and Strong feel different, and Off is silent.
- [ ] Android: Chrome menu, Add to Home screen. The shortcut opens the page and connects without typing the link.
- [ ] iPhone Safari: tap feedback from the switch overlay still works; Add to Home Screen works; the phone stays awake for 3 minutes.
- [ ] The **Link** readout on 5 GHz and on 2.4 GHz Wi-Fi (median under 10 ms on 5 GHz is the target, not yet measured). Wi-Fi off and on recovers in 2 seconds.
- [ ] Stock Moonlight on an Android device pairs through **Add a device with a code**, then streams (LAN first, then through the internet switch).

**G6. The app itself**
- [ ] The packaged app starts and shows its window on the Windows PC. Write down the time from double-click to window.
- [ ] Idle CPU of LanPlay on the PC with the window open (Task Manager, 60 seconds): under 0.5%.
- [ ] A Mac as host with the internet switch (optional): UPnP and code pairing only; there is no firewall rule on macOS.
