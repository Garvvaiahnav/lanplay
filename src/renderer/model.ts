/* Pure UI logic: no DOM, no IPC. Mirrors the few runtime constants from src/contracts.ts because the renderer is a
 * sandboxed classic script and cannot import the contracts module at runtime. tests/ui/model.test.ts asserts the
 * mirrors equal the contracts, so drift fails the build. */
namespace LP.T {
  export type StreamSettings = import('../contracts.js').StreamSettings;
  export type PresetId = import('../contracts.js').PresetId;
  export type ResolutionId = import('../contracts.js').ResolutionId;
  export type CodecChoice = import('../contracts.js').CodecChoice;
  export type FpsOption = import('../contracts.js').FpsOption;
  export type HostInfo = import('../contracts.js').HostInfo;
  export type PairResult = import('../contracts.js').PairResult;
  export type PairProgress = import('../contracts.js').PairProgress;
  export type StreamState = import('../contracts.js').StreamState;
  export type AppleChipInfo = import('../contracts.js').AppleChipInfo;
  export type StepRecord = import('../contracts.js').StepRecord;
  export type HostSetupStatus = import('../contracts.js').HostSetupStatus;
  export type AgentState = import('../contracts.js').AgentState;
  export type PairedDevice = import('../contracts.js').PairedDevice;
  export type ControllersState = import('../contracts.js').ControllersState;
  export type SelfCheckReport = import('../contracts.js').SelfCheckReport;
  export type AppInfo = import('../contracts.js').AppInfo;
  export type InternetHostState = import('../contracts.js').InternetHostState;
  export type PendingCodePairing = import('../contracts.js').PendingCodePairing;
  export type CodePairResult = import('../contracts.js').CodePairResult;
  export type SettingsPane = import('../contracts.js').SettingsPane;
  export type Api = import('../contracts.js').LanPlayPreloadApi;
}

namespace LP.Model {
  /** Mirror of BITRATE_LIMITS_MBPS (src/contracts.ts). */
  export const BITRATE = { min: 5, max: 150, advancedMax: 500, step: 5 } as const;

  export interface PresetView {
    id: Exclude<T.PresetId, 'custom'>;
    label: string;
    description: string;
    settings: { resolution: T.ResolutionId; fps: T.FpsOption; bitrateMbps: number; codec: T.CodecChoice; displayMode: 'fullscreen' | 'borderless' | 'windowed'; vsync: boolean; framePacing: boolean };
  }

  /** Mirror of PRESETS (src/contracts.ts). */
  export const PRESETS: readonly PresetView[] = [
    { id: 'lowest-latency', label: 'Lowest latency', description: '1080p at 120 fps, no V-Sync, no frame pacing.', settings: { resolution: '1080p', fps: 120, bitrateMbps: 50, codec: 'auto', displayMode: 'fullscreen', vsync: false, framePacing: false } },
    { id: 'balanced', label: 'Balanced', description: '1440p at 120 fps with frame pacing.', settings: { resolution: '1440p', fps: 120, bitrateMbps: 80, codec: 'auto', displayMode: 'fullscreen', vsync: false, framePacing: true } },
    { id: 'best-picture', label: 'Best picture', description: '4K at 60 fps, high bitrate, V-Sync on.', settings: { resolution: '4k', fps: 60, bitrateMbps: 150, codec: 'auto', displayMode: 'fullscreen', vsync: true, framePacing: true } },
    { id: 'internet', label: 'Internet', description: '1080p at 60 fps, 15 Mbps.', settings: { resolution: '1080p', fps: 60, bitrateMbps: 15, codec: 'auto', displayMode: 'fullscreen', vsync: false, framePacing: true } },
  ];

