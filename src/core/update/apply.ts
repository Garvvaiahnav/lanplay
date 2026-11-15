// Starting a staged, already verified installer (pure plan + injected spawn; main does the process exit).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';

export interface ApplyPlan {
  command: string;
  args: string[];
  /** macOS: body of the helper script written to args[0] before it is run. */
  script?: string;
}

export interface ApplyInput {
  platform: string;
  /** The staged installer (Windows .exe) or zip of LanPlay.app (macOS). */
  file: string;
  /** macOS: path of the running LanPlay.app, null when not running from an .app (dev). */
  appPath: string | null;
  pid: number;
  stageDir: string;
}

/**
 * Windows: the one-click NSIS installer, silent. "--updated --force-run" is what electron-updater passes so the installer
 * starts the new version when it is done. UNTESTED-ON-WINDOWS.
 * macOS: a shell script that waits for this process to exit, swaps the .app and opens it. UNTESTED-ON-MAC (no mac asset shipped yet).
 */
export function planApply(i: ApplyInput): ApplyPlan | null {
  if (i.platform === 'win32') return { command: i.file, args: ['--updated', '/S', '--force-run'] };
  if (i.platform === 'darwin' && i.appPath) {
    const script = path.join(i.stageDir, 'apply-update.sh');
    return { command: '/bin/sh', args: [script, String(i.pid), i.file, i.appPath], script: applyScriptBody() };
  }
  return null;
}

export function applyScriptBody(): string {
  return `#!/bin/sh
# $1 = pid of the running LanPlay, $2 = zip containing LanPlay.app, $3 = path of the installed LanPlay.app
while kill -0 "$1" 2>/dev/null; do sleep 0.3; done
TMP="$(mktemp -d "$(dirname "$3")/.lanplay-update.XXXXXX")" || exit 1
/usr/bin/ditto -x -k "$2" "$TMP" || { rm -rf "$TMP"; exit 1; }
[ -d "$TMP/LanPlay.app" ] || { rm -rf "$TMP"; exit 1; }
mv "$3" "$TMP/old.app" || { rm -rf "$TMP"; exit 1; }
mv "$TMP/LanPlay.app" "$3" || { mv "$TMP/old.app" "$3"; rm -rf "$TMP"; exit 1; }
rm -rf "$TMP"
/usr/bin/open "$3"
`;
}

/** Run the plan detached from this process. The caller quits the app right after. */
export function runApply(plan: ApplyPlan, stageDir: string, spawnFn: typeof spawn): void {
  if (plan.script) {
    mkdirSync(stageDir, { recursive: true });
    const scriptPath = plan.args[0] as string;
    writeFileSync(scriptPath, plan.script);
    chmodSync(scriptPath, 0o700);
  }
  const child = spawnFn(plan.command, plan.args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
  child.unref();
}
