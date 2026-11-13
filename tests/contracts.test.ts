import { describe, expect, it } from 'vitest';
import {
  BITRATE_LIMITS_MBPS,
  HOST_STEP_ORDER,
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  LANPLAY,
  MOONLIGHT,
  PRESETS,
  SUNSHINE,
} from '../src/contracts.js';

describe('contracts', () => {
  it('has unique IPC channel names', () => {
    const all = [...IPC_INVOKE_CHANNELS, ...IPC_EVENT_CHANNELS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('derives Sunshine ports from the base port as documented', () => {
    expect(SUNSHINE.httpsPort).toBe(SUNSHINE.basePort - 5);
    expect(SUNSHINE.webUiPort).toBe(SUNSHINE.basePort + 1);
    expect(SUNSHINE.rtspPort).toBe(SUNSHINE.basePort + 21);
    expect([...SUNSHINE.udpPorts]).toEqual([9, 10, 11].map((o) => SUNSHINE.basePort + o));
  });

  it('keeps the agent port clear of every Sunshine port', () => {
    const sunshinePorts = [SUNSHINE.httpsPort, SUNSHINE.httpPort, SUNSHINE.webUiPort, SUNSHINE.rtspPort, ...SUNSHINE.udpPorts];
    expect(sunshinePorts).not.toContain(LANPLAY.agentPort);
  });

  it('keeps presets inside the UI and Moonlight bitrate limits', () => {
    for (const p of PRESETS) {
      expect(p.settings.bitrateMbps).toBeGreaterThanOrEqual(BITRATE_LIMITS_MBPS.min);
      expect(p.settings.bitrateMbps).toBeLessThanOrEqual(BITRATE_LIMITS_MBPS.max);
    }
    expect(BITRATE_LIMITS_MBPS.advancedMax * 1000).toBeLessThanOrEqual(MOONLIGHT.bitrateKbpsRange[1]);
  });

  it('lists every host step once', () => {
    expect(new Set(HOST_STEP_ORDER).size).toBe(HOST_STEP_ORDER.length);
  });
});
