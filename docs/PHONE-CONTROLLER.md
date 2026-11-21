# Phone controllers

A phone opens a web page served by the LanPlay **host** PC and becomes an Xbox 360 controller on that PC (up to 4 phones).
No app is installed on the phone. The virtual controller lives on the host, so it works in any game, including through a
LanPlay/Moonlight stream, and needs no controller on the viewer PC.

Phone controllers are **home network only** (plain HTTP, private addresses only). They are not available over the internet
in 0.5: port 47921 is never forwarded, and the internet switch does not touch it. A friend playing over the internet uses a
gamepad or keyboard on their own computer; Moonlight forwards it (`docs/ONLINE.md`).

## Use
1. On the host PC open LanPlay, find **Phone controllers**, switch it on. The first time press **Install driver**
   (one Windows permission prompt): it installs the ViGEmBus virtual-controller driver and opens TCP port 47921 for
   your home network only.
2. Open the shown link on each phone (same Wi-Fi) or scan the QR code. Rotate the phone to landscape.
3. Tap the gear on the phone to customize. Drag a control to move it, tap it for **Size** and **Opacity**; **More** opens
   everything else: label, which button it sends, shape and size, hold / toggle / rapid fire, trigger strength (LT, RT), and
   for sticks side, fixed or floating, dead zone, sensitivity, response curve, invert and double-tap click, for the d-pad
   diagonals. **Duplicate** and **Delete** are in More too. With nothing selected the card has the three layout slots,
   **Add** (button, stick, d-pad), stick sensitivity and haptics. Layouts are saved on the host PC per **phone id**: the
   page makes a random id once, keeps it in the phone's browser storage and sends it when it connects. The file is
   `controller-layouts/p-<hash of the id>.json` under LanPlay's per-user data folder. A phone keeps its layouts when the router
   gives it a new IP, and two phones on one IP keep separate layouts. A layout file made by an older version under the phone's
   IP is adopted by the phone the first time it connects with an id. Clearing the browser's site data on the phone makes a new
   id, so the layouts start from the default again. At most 64 phones keep layouts; saving for a new phone drops the one saved longest ago.
4. The link is `http://<host address>:47921/?t=<token>`. The token is **persistent**: it is made once, kept in the host's
   settings and does not change at each start, so a saved link or home-screen shortcut keeps working. Anyone who has the link
   (a shared QR screenshot, for example) can use it on your network until you press **New link** on the host, which
   invalidates old links and QR codes (a page added to the home screen must be added again).

## Player slot and reconnecting
- The host gives each phone a player number 1 to 4 and shows it for 1.5 seconds on connect ("Player 2").
- If the phone's connection drops (Wi-Fi off, phone asleep), the host holds the virtual pad at neutral for **15 seconds** and
  keeps the slot. The same phone (same id) reconnecting inside that time gets the same player number and the same pad, so
  the game does not see a controller unplug. After 15 seconds the pad is removed and the slot is free.
- A phone that opens the page a second time (another tab) takes the slot over; the older tab is closed.
- A phone page from an older version that sends no id works, but its pad is removed the moment the connection closes.
- The page pings the host once a second and measures the round trip. The settings card shows **Link: N ms**; a reply
  missing for 2 seconds counts as a dead link and the page reconnects at once. Expect a few milliseconds on 5 GHz Wi-Fi (not
  measured on real phones yet).

## On an Android phone (Chrome)
1. Open the link in Chrome on the same Wi-Fi.
2. The first tap on the page asks for full screen (no address bar), then locks the screen to landscape, then asks for a screen
   wake lock. Each of these is optional: if Chrome refuses one over plain HTTP, the page plays without it. If you leave full
   screen, **Full screen** in the settings card (More) goes back.
3. **Stay awake** in the card (More) says what is in use: a wake lock, or a muted video that keeps the screen on where the
   Wake Lock API is missing (it needs a secure context, which plain HTTP is not), or "Not available: set Auto-Lock to Never".
   The video fallback costs some battery.
4. **Haptics** has Off, Light (10 ms per press) and Strong (25 ms per press); the sticks use a pulse train that grows with the
   pull. Off is stored with the layout on the host; Light and Strong are kept on the phone.
5. Home screen: Chrome's install prompt needs HTTPS and will not appear for a LAN address. The card says "Chrome menu, then Add
   to Home screen". The saved shortcut opens the page with its token and connects. Whether it opens without browser bars over
   plain HTTP is not verified; the full screen tap covers it either way.
6. The Back gesture does not leave the page by accident; to leave, close the tab.
Samsung Internet and Firefox: best effort.

## On an iPhone
- **Add to Home Screen** (Share button, Add to Home Screen, Add) opens the controller full screen with no address bar. The
  page offers this once after it connects, and always from the gear card. Do it in portrait or from the address-bar menu: in
  landscape Safari may hide its toolbar.
- **Vibration**: iOS Safari has no Vibration API. The only haptic a web page can get is the system tick of a real switch
  that the finger touches, so each button and the d-pad carries an invisible one. You get one tick per tap, no stick ramp,
  and the tick may come when you lift the finger. Open the page with `&diag=1` added to the link for a test switch that
  shows whether the click arrived and how long after the touch. This is not verified on a real iPhone yet.

## How it works
- `src/core/controller/server.ts`: HTTP + WebSocket on port 47921. Serves the page files from memory (text gzip-compressed once),
  the layout API (`/api/layouts`, `/api/default-layout`) and the input socket (`/ws`).
- `protocol.ts`: wire format (hello with the phone id, state, keepalive, ping and pong); every frame from a phone is clamped into
  XInput ranges or dropped.
- `manager.ts`: player slots 1..4, one virtual pad each, neutral input when a phone goes quiet (2.5 s), removal after 20 s of
  silence; a closed socket of a phone with an id keeps the slot and the pad for 15 s, a socket without an id is removed at once.
- `layout.ts` / `layout-store.ts`: layout schema, limits and storage (per phone id, with the old per-IP file as a fallback);
  everything stored is sanitized.
- `vigem.ts`: ViGEmBus through `ViGEmClient.dll` called with `koffi`.
- `setup.ts` + `scripts/windows/setup-controllers.ps1`: the elevated one-time driver and firewall step.

## Safety
- Only private (home network) addresses are served; the Host header must be an IP address (checked with `net.isIP`, so a DNS name
  such as `dead.be` is refused with 421); cross-site browser requests are refused.
- The API and the socket need the access token that is only shown on the host screen (link / QR). The token is persistent, kept
  in plain text in the host's `settings.json` and travels in the link over plain HTTP, so treat the link like a password on your
  home network; **New link** replaces it. It is not a per-session token.
- Input is rate limited, size limited and sanitized; a disconnected or silent phone releases its virtual buttons.
- ViGEmBus is end-of-life upstream (2023) but is still the standard Windows virtual-gamepad driver; it is pinned by SHA-256
  like the other third-party files.

## Not verified on real Windows yet
The virtual pad creation (ViGEmBus/koffi), the driver and firewall install step, the sticky slot with a real ViGEmBus pad (a
short disconnect not showing as an unplug in a game), and the phone page on real phones (the iPhone haptic overlays, Add to Home
Screen and typing a label with the on-screen keyboard in particular; on Android, full screen, landscape lock, wake lock or its video
fallback, the three haptic strengths, the home-screen shortcut, and the Link readout on 5 GHz and 2.4 GHz). Test with a gamepad
tester page on the host while a phone is connected. The checklist is in `docs/WINDOWS-TEST.md`, section G.
