# Playing over the internet

LanPlay 0.5 lets a friend stream from your PC over the internet with no LanPlay server, no account and no tunnel. The
friend types your public IP address; Moonlight connects straight to your PC. This page is the guide for both sides.
The decisions behind it are in `docs/RELEASE-0.5-PLAN.md`. The older `docs/ONLINE-DESIGN.md` (relay and WireGuard) is not
what was built.

Internet play is off by default and changes nothing for LAN-only users.

## What you need

- A host PC (Windows, or a Mac) that already works on your own network (Set up / Repair finished).
- A router you can log in to, or a router with UPnP switched on.
- An IPv4 address that is public. If your internet provider shares one address between many customers (CGNAT), IPv4
  hosting cannot work. See "Check for CGNAT".
- Upload speed: see "Bitrate and upload budget".
- The friend needs LanPlay in Viewer mode, or any stock Moonlight app.

The phone controller page stays LAN-only. A friend over the internet uses a gamepad or keyboard on their own computer;
Moonlight forwards it.

## Host: step by step

1. Open LanPlay on the host and find the **Internet** card. Switch on **Allow connections from the internet**. Approve
   the one Windows prompt. LanPlay runs Set up / Repair with the new settings: it writes `upnp = enabled` and
   `address_family = both` to `sunshine.conf`, creates the Windows firewall rules "LanPlay Internet Play" (TCP and UDP,
   any remote address, all profiles) and restarts Sunshine. On a Mac there is no firewall rule to add; only the
   Sunshine settings change.
2. If your router has UPnP switched on, Sunshine asks it to forward the ports itself. Whether this worked on your router
   is only known when a friend connects (see "Known unknowns").
3. Otherwise forward these ports on the router to the host PC's LAN address (shown on the card), same port outside and
   inside:

   | Protocol | Ports | Use |
   |---|---|---|
   | TCP | 47984 | HTTPS (pairing, launch) |
   | TCP | 47989 | HTTP (status, start of pairing) |
   | TCP | 48010 | RTSP |
   | UDP | 47998, 47999, 48000 | video, control, audio |

   Never forward 47990 (Sunshine admin web UI), 47920 (LanPlay pair agent) or 47921 (phone controllers). Give the PC a
   DHCP reservation (fixed LAN address) in the router; otherwise the forward can point at the wrong machine after a
   reboot.
4. Find your public IP address (search the web for "what is my IP") and send it to the friend.
5. When the friend starts pairing, a row appears under **Add a device with a code** with the friend's device name and
   address. The friend reads you a 4-digit code. Type it into that row and press **Pair**. An internet row carries the
   `Internet` tag.
6. Switch the option off when you are not playing. A banner stays on the host screen while it is on. Switching off removes
   the firewall rules and turns UPnP and IPv6 hosting back off.

Every device that has paired stays in **Devices** with its last address and a **Revoke** button.

LanPlay cannot test from outside whether your ports are reachable. The friend's first attempt is the test.

### Check for CGNAT

Compare the WAN (internet) address on your router's status page with the public IP you found in step 4. If they differ,
or the router's WAN address starts with 100.64 to 100.127 or is a private address, your provider uses CGNAT and
forwarding on your router cannot reach the PC from outside. Ask the provider for a public IPv4 address, or use IPv6.

### IPv6 option

The Internet card lists this PC's global IPv6 addresses (if any). Both sides need working IPv6, and your router's IPv6
firewall must allow the ports in the table above to this PC (an IPv6 address needs no port forward, only a firewall
allow). The friend types the IPv6 address in Connect by IP; `[2001:db8::1]` with brackets is accepted when a port is
added. This path is not tested end to end.

## Friend: step by step

1. Open LanPlay in Viewer mode. Under the host list, type the host's public IP in **Connect by IP** and press Add. A name
   is also accepted. `203.0.113.7:47989` (and `[2001:db8::1]:47989` for IPv6) is accepted only for an internet
   address; use a port only if the host changed Sunshine's base port, and then the host must forward the whole port family
   shifted by the same amount. The last 5 addresses you typed appear as buttons.
2. The host shows in the list with an `Internet` tag and the line "Internet host. Video and input go directly to this
   address. Only connect to people you know."
3. Press Stream. The first time, LanPlay shows a 4-digit code and waits 3 minutes. Read the code to the host over the
   phone or chat. The host types it into LanPlay on the host PC. The code is never sent to the host by LanPlay.
