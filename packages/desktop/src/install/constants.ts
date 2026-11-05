/** Names shared by the installer, the uninstaller and the main app. No Electron imports here. */

export const PRODUCT_NAME = 'Nanachi';
export const PUBLISHER = 'Nanachi';
export const EXE_NAME = 'Nanachi.exe';
export const SHORTCUT_NAME = 'Nanachi.lnk';

/** Same id the main process sets with `app.setAppUserModelId`: shortcuts and the login item must match it. */
export const APP_USER_MODEL_ID = 'org.nanachi.desktop';

/** Written by the installer before it extracts, so the uninstaller and a re-install know the folder is theirs. */
export const INSTALL_MARKER = '.nanachi-install.json';

/** `Nanachi.exe --uninstall` is what the Windows "Apps" page runs. */
export const UNINSTALL_ARG = '--uninstall';

/** Per-user uninstall entry (no admin needed). */
export const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nanachi';

/** Where `app.setLoginItemSettings` keeps "Iniciar com o Windows"; the value is named `APP_USER_MODEL_ID`. */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** The payload the installer carries in its resources: `win-unpacked` as a zip, plus a small JSON about it. */
export const PAYLOAD_DIR = 'payload';
export const PAYLOAD_ZIP = 'payload.zip';
export const PAYLOAD_META = 'payload.json';

/** The daemon's data folder (`%USERPROFILE%\.nanachi-remote`): sessions, devices, config. Never an install target. */
export const DATA_DIR_NAME = '.nanachi-remote';
