import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeTreeOrThrow } from '../src/install/safe-remove.js';

/**
 * The output folder of the control center build. `NANACHI_CONTROL_OUT` lets the caller choose it, and the build empties it
 * first, so a wrong value (a folder of documents, a drive root) must not be wiped: an explicit folder is emptied only when
 * it is empty already, does not exist, or carries the marker a previous run of this build left in it. The repository's own
 * `dist/control` (no explicit path) is always this build's.
 */
export const BUILD_MARKER = '.nanachi-control-build';

export function prepareControlOut(outDir: string, options: { explicit: boolean }): void {
  if (options.explicit) assertOurs(outDir);
  removeTreeOrThrow(outDir);
  mkdirSync(outDir, { recursive: true });
}

/** Written after a successful build: "this folder is the output of the control center build, it may be replaced". */
export function markControlBuild(outDir: string): void {
  writeFileSync(join(outDir, BUILD_MARKER), 'Output of scripts/build-control.ts; the next build may replace this folder.\n', 'utf8');
}

function assertOurs(outDir: string): void {
  let stats;
  try {
    stats = lstatSync(outDir);
  } catch {
    return; // Does not exist: nothing to lose.
  }
  const refuse = (): never => {
    throw new Error(
      `NANACHI_CONTROL_OUT (${outDir}) não está vazia e não parece ser uma saída anterior do build do centro de controle ` +
        `(falta o arquivo ${BUILD_MARKER}); escolha uma pasta nova ou vazia. Nada foi apagado.`,
    );
  };
  if (!stats.isDirectory()) return refuse();
  const names = readdirSync(outDir);
  if (names.length === 0 || names.includes(BUILD_MARKER)) return;
  refuse();
}
