// What macOS makes a Sunshine host ask the user for, and the few facts LanPlay can read about it (docs/MAC-HOST-DESIGN.md 2.7).
// LanPlay cannot read another app's privacy (TCC) grants, so the only machine-readable signals are Sunshine's own log
// and the firewall tool.
import { SUNSHINE_MAC } from '../../../contracts.js';
import type { SettingsPane } from '../../../contracts.js';

const SECURITY = 'x-apple.systempreferences:com.apple.preference.security';

/** The renderer sends a pane name; main opens the link from this fixed map, so no URL ever crosses IPC. */
export const SETTINGS_URLS: Readonly<Record<SettingsPane, string>> = Object.freeze({
  'screen-recording': `${SECURITY}?Privacy_ScreenCapture`,
  accessibility: `${SECURITY}?Privacy_Accessibility`,
  microphone: `${SECURITY}?Privacy_Microphone`,
  'local-network': `${SECURITY}?Privacy_LocalNetwork`,
  'login-items': 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  firewall: 'x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall',
});

/** null for anything that is not one of the six panes (IPC input is untrusted, and "toString" is not a pane). */
export function settingsUrl(pane: unknown): string | null {
  return typeof pane === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS_URLS, pane) ? SETTINGS_URLS[pane as SettingsPane] : null;
}

/** Sunshine logs this line at start while macOS withholds the Screen Recording grant, then keeps running without capture. */
export function screenRecordingDenied(sunshineLog: string): boolean {
  return sunshineLog.includes(SUNSHINE_MAC.noScreenPermissionLog);
}

/** Needs no root. */
export function firewallStateArgv(): { file: string; args: string[] } {
  return { file: '/usr/libexec/ApplicationFirewall/socketfilterfw', args: ['--getglobalstate'] };
}

export type FirewallState = 'off' | 'on' | 'block-all' | 'unknown';

/** `socketfilterfw --getglobalstate` ends with "(State = 0|1|2)"; 2 is "block all incoming connections". */
export function parseFirewallState(output: string): FirewallState {
  const m = /\(State = ([012])\)/.exec(output);
  return m ? (['off', 'on', 'block-all'] as const)[Number(m[1])]! : 'unknown';
}

/**
 * os.release() is the Darwin kernel version: 20 to 24 are macOS 11 to 15, and Apple then renumbered macOS to match the
 * year, so Darwin 25 is macOS 26. null when the string is not a Darwin release.
 */
export function macosMajorFromDarwin(release: string): number | null {
  const darwin = Number(/^(\d+)\./.exec(release)?.[1]);
  if (!Number.isInteger(darwin) || darwin < 20) return null;
  return darwin >= 25 ? darwin + 1 : darwin - 9;
}
