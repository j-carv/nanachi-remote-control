import { contextBridge, ipcRenderer } from 'electron';
import { SYNC_CHANNELS } from '../common/channels.js';
import type { PreloadInit, SeedMachine } from '../common/types.js';
import { createBridge } from './bridge.js';
import { seedMachines, type StorageLike } from './seed.js';

/**
 * Preload of the panel window. It is bundled into one file (`dist/preload/index.cjs`) because a sandboxed preload
 * can only `require('electron')`. No DOM lib is loaded for this package, so the two globals used are typed here.
 */
interface PageGlobals {
  localStorage: StorageLike;
  location: { origin: string };
}

function isSeedMachine(value: unknown): value is SeedMachine {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['id', 'name', 'baseUrl', 'token'].every((key) => typeof record[key] === 'string' && record[key] !== '');
}

function readInit(): PreloadInit {
  const answer: unknown = ipcRenderer.sendSync(SYNC_CHANNELS.init);
  if (typeof answer !== 'object' || answer === null) return { version: '0.0.0', machine: null };
  const record = answer as Record<string, unknown>;
  return {
    version: typeof record.version === 'string' ? record.version : '0.0.0',
    machine: isSeedMachine(record.machine) ? record.machine : null,
  };
}

const page = globalThis as unknown as PageGlobals;
const init = readInit();
seedMachines(page.localStorage, init.machine, page.location.origin);
contextBridge.exposeInMainWorld('nanachiDesktop', createBridge(ipcRenderer, init.version));
