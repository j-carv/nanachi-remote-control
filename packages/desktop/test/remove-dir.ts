import * as nodeFs from 'node:fs';
import { removeTree } from '../src/install/safe-remove.js';

/** Deletes a temp folder of a test the way the app does: never through a junction (and never `rmSync` with `recursive`). */
export function removeDir(path: string): void {
  removeTree(path, nodeFs);
}
