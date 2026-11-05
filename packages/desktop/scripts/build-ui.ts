import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { removeTreeOrThrow } from '../src/install/safe-remove.js';

/**
 * Bundles the installer app and the uninstall window with esbuild (run by `build:desktop` after `tsc`).
 *
 * - `dist/installer/`: the installer's own Electron app. `main.cjs` and `preload.cjs` bundle everything they need
 *   (`extract-zip` included), so the installer app has no `node_modules`; `ui/` holds its page.
 * - `dist/ui/` and `dist/preload/uninstall.cjs`: the uninstall window of `Nanachi.exe --uninstall`, loaded by the main
 *   app (`src/main/uninstall-app.ts`).
 *
 * The icon is a plain copy of the app artwork (`packages/pwa/public/icon-512.png`); it is never edited or regenerated.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(root, '..', '..');
const icon = join(repoRoot, 'packages', 'pwa', 'public', 'icon-512.png');
const dist = join(root, 'dist');
const uiSource = join(root, 'installer', 'ui');

const node: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outExtension: { '.js': '.cjs' },
  logLevel: 'warning',
};
const page: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  logLevel: 'warning',
};

function copyInto(dir: string, files: Array<{ from: string; name: string }>): void {
  mkdirSync(dir, { recursive: true });
  for (const file of files) copyFileSync(file.from, join(dir, file.name));
}

removeTreeOrThrow(join(dist, 'installer'));
removeTreeOrThrow(join(dist, 'ui'));

// The installer app. It extracts into folders that contain `app.asar`, and Electron's asar-aware `fs` would treat
// those as archives, so asar support is switched off before anything else runs.
await build({
  ...node,
  entryPoints: { main: 'installer/main.ts', preload: 'installer/preload.ts' },
  outdir: 'dist/installer',
  banner: { js: 'process.noAsar = true;' },
});
await build({
  ...page,
  entryPoints: { installer: 'installer/ui/installer.ts' },
  outdir: 'dist/installer/ui',
});
copyInto(join(dist, 'installer', 'ui'), [
  { from: join(uiSource, 'installer.html'), name: 'installer.html' },
  { from: join(uiSource, 'shell.css'), name: 'shell.css' },
  { from: icon, name: 'icon.png' },
]);

// The uninstall window of the main app.
await build({
  ...node,
  entryPoints: { uninstall: 'src/preload/uninstall.ts' },
  outdir: 'dist/preload',
});
await build({
  ...page,
  entryPoints: { uninstall: 'installer/ui/uninstall.ts' },
  outdir: 'dist/ui',
});
copyInto(join(dist, 'ui'), [
  { from: join(uiSource, 'uninstall.html'), name: 'uninstall.html' },
  { from: join(uiSource, 'shell.css'), name: 'shell.css' },
  { from: icon, name: 'icon.png' },
]);
