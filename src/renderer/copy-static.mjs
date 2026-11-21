// Copies the non-TypeScript renderer files next to the compiled scripts (dist/renderer).
// Run after `tsc -p tsconfig.json` (the "build" script does this).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'dist', 'renderer');
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css', 'stream-menu.html', 'stream-menu.css']) copyFileSync(join(here, f), join(out, f));
console.log('renderer assets copied to', out);

// Phone controller page (served to phones by the host over the LAN): src/controller-ui -> dist/controller-ui, next to the compiled controller.js.
const uiSrc = join(here, '..', 'controller-ui');
const uiOut = join(here, '..', '..', 'dist', 'controller-ui');
mkdirSync(uiOut, { recursive: true });
for (const f of ['index.html', 'controller.css', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'wake.mp4', 'manifest.webmanifest']) copyFileSync(join(uiSrc, f), join(uiOut, f));
console.log('controller page assets copied to', uiOut);
