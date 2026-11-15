# Phone controllers

A phone opens a web page served by the LanPlay **host** PC and becomes an Xbox 360 controller on that PC (up to 4 phones).
No app is installed on the phone. The virtual controller lives on the host, so it works in any game, including through a
LanPlay/Moonlight stream, and needs no controller on the viewer PC.

## Use
1. On the host PC open LanPlay, find **Phone controllers**, switch it on. The first time press **Install driver**
   (one Windows permission prompt): it installs the ViGEmBus virtual-controller driver and opens TCP port 47921 for
   your home network only.
2. Open the shown link on each phone (same Wi-Fi) or scan the QR code. Rotate the phone to landscape.
3. Tap **Edit** on the phone to customize: move and resize every control, add or remove controls, sensitivity, dead zone,
   response curve, invert, turbo, latch, trigger value, vibration, and save presets. Layouts are saved on the host PC per
   phone IP (`controller-layouts/<ip>.json` under LanPlay's per-user data folder), so they are there next time the same
   phone connects. If your router gives the phone a new IP, it starts from the default layout again.
4. **New link** on the host invalidates old links and QR codes.

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
The virtual pad creation (ViGEmBus/koffi), the driver and firewall install step, and the phone page on real phones. Test with
a gamepad tester page on the host while a phone is connected.
