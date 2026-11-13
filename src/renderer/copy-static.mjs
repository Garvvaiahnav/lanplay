// Copies the non-TypeScript renderer files next to the compiled scripts (dist/renderer).
// Run after `tsc -p tsconfig.json` (the "build" script does this).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'dist', 'renderer');
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css']) copyFileSync(join(here, f), join(out, f));
console.log('renderer assets copied to', out);
