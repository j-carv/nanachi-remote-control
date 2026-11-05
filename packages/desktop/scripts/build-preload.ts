import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * The panel window is sandboxed, and a sandboxed preload can only `require('electron')`: it cannot load sibling
 * files. So the preload (and the channel list it shares with the main process) is bundled into one CommonJS file.
 * Only the preload goes through esbuild; the main process is plain `tsc` output.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  external: ['electron'],
  logLevel: 'warning',
});
