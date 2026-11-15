// Role resolution (pure, no Electron). The same app can be the HOST (runs Sunshine) or the CLIENT (runs Moonlight).
// Effective role = --role flag, else the stored 'app.role' setting, else the platform default
// (darwin = client, win32 = host). On Windows nothing says which one the user wants until they choose,
// so `needsChoice` is true there until a role is stored; the renderer then asks (IPC 'app:role-set').
// macOS can choose too, but is never asked: every Mac install predates the Mac host, so an update must keep
// opening as a client. Those users switch through the "Change role" link instead.
import type { KeyValueStore, Role } from '../../contracts.js';

/** Key in the shared settings store (KeyValueStore). */
export const ROLE_SETTING_KEY = 'app.role';

export type RoleSource = 'flag' | 'stored' | 'default';

export interface ResolvedRole {
  role: Role;
  source: RoleSource;
  /** The user may switch role in the UI (Windows and macOS; also with --role, because 'app:role-set' relaunches with --role). Feeds AppInfo.canChooseRole. */
  canChoose: boolean;
  /** Windows only (see header), no flag, nothing stored yet: the renderer must show the "Host or Client?" question first. */
  needsChoice: boolean;
}

export function defaultRole(platform: NodeJS.Platform): Role {
  return platform === 'win32' ? 'host' : 'client';
}

/** Anything that is not exactly 'client' or 'host' (corrupt settings file, old version) counts as "nothing stored". */
export function parseStoredRole(v: unknown): Role | null {
  return v === 'client' || v === 'host' ? v : null;
}

export interface ResolveRoleInput {
  /** Value of --role (already validated by parseCli) or null. */
  flag: Role | null;
  /** Raw value of the 'app.role' setting (unvalidated). */
  stored: unknown;
  platform: NodeJS.Platform;
}

export function resolveRole(i: ResolveRoleInput): ResolvedRole {
  const stored = parseStoredRole(i.stored);
  const canChoose = i.platform === 'win32' || i.platform === 'darwin';
  const needsChoice = i.platform === 'win32';
  if (i.flag) return { role: i.flag, source: 'flag', canChoose, needsChoice: false };
  if (stored) return { role: stored, source: 'stored', canChoose, needsChoice: false };
  return { role: defaultRole(i.platform), source: 'default', canChoose, needsChoice };
}

export function readStoredRole(settings: KeyValueStore): Role | null {
  return parseStoredRole(settings.get<unknown>(ROLE_SETTING_KEY, null));
}

/** Persists the user's choice. Throws on anything but 'client' | 'host' (the IPC payload is untrusted). */
export function writeStoredRole(settings: KeyValueStore, role: unknown): Role {
  const r = parseStoredRole(role);
  if (!r) throw new Error('Role must be "client" or "host".');
  settings.set(ROLE_SETTING_KEY, r);
  return r;
}