  export const RESOLUTIONS: ReadonlyArray<{ value: T.ResolutionId; label: string }> = [
    { value: '1080p', label: '1080p' },
    { value: '1440p', label: '1440p' },
    { value: '4k', label: '4K' },
  ];
  export const FPS: ReadonlyArray<{ value: T.FpsOption; label: string }> = [
    { value: 60, label: '60' },
    { value: 120, label: '120' },
  ];
  export const CODECS: ReadonlyArray<{ value: T.CodecChoice; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'hevc', label: 'HEVC' },
    { value: 'av1', label: 'AV1' },
    { value: 'h264', label: 'H.264' },
  ];

  export function clampBitrate(mbps: number, advanced: boolean): number {
    const max = advanced ? BITRATE.advancedMax : BITRATE.max;
    const n = Number.isFinite(mbps) ? Math.round(mbps / BITRATE.step) * BITRATE.step : BITRATE.min;
    return Math.min(max, Math.max(BITRATE.min, n));
  }

  /** Which preset (if any) exactly matches these settings. */
  export function matchPreset(s: T.StreamSettings): T.PresetId {
    for (const p of PRESETS) {
      const q = p.settings;
      if (q.resolution === s.resolution && q.fps === s.fps && q.bitrateMbps === s.bitrateMbps && q.codec === s.codec && q.displayMode === s.displayMode && q.vsync === s.vsync && q.framePacing === s.framePacing) return p.id;
    }
    return 'custom';
  }

  export function applyPreset(s: T.StreamSettings, id: Exclude<T.PresetId, 'custom'>): T.StreamSettings {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return s;
    return { ...s, ...p.settings, presetId: p.id, advancedBitrate: false };
  }

  /** Apply a manual change: clamps the bitrate and flips the preset to "custom" (or back to a preset if it matches). */
  export function change(s: T.StreamSettings, patch: Partial<T.StreamSettings>): T.StreamSettings {
    const merged: T.StreamSettings = { ...s, ...patch };
    if (patch.advancedBitrate !== undefined || patch.bitrateMbps !== undefined) {
      merged.bitrateMbps = clampBitrate(merged.bitrateMbps, merged.advancedBitrate);
    }
    // A bitrate above the normal range needs the advanced switch.
    if (merged.bitrateMbps > BITRATE.max && !merged.advancedBitrate) merged.bitrateMbps = BITRATE.max;
    merged.presetId = matchPreset(merged);
    return merged;
  }

  export type Dot = 'ok' | 'warn' | 'off';

  /** Status dot + words (never colour alone). */
  export function hostStatus(h: T.HostInfo): { dot: Dot; label: string } {
    if (h.paired === true) return { dot: 'ok', label: 'Ready' };
    // An internet host has no pair agent by design: the missing agent is not a problem to report.
    if (h.agentReachable === false && h.remote !== true) return { dot: 'warn', label: 'Needs pairing (LanPlay not found on that PC)' };
    return { dot: 'warn', label: 'Needs pairing' };
  }

  export const HINTS = {
    bitrate: '50 to 100 Mbps suits most home networks.',
  } as const;

  /** Fixed line under every internet host (plan 2.3). */
  export const REMOTE_WARNING = 'Internet host. Video and input go directly to this address. Only connect to people you know.';
  export const MANUAL_PLACEHOLDER = '203.0.113.7 or 192.168.1.20';

  export function codecHint(choice: T.CodecChoice, chip: T.AppleChipInfo | null): string {
    const av1 = chip?.av1HardwareDecode === true;
    switch (choice) {
      case 'auto':
        return av1 ? 'Auto picks AV1 on this Mac when the PC supports it, otherwise HEVC.' : 'Auto picks HEVC when the PC supports it, otherwise H.264.';
      case 'hevc':
        return 'HEVC: sharp and fast on almost every PC and Mac.';
      case 'av1':
        if (av1) return 'AV1: best quality per Mbps, needs a recent graphics card on the PC.';
        // Only Apple chips are detected; on a Windows client (or unknown CPU) AV1 support depends on its graphics card.
        return /^Apple /i.test(chip?.model ?? '') || !chip?.model
          ? 'AV1: this Mac has no AV1 hardware decoder, so it may stutter. Try Auto.'
          : 'AV1: needs AV1 hardware decoding on this computer\'s graphics card (no AV1 hardware decoder means it may stutter). Try Auto.';
      case 'h264':
        return 'H.264: works everywhere, needs more Mbps for the same quality.';
    }
  }

  export function bitrateText(mbps: number): string {
    return mbps + ' Mbps';
  }

  const PAIR_ERRORS: Record<string, string> = {
    'agent-unreachable': 'Could not reach LanPlay on the PC. Is it running there, on the same network?',
    'agent-forbidden': 'The PC refused this request. Both computers must be on the same home network.',
    'agent-rate-limited': 'Too many tries. Wait a minute and press Stream again.',
    'approval-denied': 'The PC said no to this pairing.',
    'approval-timeout': 'Nobody approved the pairing on the PC in time.',
    'no-pending-pairing': 'The PC did not see the pairing request. Try again.',
    'wrong-pin': 'The PC rejected the pairing code. Try again.',
    'sunshine-not-ready': 'Sunshine is not ready on the PC. Open LanPlay there and press Set up / Repair.',
    'sunshine-api-error': 'Sunshine on the PC returned an error. Run the self-check on the PC.',
    'moonlight-missing': 'Moonlight is missing from this app. Reinstall LanPlay.',
    'moonlight-failed': 'Moonlight stopped before pairing finished. Try again.',
    'verify-failed': 'Pairing looked fine but did not stick. Try again.',
    'code-timeout': 'The host did not enter the code in time. Press Stream to get a new code.',
    timeout: 'Pairing took too long. Try again.',
  };

  /** Codes where the PC's own explanation says what to do next (too-old Sunshine, which address was seen, ...). */
  const PAIR_DETAIL_CODES = ['no-pending-pairing', 'sunshine-not-ready', 'sunshine-api-error', 'moonlight-failed', 'verify-failed'];

  export function pairErrorMessage(r: Extract<T.PairResult, { ok: false }>): string {
    const friendly = PAIR_ERRORS[r.code];
    if (!friendly) return r.message;
    const detail = (r.message ?? '').trim();
    if (detail && detail !== friendly && PAIR_DETAIL_CODES.indexOf(r.code) >= 0) return friendly + ' Details: ' + (detail.length > 400 ? detail.slice(0, 400) + '...' : detail);
    return friendly;
  }

  const PHASES: Record<string, string> = {
    checking: 'Checking the PC...',
    'starting-moonlight': 'Starting Moonlight...',
    'contacting-agent': 'Asking the PC to accept...',
    'waiting-approval': 'Waiting for someone to approve on the PC...',
    'show-code': 'Waiting for the host to enter the code...',
    confirming: 'Confirming...',
    verifying: 'Making sure it worked...',
    done: 'Paired.',
  };
  export function pairPhaseText(p: T.PairProgress): string {
    if (p.phase === 'show-code' && p.code) return pairCodeParts(p.code).join('');
    return PHASES[p.phase] ?? p.message;
  }

  /** The 'show-code' status line in three pieces, so the screen can set the code itself in the larger size. */
  export function pairCodeParts(code: string): [string, string, string] {
    return ['Tell the host this code: ', code, '. Waiting for them to enter it (3 min)'];
  }

  export type ClientPhase = 'searching' | 'no-host' | 'ready' | 'pairing' | 'streaming' | 'error';

  export function clientPhase(i: { hostCount: number; searchTimedOut: boolean; pairing: boolean; stream: T.StreamState | null; hasError: boolean }): ClientPhase {
    if (i.stream && (i.stream.state === 'starting' || i.stream.state === 'running')) return 'streaming';
    if (i.pairing) return 'pairing';
    if (i.hasError) return 'error';
    if (i.hostCount === 0) return i.searchTimedOut ? 'no-host' : 'searching';
    return 'ready';
  }

  /** Moonlight's built-in shortcuts (moonlight-qt v6.2.0 app/streaming/input/input.cpp#L83-L91 SDLK_q quit / SDLK_z ungrab, keyboard.cpp#L199-L202 requires Ctrl+Alt+Shift). */
  export const STREAM_ESCAPE_HINT = 'To leave the stream: press Ctrl+Alt+Shift+Q. To get your mouse back: Ctrl+Alt+Shift+Z.';

  export function phaseMessage(phase: ClientPhase, hostName: string | null): string {
    switch (phase) {
      case 'searching': return 'Looking for your PC...';
      case 'no-host': return 'No PC found yet. Check that LanPlay is running on it, or use Connect by IP.';
      case 'ready': return hostName ? 'Ready to play on ' + hostName + '.' : 'Pick a PC.';
      case 'pairing': return 'Pairing with ' + (hostName ?? 'the PC') + '...';
      case 'streaming': return 'Streaming from ' + (hostName ?? 'the PC') + '.';
      case 'error': return 'Something went wrong.';
    }
  }

  function portOk(p: string): boolean {
    return /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
  }

  /** `IP`, `IP:port`, `[v6]`, `[v6]:port`, a bare IPv6 or a host name with an optional `:port`; rejects anything with URL/path characters. */
  export function validAddress(raw: string): string | null {
    const s = raw.trim();
    if (s.length === 0 || s.length > 253) return null;
    const v6 = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(s);
    if (v6) return v6[1]?.includes(':') && (v6[2] === undefined || portOk(v6[2])) ? s : null;
    if (/^[0-9a-fA-F:]+$/.test(s) && s.includes(':') && s.split(':').length > 2) return s;
    const m = /^([^:]+)(?::(\d*))?$/.exec(s);
    if (!m) return null;
    const host = m[1] ?? '';
    if (m[2] !== undefined && !portOk(m[2])) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every((p) => Number(p) <= 255) ? s : null;
    return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) ? s : null;
  }

  /** The text of a failed "Connect by IP": main's sentence as is; the address is prefixed only when the sentence does not name it. */
  export function manualFailure(address: string, message: string): string {
    const bracket = /^\[([^\]]+)\]/.exec(address);
    const bare = bracket ? bracket[1] ?? address : address.split(':').length === 2 ? address.split(':')[0] ?? address : address;
    return message.includes(bare) ? message : 'Could not reach ' + address + ': ' + message;
  }

  /** Ports of the internet card, in the order a router needs them. Mirrors SUNSHINE in src/contracts.ts (asserted in tests/ui/model.test.ts). */
  export const INTERNET_PORTS: ReadonlyArray<{ protocol: 'TCP' | 'UDP'; ports: string; use: string }> = [
    { protocol: 'TCP', ports: '47984', use: 'HTTPS (pairing, launch)' },
    { protocol: 'TCP', ports: '47989', use: 'HTTP (status, pairing start)' },
    { protocol: 'TCP', ports: '48010', use: 'RTSP' },
    { protocol: 'UDP', ports: '47998, 47999, 48000', use: 'video, control, audio' },
  ];
  /** Never forward these: admin web UI, pair agent, phone controllers. */
  export const INTERNET_NEVER_PORTS = '47990, 47920, 47921';

  /** Exposure text of plan 2.4, per platform (Sunshine runs as SYSTEM only on Windows). */
  export function exposureText(mac: boolean): string[] {
    const lines = [
      'This opens Sunshine to the whole internet. Anyone can start a pairing, but each one needs a code you type here.',
      'A bug in Sunshine could be reached by anyone' + (mac ? '.' : ', and on Windows Sunshine runs as SYSTEM.'),
      'A paired device has keyboard and mouse on ' + (mac ? 'this Mac' : 'this PC') + ' while it is on.',
    ];
    return lines;
  }

  export function validPin(s: string): boolean {
    return /^\d{4}$/.test(s);
  }

  export interface SunshineSummary { installed: boolean | null; running: boolean | null }

  /** Installed = locate found it; running = the last run says service and web UI steps passed. */
  export function sunshineSummary(st: T.HostSetupStatus | null): SunshineSummary {
    if (!st) return { installed: null, running: null };
    const byId = (id: string): T.StepRecord | undefined => st.steps.find((s) => s.stepId === id);
    // macOS has no Windows service: its Sunshine runs as a LaunchAgent.
    const svc = byId('service') ?? byId('mac-launch-agent');
    const web = byId('web-ui');
    const installed = st.install !== null;
    const running = svc || web ? svc?.status === 'pass' && web?.status !== 'fail' : st.lastRunAt === null ? null : false;
    return { installed, running: running ?? null };
  }

  /** Button text per System Settings pane. Main owns the deep links; the renderer only ever sends the pane name. */
  const PANE_LABELS: Record<T.SettingsPane, string> = {
    'screen-recording': 'Open Screen Recording settings',
    accessibility: 'Open Accessibility settings',
    microphone: 'Open Microphone settings',
    'local-network': 'Open Local Network settings',
    'login-items': 'Open Login Items settings',
    firewall: 'Open Firewall settings',
  };

  export interface StepAction { pane: T.SettingsPane | null; paneLabel: string; confirmInput: boolean; restartSunshine: boolean }

  /** What the user can do about a macOS step (StepRecord.data convention). A step that passed needs nothing. */
  export function stepAction(s: T.StepRecord): StepAction | null {
    if (s.status === 'pass') return null;
    const raw = s.data?.['settingsPane'];
    const pane = typeof raw === 'string' && Object.prototype.hasOwnProperty.call(PANE_LABELS, raw) ? (raw as T.SettingsPane) : null;
    const confirmInput = s.data?.['userAction'] === 'confirm-input';
    const restartSunshine = s.data?.['userAction'] === 'restart-sunshine';
    return pane || confirmInput || restartSunshine ? { pane, paneLabel: pane ? PANE_LABELS[pane] : '', confirmInput, restartSunshine } : null;
  }

  /** The screen keeps asking for status while a step is failing on a permission the user can grant in System Settings. */
  export function waitingForGrant(st: T.HostSetupStatus | null): boolean {
    return st?.steps.some((s) => s.status === 'fail' && stepAction(s)?.pane) ?? false;
  }

  export interface SunshineUpdate { installed: string; bundled: string }

  /** HostSetupStatus.sunshineUpdate (macOS): a newer bundled Sunshine than the running copy. Read defensively, it comes over IPC. */
  export function sunshineUpdate(st: T.HostSetupStatus | null): SunshineUpdate | null {
    const u = (st as { sunshineUpdate?: Partial<SunshineUpdate> } | null)?.sunshineUpdate;
    return u && typeof u.installed === 'string' && typeof u.bundled === 'string' ? { installed: u.installed, bundled: u.bundled } : null;
  }

  export function statusWord(s: T.StepRecord['status']): string {
    return s === 'pass' ? 'Pass' : s === 'fail' ? 'Fail' : s === 'warn' ? 'Warning' : 'Skipped';
  }

  export function deviceVia(d: T.PairedDevice): string {
    return d.pairedVia === 'lanplay' ? 'paired with LanPlay' : d.pairedVia === 'code' ? 'paired with a code' : d.pairedVia === 'other' ? 'paired in Sunshine' : 'paired';
  }
}
