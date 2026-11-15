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
  export type Api = import('../contracts.js').LanPlayPreloadApi;
}

namespace LP.Model {
  /** Mirror of BITRATE_LIMITS_MBPS (src/contracts.ts). */
  export const BITRATE = { min: 20, max: 150, advancedMax: 500, step: 5 } as const;

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
    if (h.agentReachable === false) return { dot: 'warn', label: 'Needs pairing (LanPlay not found on that PC)' };
    return { dot: 'warn', label: 'Needs pairing' };
  }

  export const HINTS = {
    preset: 'Quick starting points. Change anything below and this becomes Custom.',
    resolution: 'Higher looks sharper but needs a faster network and PC.',
    fps: '120 feels smoother if your screen and PC can keep up.',
    bitrate: 'More Mbps means a cleaner picture. 50 to 100 suits most home networks.',
    audio: 'Stereo only for now.',
    host: 'Computers on your network running LanPlay or Sunshine.',
    manual: 'Not listed? Type the IP address of the PC, for example 192.168.1.20.',
  } as const;

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
    confirming: 'Confirming...',
    verifying: 'Making sure it worked...',
    done: 'Paired.',
  };
  export function pairPhaseText(p: T.PairProgress): string {
    return PHASES[p.phase] ?? p.message;
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
      case 'no-host': return 'No PC found yet. Check that LanPlay is running on it, or type its IP address below.';
      case 'ready': return hostName ? 'Ready to play on ' + hostName + '.' : 'Pick a PC.';
      case 'pairing': return 'Pairing with ' + (hostName ?? 'the PC') + '...';
      case 'streaming': return 'Streaming from ' + (hostName ?? 'the PC') + '.';
      case 'error': return 'Something went wrong.';
    }
  }

  /** Same-LAN IPv4 literal or a plain hostname; rejects anything with URL/path characters. */
  export function validAddress(raw: string): string | null {
    const s = raw.trim();
    if (s.length === 0 || s.length > 253) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split('.').every((p) => Number(p) <= 255) ? s : null;
    if (/^[0-9a-fA-F:]+$/.test(s) && s.includes(':')) return s;
    if (/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s)) return s;
    return null;
  }

  export interface SunshineSummary { installed: boolean | null; running: boolean | null }

  /** Installed = locate found it; running = the last run says service and web UI steps passed. */
  export function sunshineSummary(st: T.HostSetupStatus | null): SunshineSummary {
    if (!st) return { installed: null, running: null };
    const byId = (id: string): T.StepRecord | undefined => st.steps.find((s) => s.stepId === id);
    const svc = byId('service');
    const web = byId('web-ui');
    const installed = st.install !== null;
    const running = svc || web ? svc?.status === 'pass' && web?.status !== 'fail' : st.lastRunAt === null ? null : false;
    return { installed, running: running ?? null };
  }

  export function statusWord(s: T.StepRecord['status']): string {
    return s === 'pass' ? 'Pass' : s === 'fail' ? 'Fail' : s === 'warn' ? 'Warning' : 'Skipped';
  }

  export function deviceVia(d: T.PairedDevice): string {
    return d.pairedVia === 'lanplay' ? 'paired with LanPlay' : d.pairedVia === 'other' ? 'paired in Sunshine' : 'paired';
  }
}
