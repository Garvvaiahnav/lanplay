// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { BITRATE_LIMITS_MBPS, DEFAULT_STREAM_SETTINGS, PRESETS, type PairErrorCode, type StreamSettings } from '../../src/contracts.js';
import { loadRenderer, type LP } from './helpers.js';

let M: LP;
beforeAll(() => {
  M = loadRenderer().Model;
});
const base = (): StreamSettings => ({ ...DEFAULT_STREAM_SETTINGS });

describe('mirrors of contracts', () => {
  it('presets and bitrate limits equal src/contracts.ts', () => {
    expect(M.PRESETS).toEqual(PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description, settings: p.settings })));
    expect(M.BITRATE).toEqual(BITRATE_LIMITS_MBPS);
  });
});

describe('settings logic', () => {
  it('applyPreset copies the preset and keeps appName/audio', () => {
    const s = M.applyPreset({ ...base(), appName: 'Steam' }, 'lowest-latency');
    expect(s).toMatchObject({ presetId: 'lowest-latency', resolution: '1080p', fps: 120, bitrateMbps: 50, vsync: false, framePacing: false, appName: 'Steam', audio: 'stereo' });
  });
  it('a manual change flips to custom, and back when it matches a preset again', () => {
    const custom = M.change(base(), { fps: 60 });
    expect(custom.presetId).toBe('custom');
    expect(M.change(custom, { fps: 120 }).presetId).toBe('balanced');
  });
  it('clamps bitrate to steps and range, 500 only with advanced', () => {
    expect(M.clampBitrate(7, false)).toBe(20);
    expect(M.clampBitrate(83, false)).toBe(85);
    expect(M.clampBitrate(400, false)).toBe(150);
    expect(M.clampBitrate(400, true)).toBe(400);
    expect(M.clampBitrate(900, true)).toBe(500);
    expect(M.clampBitrate(Number.NaN, true)).toBe(20);
  });
  it('turning advanced off pulls a high bitrate back to 150', () => {
    const adv = M.change(base(), { advancedBitrate: true, bitrateMbps: 300 });
    expect(adv.bitrateMbps).toBe(300);
    expect(M.change(adv, { advancedBitrate: false }).bitrateMbps).toBe(150);
  });
});

describe('texts and states', () => {
  it('host dots always come with words', () => {
    expect(M.hostStatus({ paired: true })).toEqual({ dot: 'ok', label: 'Ready' });
    expect(M.hostStatus({ paired: false, agentReachable: true }).dot).toBe('warn');
    expect(M.hostStatus({ agentReachable: false }).label).toMatch(/not found/);
  });
  it('codec hints: AV1 warning only without hardware decode', () => {
    expect(M.codecHint('av1', { av1HardwareDecode: false })).toMatch(/no AV1 hardware/);
    expect(M.codecHint('av1', { av1HardwareDecode: true })).not.toMatch(/stutter/);
    expect(M.codecHint('auto', { av1HardwareDecode: true })).toMatch(/AV1/);
    expect(M.codecHint('auto', null)).toMatch(/HEVC/);
  });
  it('phase derivation', () => {
    const i = { hostCount: 0, searchTimedOut: false, pairing: false, stream: null, hasError: false };
    expect(M.clientPhase(i)).toBe('searching');
    expect(M.clientPhase({ ...i, searchTimedOut: true })).toBe('no-host');
    expect(M.clientPhase({ ...i, hostCount: 1 })).toBe('ready');
    expect(M.clientPhase({ ...i, hostCount: 1, hasError: true })).toBe('error');
    expect(M.clientPhase({ ...i, hostCount: 1, pairing: true, hasError: true })).toBe('pairing');
    expect(M.clientPhase({ ...i, hostCount: 1, stream: { hostId: 'x', state: 'running' } })).toBe('streaming');
    expect(M.clientPhase({ ...i, hostCount: 1, stream: { hostId: 'x', state: 'ended' } })).toBe('ready');
  });
  it('every pair error code has a friendly message', () => {
    const codes: PairErrorCode[] = ['agent-unreachable', 'agent-forbidden', 'agent-rate-limited', 'approval-denied', 'approval-timeout', 'no-pending-pairing', 'wrong-pin', 'sunshine-not-ready', 'sunshine-api-error', 'moonlight-missing', 'moonlight-failed', 'verify-failed', 'timeout'];
    for (const code of codes) {
      const text: string = M.pairErrorMessage({ ok: false, hostId: 'h', code, message: 'RAW', retryable: true, durationMs: 1 });
      expect(text).not.toBe('RAW');
      expect(text.length).toBeGreaterThan(10);
    }
  });
  it('pair errors keep the PC\'s own explanation when it says what to do (e.g. Sunshine too old), but never for codes where it adds nothing', () => {
    const tooOld = 'The Sunshine installed on the PC is too old for LanPlay. On the PC: Windows Settings > Apps > Sunshine > Uninstall, then press "Set up / Repair".';
    const text: string = M.pairErrorMessage({ ok: false, hostId: 'h', code: 'sunshine-api-error', message: tooOld, retryable: true, durationMs: 1 });
    expect(text).toMatch(/^Sunshine on the PC returned an error\..* Details: The Sunshine installed on the PC is too old/);
    expect(M.pairErrorMessage({ ok: false, hostId: 'h', code: 'approval-denied', message: 'RAW', retryable: false, durationMs: 1 })).not.toMatch(/RAW|Details/);
    expect(M.pairErrorMessage({ ok: false, hostId: 'h', code: 'no-pending-pairing', message: 'x'.repeat(900), retryable: true, durationMs: 1 }).length).toBeLessThan(520);
  });
  it('validAddress accepts IPs and names, rejects URL-ish input', () => {
    for (const ok of ['192.168.1.20', ' 10.0.0.1 ', 'fe80::1', 'gaming-pc', 'pc.local']) expect(M.validAddress(ok)).not.toBeNull();
    for (const bad of ['', '999.1.1.1', 'http://1.2.3.4', '1.2.3.4/x', 'a b', 'pc?x=1', '1.2.3.4:47989']) expect(M.validAddress(bad)).toBeNull();
  });
  it('sunshineSummary reads install and service steps', () => {
    expect(M.sunshineSummary(null)).toEqual({ installed: null, running: null });
    const step = (stepId: string, status: string) => ({ stepId, status, title: stepId, message: '', startedAt: '', durationMs: 0, commands: [] });
    expect(M.sunshineSummary({ lastRunAt: 'x', ok: true, steps: [step('service', 'pass'), step('web-ui', 'pass')], install: {}, isAdmin: true })).toEqual({ installed: true, running: true });
    expect(M.sunshineSummary({ lastRunAt: 'x', ok: false, steps: [step('service', 'fail')], install: null, isAdmin: false })).toEqual({ installed: false, running: false });
    expect(M.sunshineSummary({ lastRunAt: null, ok: false, steps: [], install: null, isAdmin: false }).running).toBeNull();
  });
});