4. When the host has entered it, LanPlay confirms the pairing and starts the stream. Later sessions stream directly.
5. A newly added internet host selects the preset **Internet** once: 1080p, 60 fps, 15 Mbps, codec auto. The bitrate
   slider goes down to 5 Mbps. Raise it only when the host's upload allows it.

## Android and iPhone as a viewer (stock Moonlight)

A phone, tablet or TV can watch and play through the stock Moonlight app instead of LanPlay. It pairs with the same code
list on the host.

1. Install Moonlight from the Play Store (Android, Android TV) or the App Store (iPhone, iPad, Apple TV).
2. On the same Wi-Fi the host usually appears by itself. Over the internet, add the host: in Moonlight choose to add a PC
   and type the host's public IP address.
3. Tap the host. Moonlight shows a 4-digit code.
4. Read the code to the host owner, who types it in **Add a device with a code** on the host and presses Pair.
5. Moonlight finishes pairing; tap the host and start the Desktop app.

For a gamepad, use a Bluetooth gamepad on the phone; Moonlight forwards it. The LanPlay phone controller page is a
separate feature and is LAN-only. This path is not tested on a real device.

## Bitrate and upload budget

The host sends one stream per player. Keep:

`players x bitrate x 1.12  under  70% of the host's upload speed`

The 1.12 covers audio, control and protocol overhead. Examples:

| Host upload | Usable (70%) | Fits at 15 Mbps | Fits at 10 Mbps |
|---|---|---|---|
| 25 Mbps | 17.5 | 1 player (16.8) | 1 player |
| 50 Mbps | 35 | 2 players (33.6) | 3 players (33.6) |
| 100 Mbps | 70 | 4 players (67.2) | 6 players (67.2) |

Use the upload speed from a speed test run on the host PC, not the plan's advertised figure. The slider minimum is 5 Mbps.
LanPlay does not measure the link; it only shows this rule.

## What is exposed

Forwarding the ports puts Sunshine's network code on the open internet.

- Reachable without pairing: `/serverinfo` (host name, unique id, codec support, pair state) and the start of a pairing.
  Anyone can create pending pairings; each needs a code typed by the owner, so the damage is noise in the pending list.
  Pending entries expire after about 5 minutes.
- A bug in Sunshine's HTTP or RTSP code would be reachable by anyone. On Windows the Sunshine service runs as SYSTEM.
  This is the real risk and LanPlay cannot remove it.
- A paired device has keyboard and mouse on the host. Pairing a friend is giving them the PC while it is on.
- Not exposed: Sunshine's admin web UI (LanPlay sets `origin_web_ui_allowed = pc` and you do not forward 47990), the pair
  agent (47920) and the phone controllers (47921). The agent only answers private addresses and never takes part in
  internet pairing.
- Stream encryption for non-LAN clients is Sunshine's `wan_encryption_mode`. LanPlay does not write that key; the pinned
  Sunshine's own settings page lists "Enabled for supported clients" as its default.

Choices made: off by default, one explicit switch with this text beside it, code pairing only, admin UI bound to the
PC, and the firewall rules and UPnP removed when you switch off. Not done: a firewall allow-list of friend IPs (home
IPs change) and an automatic timed switch-off (needs a Windows prompt each time).

## When it does not connect

These are the messages LanPlay shows (`src/core/client/serverinfo.ts`, `pairing.ts`, `service.ts`). `<ip>`, `<port>` are
filled in.

| Condition | Message |
|---|---|
| Connection refused on the HTTP port | `<ip> answered but port <port> is closed. On the host: switch on Allow connections from the internet and forward the ports, and check that Sunshine is running.` |
| No answer in 5 s | `No answer from <ip>:<port>. The IP is wrong, the host PC is off, the ports are not forwarded, or the host's provider uses CGNAT (no public IPv4). LanPlay cannot tell which from here.` |
| No route (typical for IPv6) | `This computer has no route to <ip>. An IPv6 address needs IPv6 on both sides.` |
| Another socket error | `Could not connect to <ip>:<port> (<error code>).` |
| Something else answers | `Something answered at <ip>:<port> but it is not Sunshine.` |
| Code not entered in 180 s | `The host did not enter the code in time. Press Stream to get a new code.` |
| Stream dies within 15 s | the usual Moonlight message followed by `The host answered, so TCP works. If there was no picture, UDP 47998-48000 is probably not forwarded.` |
| A port typed for a LAN address | `Custom ports are only supported for internet addresses. Use the plain IP.` |

