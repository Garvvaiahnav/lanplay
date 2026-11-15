import { describe, expect, it } from 'vitest';
import { resolveRole } from '../../src/core/client/role.js';

// Windows cases live in client-windows.test.ts; these pin the macOS behaviour (docs/MAC-HOST-DESIGN.md 2.3).
describe('resolveRole on macOS', () => {
  it('lets the user choose a role', () => {
    expect(resolveRole({ flag: null, stored: null, platform: 'darwin' }).canChoose).toBe(true);
  });

  it('keeps opening as a client without asking, so a Mac that updates sees no first-run question', () => {
    expect(resolveRole({ flag: null, stored: null, platform: 'darwin' })).toEqual({ role: 'client', source: 'default', canChoose: true, needsChoice: false });
    expect(resolveRole({ flag: null, stored: 'garbage', platform: 'darwin' })).toMatchObject({ role: 'client', source: 'default', needsChoice: false });
  });

  it('honours a stored host role and the --role flag over it', () => {
    expect(resolveRole({ flag: null, stored: 'host', platform: 'darwin' })).toEqual({ role: 'host', source: 'stored', canChoose: true, needsChoice: false });
    expect(resolveRole({ flag: 'client', stored: 'host', platform: 'darwin' })).toEqual({ role: 'client', source: 'flag', canChoose: true, needsChoice: false });
  });

  it('still fixes the role on other platforms', () => {
    expect(resolveRole({ flag: null, stored: null, platform: 'linux' }).canChoose).toBe(false);
  });
});
