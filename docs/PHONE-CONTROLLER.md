# Phone controllers

A phone opens a web page served by the LanPlay **host** PC and becomes an Xbox 360 controller on that PC (up to 4 phones).
No app is installed on the phone. The virtual controller lives on the host, so it works in any game, including through a
LanPlay/Moonlight stream, and needs no controller on the viewer PC.

## Use
1. On the host PC open LanPlay, find **Phone controllers**, switch it on. The first time press **Install driver**
   (one Windows permission prompt): it installs the ViGEmBus virtual-controller driver and opens TCP port 47921 for
   your home network only.
2. Open the shown link on each phone (same Wi-Fi) or scan the QR code. Rotate the phone to landscape.
3. Tap the gear on the phone to customize. Drag a control to move it, tap it for **Size** and **Opacity**; **More** opens
   everything else: label, which button it sends, shape and size, hold / toggle / rapid fire, trigger strength (LT, RT), and
   for sticks side, fixed or floating, dead zone, sensitivity, response curve, invert and double-tap click, for the d-pad
   diagonals. **Duplicate** and **Delete** are in More too. With nothing selected the card has the three layout slots,
   **Add** (button, stick, d-pad), stick sensitivity and vibration. Layouts are saved on the host PC per
   phone IP (`controller-layouts/<ip>.json` under LanPlay's per-user data folder), so they are there next time the same
   phone connects. If your router gives the phone a new IP, it starts from the default layout again.
4. **New link** on the host invalidates old links and QR codes (a page added to the home screen must be added again).

## On an iPhone
- **Add to Home Screen** (Share button, Add to Home Screen, Add) opens the controller full screen with no address bar. The
  page offers this once after it connects, and always from the gear card. Do it in portrait or from the address-bar menu: in
  landscape Safari may hide its toolbar.
- **Vibration**: iOS Safari has no Vibration API. The only haptic a web page can get is the system tick of a real switch
  that the finger touches, so each button and the d-pad carries an invisible one. You get one tick per tap, no stick ramp,
  and the tick may come when you lift the finger. Open the page with `&diag=1` added to the link for a test switch that
  shows whether the click arrived and how long after the touch. This is not verified on a real iPhone yet.

## How it works
- `src/core/controller/server.ts`: HTTP + WebSocket on port 47921. Serves the page, the layout API (`/api/layouts`,
  `/api/default-layout`) and the input socket (`/ws`).
- `protocol.ts`: wire format; every frame from a phone is clamped into XInput ranges or dropped.
- `manager.ts`: player slots 1..4, one virtual pad each, neutral input when a phone goes quiet (2.5 s) or disconnects, removal
  after 20 s of silence.
- `layout.ts` / `layout-store.ts`: layout schema, limits and per-IP storage; everything stored is sanitized.
- `vigem.ts`: ViGEmBus through `ViGEmClient.dll` called with `koffi`.
- `setup.ts` + `scripts/windows/setup-controllers.ps1`: the elevated one-time driver and firewall step.

## Safety
- Only private (home network) addresses are served; the Host header must be an IP address; cross-site browser requests are refused.
- The API and the socket need the session token that is only shown on the host screen (link / QR).
- Input is rate limited, size limited and sanitized; a disconnected or silent phone releases its virtual buttons.
- ViGEmBus is end-of-life upstream (2023) but is still the standard Windows virtual-gamepad driver; it is pinned by SHA-256
  like the other third-party files.

## Not verified on real Windows yet
The virtual pad creation (ViGEmBus/koffi), the driver and firewall install step, and the phone page on real phones (the iPhone
haptic overlays, Add to Home Screen and typing a label with the on-screen keyboard in particular). Test with
a gamepad tester page on the host while a phone is connected.
