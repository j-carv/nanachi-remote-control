import { contextBridge, ipcRenderer } from 'electron';
import { CONTROL_SYNC_CHANNELS } from '../common/channels.js';
import { createControlBridge } from './control-bridge.js';

/**
 * Preload of the control center window. Bundled into one file (`dist/preload/control.cjs`) because a sandboxed preload
 * can only `require('electron')`. It exposes `window.nanachiControl` and nothing else; the device token never gets here.
 */
function readVersion(): string {
  const answer: unknown = ipcRenderer.sendSync(CONTROL_SYNC_CHANNELS.init);
  if (typeof answer !== 'object' || answer === null) return '0.0.0';
  const { version } = answer as Record<string, unknown>;
  return typeof version === 'string' && version !== '' ? version : '0.0.0';
}

contextBridge.exposeInMainWorld('nanachiControl', createControlBridge(ipcRenderer, readVersion()));
