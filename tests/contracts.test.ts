import { describe, expect, it } from 'vitest';
import {
  BITRATE_LIMITS_MBPS,
  HOST_STEP_ORDER,
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  LANPLAY,
  MAC_HOST_STEP_ORDER,
  MOONLIGHT,
  PRESETS,
  SUNSHINE,
  SUNSHINE_MAC,
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

  it('lists every macOS host step once and none of the Windows-only ones', () => {
    expect(new Set(MAC_HOST_STEP_ORDER).size).toBe(MAC_HOST_STEP_ORDER.length);
    for (const id of ['admin', 'locate-sunshine', 'install-sunshine', 'service', 'restart-service', 'firewall-sunshine', 'firewall-agent'] as const) {
      expect(MAC_HOST_STEP_ORDER).not.toContain(id);
    }
  });

  it('runs the macOS steps in the order the setup depends on', () => {
    const at = (id: (typeof MAC_HOST_STEP_ORDER)[number]) => MAC_HOST_STEP_ORDER.indexOf(id);
    // Sunshine must be copied before it is configured, launched before its API is probed, and its API
    // probed only after the screen-recording grant (without it Sunshine has nothing to stream).
    expect(at('mac-bundle')).toBeLessThan(at('mac-install'));
    expect(at('mac-install')).toBeLessThan(at('config'));
    expect(at('credentials')).toBeLessThan(at('mac-launch-agent'));
    expect(at('mac-launch-agent')).toBeLessThan(at('mac-screen-recording'));
    expect(at('mac-screen-recording')).toBeLessThan(at('web-ui'));
    expect(at('web-ui')).toBeLessThan(at('api-auth'));
    expect(MAC_HOST_STEP_ORDER.at(-1)).toBe('agent-listening');
  });

  it('pins the Sunshine macOS bundle facts the install and launchd code rely on', () => {
    expect(SUNSHINE_MAC.bundleId).toBe('dev.lizardbyte.app.Sunshine');
    expect(SUNSHINE_MAC.appName).toBe('Sunshine.app');
    expect(SUNSHINE_MAC.binaryRelative).toBe('Contents/MacOS/Sunshine');
    expect(SUNSHINE_MAC.launchdLabel).not.toBe(SUNSHINE_MAC.agentLaunchdLabel);
    expect(SUNSHINE_MAC.minMacOS).toBe(14);
    expect(Object.isFrozen(SUNSHINE_MAC)).toBe(true);
  });

  it('exposes the macOS host IPC channels', () => {
    for (const c of ['host:open-settings', 'host:confirm-input', 'host:sunshine-restart']) expect(IPC_INVOKE_CHANNELS as readonly string[]).toContain(c);
  });
});
