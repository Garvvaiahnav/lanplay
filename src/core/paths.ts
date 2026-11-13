// AppPaths resolution (pure; path.win32 on Windows, posix on macOS). Never hardcodes an install path.
import path from 'node:path';
import type { AppPaths } from '../contracts.js';

export interface PathInputs {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  /** Electron app.getPath('userData'). */
  userData: string;
  /** app.getPath('desktop'). */
  desktop: string;
  isPackaged: boolean;
  /** process.resourcesPath (packaged). */
  resourcesPath: string;
  /** Repo root (dev). */
  appRoot: string;
  /** Can we create + write files in this dir? (probe injected so tests stay pure) */
  canWrite: (dir: string) => boolean;
}

export function computeAppPaths(i: PathInputs): AppPaths {
  const win = i.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const resources = i.isPackaged ? i.resourcesPath : i.appRoot;
  // Packaged: resources/vendor holds the MSI (win) or Moonlight.app (mac). Dev: the fetch-vendor folders.
  const vendorDir = i.isPackaged ? p.join(resources, 'vendor') : p.join(i.appRoot, 'vendor', win ? 'sunshine-windows-msi' : 'moonlight-macos');
  const psDir = i.isPackaged ? p.join(resources, 'ps') : p.join(i.appRoot, 'scripts', 'windows');
  if (win) {
    const programData = i.env.ProgramData || i.env.ALLUSERSPROFILE || 'C:\\ProgramData';
    const sharedData = p.join(programData, 'LanPlay');
    const preferred = p.join(sharedData, 'logs');
    const fellBack = !i.canWrite(preferred);
    const localAppData = i.env.LOCALAPPDATA || p.join(i.homedir, 'AppData', 'Local');
    return {
      logDir: fellBack ? p.join(localAppData, 'LanPlay', 'logs') : preferred,
      userData: i.userData,
      sharedData,
      resources,
      vendorDir,
      psDir,
      diagnosticsOutDir: i.desktop,
      logDirFellBack: fellBack,
    };
  }
  return {
    logDir: p.join(i.homedir, 'Library', 'Logs', 'LanPlay'),
    userData: i.userData,
    sharedData: i.userData,
    resources,
    vendorDir,
    psDir,
    diagnosticsOutDir: i.desktop,
    logDirFellBack: false,
  };
}
