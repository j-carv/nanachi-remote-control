import { contextBridge, ipcRenderer } from 'electron';
import { INSTALLER_CHANNELS as channels, type InstallerApi } from '../src/install/ipc.js';
import type { InstallProgress } from '../src/install/install.js';
import type { RunningProcess } from '../src/install/processes.js';

/** What the installer page may do: a fixed list of channels, nothing else from Electron or Node. */
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T): void => callback(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: InstallerApi = {
  init: () => ipcRenderer.invoke(channels.init),
  chooseFolder: (current) => ipcRenderer.invoke(channels.chooseFolder, current),
  validateTarget: (target) => ipcRenderer.invoke(channels.validateTarget, target),
  start: (request) => ipcRenderer.invoke(channels.start, request),
  onProgress: (callback) => subscribe<InstallProgress>(channels.progress, callback),
  onAskClose: (callback) => subscribe<RunningProcess[]>(channels.askClose, callback),
  answerClose: (proceed) => ipcRenderer.send(channels.answerClose, proceed),
  launch: () => ipcRenderer.invoke(channels.launch),
  minimize: () => ipcRenderer.send(channels.minimize),
  close: () => ipcRenderer.send(channels.close),
};

contextBridge.exposeInMainWorld('installer', api);
