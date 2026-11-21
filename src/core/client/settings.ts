// Stream settings: chip detection, codec Auto rule, presets and validation/clamping.
import { BITRATE_LIMITS_MBPS, DEFAULT_STREAM_SETTINGS, PRESETS, SCM, SUNSHINE } from '../../contracts.js';
import type { AppleChipInfo, CodecChoice, DetectAppleChip, DisplayMode, FpsOption, Preset, PresetId, ResolutionId, ResolveCodec, StreamSettings } from '../../contracts.js';

/** os.cpus()[0].model -> chip. "Apple M4" -> 4, "Apple M1 Max" -> 1, "Intel(R) Core(TM) i7" -> null. */
export const detectAppleChip: DetectAppleChip = (cpuModel) => {
  const model = String(cpuModel ?? '').trim();
  const m = /^Apple M(\d{1,2})\b/i.exec(model);
  const generation = m ? Number(m[1]) : null;
  return { model, generation, av1HardwareDecode: generation !== null && generation >= 3 };
};

/**
 * Codec Auto: AV1 only on Apple M3+ AND when the host advertises AV1; else HEVC when advertised (or unknown); else H.264.
 * Bits: https://github.com/moonlight-stream/moonlight-common-c/blob/f900dd4767759c7b9d0e93bcea666b55c69ea62f/src/Limelight.h#L506-L520
 */
export const resolveCodec: ResolveCodec = (choice, chip, scms) => {
  if (choice !== 'auto') return choice;
  if (scms === undefined) return 'hevc';
  if (chip.av1HardwareDecode && (scms & SCM.MASK_AV1) !== 0) return 'av1';
  if ((scms & SCM.MASK_HEVC) !== 0) return 'hevc';
  return 'h264';
};

const RESOLUTIONS: readonly ResolutionId[] = ['1080p', '1440p', '4k'];
const FPS: readonly FpsOption[] = [60, 120];
const CODECS: readonly CodecChoice[] = ['auto', 'hevc', 'av1', 'h264'];
const MODES: readonly DisplayMode[] = ['fullscreen', 'borderless', 'windowed'];
const PRESET_IDS: readonly PresetId[] = ['lowest-latency', 'balanced', 'best-picture', 'internet', 'custom'];

export function clampBitrate(v: unknown, advanced: boolean): number {
  const n = typeof v === 'number' ? v : Number(v);
  const max = advanced ? BITRATE_LIMITS_MBPS.advancedMax : BITRATE_LIMITS_MBPS.max;
  if (!Number.isFinite(n)) return Math.min(DEFAULT_STREAM_SETTINGS.bitrateMbps, max);
  return Math.min(max, Math.max(BITRATE_LIMITS_MBPS.min, Math.round(n)));
}

/** Sunshine app names are passed to Moonlight as a positional argument: never let one look like an option. */
export function sanitizeAppName(v: unknown): string {
  if (typeof v !== 'string') return SUNSHINE.defaultAppName;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s || s.length > 100 || s.startsWith('-')) return SUNSHINE.defaultAppName;
  return s;
}

function pick<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Which preset (if any) these settings equal exactly. */
export function matchingPreset(s: Omit<StreamSettings, 'presetId'>): Preset['id'] | null {
  for (const p of PRESETS) {
    const ps = p.settings;
    if (
      ps.resolution === s.resolution &&
      ps.fps === s.fps &&
      ps.bitrateMbps === s.bitrateMbps &&
      ps.codec === s.codec &&
      ps.displayMode === s.displayMode &&
      ps.vsync === s.vsync &&
      ps.framePacing === s.framePacing
    )
      return p.id;
  }
  return null;
}

/** Validate + clamp untrusted settings (from the renderer or a settings file). Never throws on shape; throws on non-object. */
export function normalizeStreamSettings(input: unknown): StreamSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be an object');
  const i = input as Record<string, unknown>;
  const d = DEFAULT_STREAM_SETTINGS;
  const advancedBitrate = i.advancedBitrate === true;
  const base: Omit<StreamSettings, 'presetId'> = {
    resolution: pick(i.resolution, RESOLUTIONS, d.resolution),
    fps: pick(typeof i.fps === 'string' ? Number(i.fps) : i.fps, FPS, d.fps),
    bitrateMbps: clampBitrate(i.bitrateMbps, advancedBitrate),
    advancedBitrate,
    codec: pick(i.codec, CODECS, d.codec),
    audio: 'stereo',
    displayMode: pick(i.displayMode, MODES, d.displayMode),
    vsync: typeof i.vsync === 'boolean' ? i.vsync : d.vsync,
    framePacing: typeof i.framePacing === 'boolean' ? i.framePacing : d.framePacing,
    appName: sanitizeAppName(i.appName),
  };
  const requested = pick(i.presetId, PRESET_IDS, 'custom');
  // A named preset is kept only while the values still equal it; any manual change means 'custom'.
  const presetId: PresetId = requested !== 'custom' && matchingPreset(base) === requested ? requested : (matchingPreset(base) ?? 'custom');
  return { presetId, ...base };
}

export function applyPreset(id: Preset['id'], current: StreamSettings): StreamSettings {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return current;
  return normalizeStreamSettings({ ...current, ...p.settings, presetId: id, advancedBitrate: current.advancedBitrate });
}

export type { AppleChipInfo };
