import { contextBridge, ipcRenderer } from 'electron';
import { UNINSTALLER_CHANNELS as channels, type UninstallerApi } from '../install/ipc.js';
import type { UninstallProgress } from '../install/uninstall.js';

/** What the uninstall window may do: a fixed list of channels, nothing else from Electron or Node. */
const api: UninstallerApi = {
  init: () => ipcRenderer.invoke(channels.init),
  start: (request) => ipcRenderer.invoke(channels.start, request),
  onProgress: (callback) => {
    const listener = (_event: unknown, progress: UninstallProgress): void => callback(progress);
    ipcRenderer.on(channels.progress, listener);
    return () => {
      ipcRenderer.removeListener(channels.progress, listener);
    };
  },
  minimize: () => ipcRenderer.send(channels.minimize),
  close: () => ipcRenderer.send(channels.close),
};

contextBridge.exposeInMainWorld('uninstaller', api);
