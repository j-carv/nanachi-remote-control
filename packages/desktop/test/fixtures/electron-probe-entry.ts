/**
 * Entry of the bundle that `electron-probe.cjs` runs under Electron's own Node (`ELECTRON_RUN_AS_NODE=1`). It exposes
 * the real install and uninstall code, with the same `fs` they get inside the packaged app.
 */
export { runInstall } from '../../src/install/install.js';
export { removeTree } from '../../src/install/safe-remove.js';
export { runUninstall } from '../../src/install/uninstall.js';