In an IPv6 address with a port the message shows the address in brackets.

## Testing before a friend does

The real test is a client on a different network from the host.

1. **Phone hotspot (the acceptance test).** The host stays at home. Join the viewer computer to a phone's mobile-data
   hotspot, so it is no longer on the home network. Type the home public IP in Connect by IP, pair with a code, stream
   1080p60 at 15 Mbps for 10 minutes.
2. Typing your own public IP from inside the same home network is not a valid test: many routers do not loop back.
3. Same-LAN rehearsal of LanPlay's own logic (not NAT or firewall): give both computers an extra address in the
   documentation range, then type the host's extra address. Mac: `sudo ifconfig en0 alias 203.0.113.11 255.255.255.0`.
   Windows (admin): `netsh interface ipv4 add address "Wi-Fi" 203.0.113.10 255.255.255.0`. Remove both afterwards. The
   firewall rule scope cannot be tested this way, because the alias counts as the local subnet.
4. Try the failure cases on purpose and compare with the table: ports not forwarded, only TCP forwarded, a wrong IP.

## Known unknowns

Nothing below has been checked on real hardware or a real network. Each is a thing to look at in the first real test.

**Host**
- Whether `Moonlight pair` (the viewer's pairing process) exits by itself after the host enters the code. LanPlay handles
  both cases: it also asks Moonlight every 5 seconds whether the host is paired.
- Whether Sunshine's UPnP really maps the six ports on real home routers, and removes them when the switch is turned off.
- The real Windows firewall result: the rule "LanPlay Internet Play" created and removed, and the upstream "Sunshine"
  rule's own remote-address scope (the LanPlay rule makes the result the same either way).
- `origin_web_ui_allowed = pc`: that Set up / Repair and the self-check still pass on Windows with it.
- Code pairing through the real Sunshine pending-pairing API (the pending row shows the friend, the right code pairs, a
  wrong code fails cleanly). Tested only against a mock Sunshine.
- The Sunshine value names. `address_family` `ipv4` and `both` are the two options in the pinned Sunshine's own settings
  page, and `upnp` accepts `enabled` (SPEC section 9); neither was tried against a running Windows Sunshine.
- Mac as a host with the internet switch: UPnP and code pairing only, no firewall rule.
- The ViGEmBus sticky slot: that a short phone disconnect (under 15 seconds) does not show up as a controller unplug in a
  game.

**Network**
- Whether your connection is behind CGNAT, and how the messages above compare with reality for: ports not forwarded,
  only TCP forwarded, a wrong IP.
- IPv6 end to end.
- Two remote players at once against the 70% rule.
- `IP:port` with a non-default Sunshine port: Moonlight 6.2.0 accepted it against a local fake Sunshine, not a real one.
- Whether Sunshine's `wan_encryption_mode` default applies as described (read from its settings page, not observed on the wire).
- A router that rewrites the source address of forwarded traffic (source NAT) makes internet clients look like LAN
  clients to Sunshine. Then Sunshine applies its LAN encryption setting (`lan_encryption_mode`, off by default) instead of
  the WAN one, and the pending row on the host has no Internet tag. Not seen on a real router yet; if the tag is missing
  for a friend who is clearly outside, suspect this.

**Phones**
- Android Chrome: fullscreen, landscape lock and wake lock over plain HTTP (they may need a secure context and be refused;
  the page then plays without them); the muted-video fallback keeping the screen on; the three haptic strengths; the home
  screen shortcut opening and connecting.
- iPhone Safari: that nothing regressed (switch-overlay tick, Add to Home Screen sheet) and that the video fallback keeps the
  screen on.
- The phone page transfer: about 42 KB gzipped for the text files (measured), against a 40 KB target, so the target is
  missed by a small margin. Cold load on a real phone has not been timed.
- Whether the home-screen shortcut opens without browser UI (it is served over plain HTTP, which may not count as an
  installable page). Unverified; it may open as an ordinary browser tab.
- Link readout on 5 GHz and 2.4 GHz Wi-Fi; Wi-Fi off and on recovering within 2 seconds with the same player number.
- Four phones at once, each with its own layout.
- Stock Moonlight on an Android device pairing through "Add a device with a code".

**App**
- Cold-start time and idle CPU of the packaged app on the Windows PC and on the Mac.
- The packaged build starting at all with the 0.5 changes (everything so far ran from source and under test).
