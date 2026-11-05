import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildResult } from 'esbuild';

/**
 * The panel and control center windows are sandboxed, and a sandboxed preload can only `require('electron')`: it cannot
 * load sibling files. So each preload (and the channel list it shares with the main process) is bundled into one
 * CommonJS file: `index.cjs` for the PWA panel and `control.cjs` for the control center. Only the preloads go through
 * esbuild here; the main process is plain `tsc` output. `scripts/build-preload.ts` runs this into `dist/preload`, and the
 * tests run the same function into a temporary folder.
 */
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));

export const PRELOAD_ENTRIES = { index: 'src/preload/index.ts', control: 'src/preload/control.ts' } as const;

export interface PreloadBuildOptions {
  /** Where the two `.cjs` files go: relative to the desktop package, or absolute. */
  outdir: string;
}

export function buildPreloads(options: PreloadBuildOptions): Promise<BuildResult> {
  return build({
    absWorkingDir: desktopRoot,
    entryPoints: { ...PRELOAD_ENTRIES },
    outdir: isAbsolute(options.outdir) ? options.outdir : join(desktopRoot, options.outdir),
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    external: ['electron'],
    logLevel: 'warning',
  });
}
