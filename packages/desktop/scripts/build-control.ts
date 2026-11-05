import { copyFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { markControlBuild, prepareControlOut } from './control-out.js';

/**
 * Builds the control center renderer (`src/control`) with Vite into `dist/control` (run by `build:desktop`).
 *
 * `NANACHI_CONTROL_OUT` (absolute) writes somewhere else, and `NANACHI_CONTROL_MOCK=1` bundles the mock `ControlApi`:
 * together they make the throwaway build used for screenshots, outside the repository. The icon is a plain copy of
 * the app artwork (`packages/pwa/public/icon-512.png`); it is never edited or regenerated.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(root, '..', '..');
const icon = join(repoRoot, 'packages', 'pwa', 'public', 'icon-512.png');

const override = process.env.NANACHI_CONTROL_OUT;
if (override !== undefined && override !== '' && !isAbsolute(override)) {
  throw new Error('NANACHI_CONTROL_OUT must be an absolute path');
}
const explicit = override !== undefined && override !== '';
const outDir = explicit ? override : join(root, 'dist', 'control');

// An explicit folder is emptied only when it is empty or is the output of a previous run of this build.
prepareControlOut(outDir, { explicit });
await build({
  configFile: join(root, 'vite.control.config.ts'),
  build: { outDir },
});
mkdirSync(outDir, { recursive: true });
copyFileSync(icon, join(outDir, 'icon.png'));
// Only an explicit folder is marked: `dist/control` is always this build's and is packaged as it is (no stray file).
if (explicit) markControlBuild(outDir);
console.log(`control center: ${outDir}`);
