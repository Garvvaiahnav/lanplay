import { describe, expect, it } from 'vitest';
import { DEFAULT_STREAM_SETTINGS, PRESETS, SCM } from '../../src/contracts.js';
import type { StreamSettings } from '../../src/contracts.js';
import { buildListArgs, buildPairArgs, buildStreamArgs, moonlightCandidates } from '../../src/core/client/moonlight.js';
import { parseServerInfo } from '../../src/core/client/serverinfo.js';
import { applyPreset, clampBitrate, detectAppleChip, matchingPreset, normalizeStreamSettings, resolveCodec, sanitizeAppName } from '../../src/core/client/settings.js';
import { generatePin } from '../../src/core/client/pairing.js';

describe('detectAppleChip', () => {
  it.each([
    ['Apple M4', 4, true],
    ['Apple M4 Pro', 4, true],
    ['Apple M3 Max', 3, true],
    ['Apple M2 Ultra', 2, false],
    ['Apple M1', 1, false],
    ['Apple M10', 10, true],
    ['Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz', null, false],
    ['', null, false],
  ])('%s -> gen %s', (model, gen, av1) => {
    expect(detectAppleChip(model)).toEqual({ model, generation: gen, av1HardwareDecode: av1 });
  });
});

describe('resolveCodec (Auto rule)', () => {
  const m4 = detectAppleChip('Apple M4');
  const m1 = detectAppleChip('Apple M1');
  const all = SCM.H264 | SCM.HEVC | SCM.AV1_MAIN8;
  it('explicit choice wins', () => {
    expect(resolveCodec('h264', m4, all)).toBe('h264');
    expect(resolveCodec('av1', m1, SCM.H264)).toBe('av1');
  });
  it('AV1 only on M3+ AND when the host advertises it', () => {
    expect(resolveCodec('auto', m4, all)).toBe('av1');
    expect(resolveCodec('auto', m4, SCM.H264 | SCM.HEVC)).toBe('hevc');
    expect(resolveCodec('auto', m1, all)).toBe('hevc');
  });
  it('HEVC when unknown; H.264 when HEVC is not offered', () => {
    expect(resolveCodec('auto', m4, undefined)).toBe('hevc');
    expect(resolveCodec('auto', m4, SCM.H264)).toBe('h264');
    expect(resolveCodec('auto', m1, 0)).toBe('h264');
  });
});

describe('settings validation', () => {
  it('clamps bitrate 20..150, advanced up to 500', () => {
    expect(clampBitrate(5, false)).toBe(20);
    expect(clampBitrate(200, false)).toBe(150);
    expect(clampBitrate(200, true)).toBe(200);
    expect(clampBitrate(900, true)).toBe(500);
    expect(clampBitrate('abc', false)).toBe(80);
    expect(clampBitrate(77.6, false)).toBe(78);
  });

  it('rejects junk values and keeps defaults', () => {
    const s = normalizeStreamSettings({ resolution: '8k', fps: 144, codec: 'vp9', displayMode: 'x', vsync: 'yes', appName: '--evil', audio: '7.1-surround', bitrateMbps: 1e9 });
    expect(s).toMatchObject({ resolution: '1440p', fps: 120, codec: 'auto', displayMode: 'fullscreen', vsync: false, appName: 'Desktop', audio: 'stereo', bitrateMbps: 150 });
    expect(() => normalizeStreamSettings(null)).toThrow();
    expect(() => normalizeStreamSettings('x')).toThrow();
    expect(sanitizeAppName('Steam Big Picture')).toBe('Steam Big Picture');
    expect(sanitizeAppName('a\u0000b')).toBe('ab');
  });

  it('keeps preset ids only while the values match; manual change -> custom', () => {
    for (const p of PRESETS) {
      const s = applyPreset(p.id, DEFAULT_STREAM_SETTINGS);
      expect(s.presetId).toBe(p.id);
      expect(matchingPreset(s)).toBe(p.id);
    }
    const changed = normalizeStreamSettings({ ...applyPreset('balanced', DEFAULT_STREAM_SETTINGS), bitrateMbps: 85 });
    expect(changed.presetId).toBe('custom');
    expect(normalizeStreamSettings(DEFAULT_STREAM_SETTINGS).presetId).toBe('balanced');
  });
});

