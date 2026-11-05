import { contextBridge, ipcRenderer } from 'electron';
import { CONTROL_SYNC_CHANNELS } from '../common/channels.js';
import { DEFAULT_LANGUAGE, isLanguage, type Language } from '../common/i18n/languages.js';
import { createControlBridge } from './control-bridge.js';

/**
 * Preload of the control center window. Bundled into one file (`dist/preload/control.cjs`) because a sandboxed preload
 * can only `require('electron')`. It exposes `window.nanachiControl` and nothing else; the device token never gets here.
 */
function readInit(): { version: string; language: Language } {
  const answer: unknown = ipcRenderer.sendSync(CONTROL_SYNC_CHANNELS.init);
  if (typeof answer !== 'object' || answer === null) return { version: '0.0.0', language: DEFAULT_LANGUAGE };
  const { version, language } = answer as Record<string, unknown>;
  return {
    version: typeof version === 'string' && version !== '' ? version : '0.0.0',
    language: isLanguage(language) ? language : DEFAULT_LANGUAGE,
  };
}

const init = readInit();
contextBridge.exposeInMainWorld('nanachiControl', createControlBridge(ipcRenderer, init.version, init.language));
