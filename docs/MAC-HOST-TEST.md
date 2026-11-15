# Mac host: manual test checklist

The unit tests use fakes. This list is what only a real Mac (Apple Silicon, macOS 14 or newer) can show. Tick each item and
note the macOS version.

Verified by hand on one Mac (2026-11-16): setup runs and starts the bundled Sunshine under launchd, the pair agent is
registered, and switching to Client removes both LaunchAgents and stops Sunshine. Not yet verified: everything below that
needs a permission grant or a second device.

1. Open LanPlay, choose **Host** (Change role). Press **Set up this Mac**. Every step passes except Screen Recording and
   Accessibility, which ask you to act.
2. **Screen Recording:** press the button, switch Sunshine on, then choose "Quit & Reopen" if macOS offers it. Back in LanPlay
   the step turns green within a few seconds (or press **Restart Sunshine**). Note whether a second Sunshine ever appears.
3. **Accessibility:** press the button, add or enable Sunshine, then press **I did this**.
4. Pair from the viewer (another PC, or Moonlight on an iPhone) and stream the desktop: video, sound (allow the audio prompt),
   a mouse click and a typed key arrive on the Mac.
5. Log out and in: Sunshine and the pair agent are running again without opening LanPlay. Quit LanPlay: the stream continues.
6. Install a newer LanPlay over this one (auto-update): the stream survives, and a bundled Sunshine that differs from the
   installed copy shows the "Sunshine update ready" banner.
7. Switch to **Client**: `ls ~/Library/LaunchAgents | grep lanplay` prints nothing and no Sunshine process is left.
8. Turn the macOS firewall on once and repeat step 4.
