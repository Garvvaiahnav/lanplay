// Which virtual-pad backend a platform gets. Windows drives ViGEmBus; a Mac host has no virtual gamepad yet
// (docs/MAC-HOST-DESIGN.md section 3), so it reports that honestly instead of failing when a phone connects.
import { createViGEmBackend } from './vigem.js';
import type { PadBackend } from './vigem.js';

export const MAC_PADS_UNAVAILABLE = 'The Mac gamepad driver is not available yet, so phone controllers cannot be used on a Mac host.';

function unavailable(reason: 'driver-missing' | 'error', message: string): PadBackend {
  return {
    status: () => ({ ok: false, reason, message }),
    createPad: () => {
      throw new Error(message);
    },
  };
}

export function createPadBackendFor(platform: NodeJS.Platform, o: { vigemDllPath: string }): PadBackend {
  if (platform === 'win32') return createViGEmBackend({ dllPath: o.vigemDllPath });
  if (platform === 'darwin') return unavailable('driver-missing', MAC_PADS_UNAVAILABLE);
  return unavailable('error', 'Phone controllers need Windows.');
}