describe('Moonlight argv', () => {
  const settings: StreamSettings = { ...DEFAULT_STREAM_SETTINGS, resolution: '4k', fps: 60, bitrateMbps: 150, vsync: true, framePacing: true, displayMode: 'borderless' };
  it('builds stream argv in the documented order', () => {
    expect(buildStreamArgs({ host: '192.168.1.10', settings, resolvedCodec: 'hevc' })).toEqual([
      'stream', '192.168.1.10', 'Desktop', '--4K', '--fps', '60', '--bitrate', '150000', '--video-codec', 'HEVC',
      '--audio-config', 'stereo', '--display-mode', 'borderless', '--vsync', '--frame-pacing',
      '--capture-system-keys', 'always',
    ]);
    const low = buildStreamArgs({ host: 'fe80::1', settings: { ...settings, resolution: '1080p', fps: 120, bitrateMbps: 20, vsync: false, framePacing: false }, resolvedCodec: 'h264' });
    expect(low).toContain('--1080');
    expect(low).toContain('H.264');
    expect(low).toContain('--no-vsync');
    expect(low).toContain('--no-frame-pacing');
    expect(low[low.indexOf('--bitrate') + 1]).toBe('20000');
    expect(buildStreamArgs({ host: '10.0.0.2', settings: { ...settings, resolution: '1440p' }, resolvedCodec: 'av1' })).toEqual(expect.arrayContaining(['--1440', 'AV1']));
  });

  it('always captures system keys (Windows key, Alt+Tab) for every display mode', () => {
    for (const displayMode of ['fullscreen', 'borderless', 'windowed'] as const) {
      const argv = buildStreamArgs({ host: '10.0.0.2', settings: { ...settings, displayMode }, resolvedCodec: 'hevc' });
      expect(argv[argv.indexOf('--capture-system-keys') + 1]).toBe('always');
    }
  });

  it('refuses option-like hosts and app names, out-of-range values', () => {
    expect(() => buildStreamArgs({ host: '--help', settings, resolvedCodec: 'hevc' })).toThrow();
    expect(() => buildStreamArgs({ host: 'gaming-pc.local', settings, resolvedCodec: 'hevc' })).toThrow();
    expect(() => buildStreamArgs({ host: '10.0.0.2', settings: { ...settings, appName: '-x' }, resolvedCodec: 'hevc' })).toThrow();
    expect(() => buildStreamArgs({ host: '10.0.0.2', settings: { ...settings, bitrateMbps: 600 }, resolvedCodec: 'hevc' })).toThrow();
  });

  it('builds pair/list argv', () => {
    expect(buildPairArgs('192.168.1.10', '0042')).toEqual(['pair', '192.168.1.10', '--pin', '0042']);
    expect(() => buildPairArgs('192.168.1.10', '42')).toThrow();
    expect(buildListArgs('192.168.1.10')).toEqual(['list', '192.168.1.10']);
    expect(moonlightCandidates('/App/Contents/Resources/vendor', null)).toEqual(['/App/Contents/Resources/vendor/Moonlight.app/Contents/MacOS/Moonlight', '/Applications/Moonlight.app/Contents/MacOS/Moonlight']);
  });

  it('PINs are 4 digits, zero padded', () => {
    for (let i = 0; i < 200; i++) expect(generatePin()).toMatch(/^\d{4}$/);
  });
});

describe('serverinfo XML', () => {
  it('parses Sunshine serverinfo', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><root status_code="200"><hostname>Gaming &amp; PC</hostname><appversion>7.1.431.-1</appversion><uniqueid>ABCDEF0123</uniqueid><HttpsPort>47984</HttpsPort><ExternalPort>47989</ExternalPort><ServerCodecModeSupport>65793</ServerCodecModeSupport><state>SUNSHINE_SERVER_FREE</state></root>`;
    expect(parseServerInfo(xml)).toEqual({ hostname: 'Gaming & PC', uniqueId: 'ABCDEF0123', httpsPort: 47984, serverCodecModeSupport: 65793, appVersion: '7.1.431.-1', state: 'SUNSHINE_SERVER_FREE' });
    expect(() => parseServerInfo('<html>')).toThrow();
    expect(() => parseServerInfo('<root status_code="401"><uniqueid>x</uniqueid></root>')).toThrow();
    expect(() => parseServerInfo('<root status_code="200"></root>')).toThrow();
  });
});
