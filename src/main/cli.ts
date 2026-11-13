// CLI flags (same binary on both platforms). Pure parser: no Electron import.
import path from 'node:path';
import { CLI_FLAGS } from '../contracts.js';
import type { Role } from '../contracts.js';

export type CliMode = 'gui' | 'self-check' | 'diagnostics' | 'agent' | 'host-setup';

export interface CliOptions {
  mode: CliMode;
  role: Role | null;
  out: string | null;
  handoff: string | null;
  result: string | null;
  json: boolean;
  /** Ignored arguments (e.g. macOS -psn_0_123, Chromium switches). */
  ignored: string[];
}

export class CliError extends Error {}

/** argv WITHOUT the executable (and without the app path in dev). */
export function parseCli(argv: readonly string[], platform: NodeJS.Platform = process.platform): CliOptions {
  const o: CliOptions = { mode: 'gui', role: null, out: null, handoff: null, result: null, json: false, ignored: [] };
  const modes: CliMode[] = [];
  const isAbs = (p: string) => (platform === 'win32' ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p));
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case CLI_FLAGS.selfCheck:
        modes.push('self-check');
        break;
      case CLI_FLAGS.diagnostics:
        modes.push('diagnostics');
        break;
      case CLI_FLAGS.agent:
        modes.push('agent');
        break;
      case CLI_FLAGS.hostSetup:
        modes.push('host-setup');
        break;
      case CLI_FLAGS.json:
        o.json = true;
        break;
      case CLI_FLAGS.role: {
        const v = value(i++, a);
        if (v !== 'client' && v !== 'host') throw new CliError('--role must be "client" or "host"');
        o.role = v;
        break;
      }
      case CLI_FLAGS.out:
        o.out = value(i++, a);
        if (!isAbs(o.out)) throw new CliError('--out must be an absolute folder path');
        break;
      case CLI_FLAGS.handoff:
        o.handoff = value(i++, a);
        if (!isAbs(o.handoff)) throw new CliError('--handoff must be an absolute path');
        break;
      case CLI_FLAGS.result:
        o.result = value(i++, a);
        if (!isAbs(o.result)) throw new CliError('--result must be an absolute path');
        break;
      default:
        o.ignored.push(a);
    }
  }
  if (new Set(modes).size > 1) throw new CliError(`choose one of ${CLI_FLAGS.selfCheck}, ${CLI_FLAGS.diagnostics}, ${CLI_FLAGS.agent}, ${CLI_FLAGS.hostSetup}`);
  o.mode = modes[0] ?? 'gui';
  if (o.mode === 'host-setup' && (!o.handoff || !o.result)) throw new CliError('--host-setup needs --handoff <file> and --result <file>');
  return o;
}

// Role resolution lives in core (pure, tested). Re-exported so main.ts keeps importing from './cli.js':
//   const r = resolveRole({ flag: cli.role, stored: settings.get('app.role', null), platform: process.platform });
export { defaultRole, parseStoredRole, readStoredRole, resolveRole, writeStoredRole, ROLE_SETTING_KEY } from '../core/client/role.js';
export type { ResolvedRole, RoleSource } from '../core/client/role.js';
