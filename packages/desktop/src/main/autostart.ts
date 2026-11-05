/** The part of Electron's `app` used for "Iniciar com o Windows". */
export interface LoginItemApi {
  setLoginItemSettings(settings: { openAtLogin: boolean; args: string[] }): void;
  getLoginItemSettings(options: { args: string[] }): { openAtLogin: boolean };
}

export interface Autostart {
  /** False in development: the login item would point at a bare `electron.exe` without the app. */
  readonly supported: boolean;
  get(): boolean;
  /** Returns the value now in effect. */
  set(enabled: boolean): boolean;
}

/** The login item starts Desktop in the tray, with no panel (`--hidden`). */
export const HIDDEN_ARG = '--hidden';

export function createAutostart(api: LoginItemApi, packaged: boolean): Autostart {
  const args = [HIDDEN_ARG];
  return {
    supported: packaged,
    get() {
      if (!packaged) return false;
      return api.getLoginItemSettings({ args }).openAtLogin;
    },
    set(enabled) {
      if (!packaged) return false;
      api.setLoginItemSettings({ openAtLogin: enabled, args });
      return api.getLoginItemSettings({ args }).openAtLogin;
    },
  };
}
