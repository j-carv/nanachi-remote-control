/**
 * The only IPC channels the panel window may use. The preload bundle repeats nothing: it imports this file at
 * build time, and `main/ipc.ts` registers exactly these. A channel that is not here does not exist.
 */
export const INVOKE_CHANNELS = {
  status: 'desktop:status',
  pairingCode: 'desktop:pairing-code',
  getAutostart: 'desktop:get-autostart',
  setAutostart: 'desktop:set-autostart',
  tailscaleStatus: 'desktop:tailscale-status',
  tailscaleStart: 'desktop:tailscale-start',
  tailscaleStop: 'desktop:tailscale-stop',
  checkForUpdate: 'desktop:check-for-update',
} as const;

/** Main to renderer events. */
export const EVENT_CHANNELS = {
  status: 'desktop:status-changed',
  tailscaleStatus: 'desktop:tailscale-status-changed',
  /** Desktop's language changed: the PWA switches at once, without a reload. */
  language: 'desktop:language-changed',
} as const;

/** One synchronous call at preload time: app version and the machine to seed. Answered from memory only. */
export const SYNC_CHANNELS = {
  init: 'desktop:preload-init',
} as const;

export const ALLOWED_INVOKE_CHANNELS: ReadonlySet<string> = /* @__PURE__ */ new Set(/* @__PURE__ */ Object.values(INVOKE_CHANNELS));
export const ALLOWED_EVENT_CHANNELS: ReadonlySet<string> = /* @__PURE__ */ new Set(/* @__PURE__ */ Object.values(EVENT_CHANNELS));
export const ALLOWED_SYNC_CHANNELS: ReadonlySet<string> = /* @__PURE__ */ new Set(/* @__PURE__ */ Object.values(SYNC_CHANNELS));

/**
 * The only IPC channels the control center window may use. They are separate from the panel's (`desktop:*`) on purpose:
 * the PWA panel never gets the control API, and the control center never gets the panel's bridge. `main/control-ipc.ts`
 * registers exactly these, behind a check that the sender is the control window's own page.
 */
export const CONTROL_INVOKE_CHANNELS = {
  windowMinimize: 'control:window-minimize',
  windowToggleMaximize: 'control:window-toggle-maximize',
  windowClose: 'control:window-close',
  windowState: 'control:window-state',
  overview: 'control:overview',
  restartDaemon: 'control:restart-daemon',
  openDataFolder: 'control:open-data-folder',
  sessionsViewport: 'control:sessions-viewport',
  foldersGet: 'control:folders-get',
  foldersPick: 'control:folders-pick',
  foldersSave: 'control:folders-save',
  foldersReveal: 'control:folders-reveal',
  devicesList: 'control:devices-list',
  devicesRevoke: 'control:devices-revoke',
  devicesPairingCode: 'control:devices-pairing-code',
  accountsList: 'control:accounts-list',
  accountsSetActive: 'control:accounts-set-active',
  tailscaleStatus: 'control:tailscale-status',
  tailscaleStart: 'control:tailscale-start',
  tailscaleStop: 'control:tailscale-stop',
  tailscaleOpenLogin: 'control:tailscale-open-login',
  logsGet: 'control:logs-get',
  logsOpenFolder: 'control:logs-open-folder',
  settingsSetLanguage: 'control:settings-set-language',
  settingsGetAutostart: 'control:settings-get-autostart',
  settingsSetAutostart: 'control:settings-set-autostart',
  settingsCheckForUpdate: 'control:settings-check-for-update',
  settingsOpenUpdate: 'control:settings-open-update',
  settingsUninstall: 'control:settings-uninstall',
} as const;

/** Main to control center events. */
export const CONTROL_EVENT_CHANNELS = {
  windowState: 'control:window-state-changed',
  navigate: 'control:navigate',
  language: 'control:language-changed',
  sessionsView: 'control:sessions-view-changed',
  daemonStatus: 'control:daemon-status-changed',
  tailscaleStatus: 'control:tailscale-status-changed',
} as const;

/** One synchronous call at preload time (the app version and Desktop's language). Answered from memory, and only to the control window. */
export const CONTROL_SYNC_CHANNELS = {
  init: 'control:preload-init',
} as const;

export const ALLOWED_CONTROL_INVOKE_CHANNELS: ReadonlySet<string> = /* @__PURE__ */ new Set(/* @__PURE__ */ Object.values(CONTROL_INVOKE_CHANNELS));
export const ALLOWED_CONTROL_EVENT_CHANNELS: ReadonlySet<string> = /* @__PURE__ */ new Set(/* @__PURE__ */ Object.values(CONTROL_EVENT_CHANNELS));
export const ALLOWED_CONTROL_SYNC_CHANNELS: ReadonlySet<string> = /* @__PURE__ */ new Set(/* @__PURE__ */ Object.values(CONTROL_SYNC_CHANNELS));
