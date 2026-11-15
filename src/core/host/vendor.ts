// Pinned bundled installer (must equal vendor/manifest.json; a test enforces it).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { SUNSHINE } from '../../contracts.js';

/** https://github.com/LizardByte/Sunshine/releases/download/v2026.914.233613/Sunshine-Windows-AMD64-installer.msi (GitHub asset digest = local shasum, 2026-11-13). */
export const SUNSHINE_MSI_SHA256 = '1d7fed8beecd5889dc7ff14cf9f42d6d38f37c3066c13c6c2a5f4e91847e0ccf';
export const SUNSHINE_MSI_NAME = SUNSHINE.msiAsset;

/** https://github.com/LizardByte/Sunshine/releases/download/v2026.914.233613/Sunshine-macOS-arm64.dmg (GitHub asset digest = local shasum, 2026-11-16). */
export const SUNSHINE_MAC_DMG_SHA256 = '795f03a389c5726f9a7b15f501dc1ddf204b442cae565859ac83aae027a9e07c';
/** Developer ID Application: LizardByte LLC. `codesign -dv Sunshine.app` -> TeamIdentifier. */
export const SUNSHINE_MAC_TEAM_ID = 'F8XQ7XCN2R';
export const SUNSHINE_MAC_BUNDLE_ID = 'dev.lizardbyte.app.Sunshine';
export const SUNSHINE_MAC_VERSION = SUNSHINE.version;

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
