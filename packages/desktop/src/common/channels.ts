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
} as const;

/** One synchronous call at preload time: app version and the machine to seed. Answered from memory only. */
export const SYNC_CHANNELS = {
  init: 'desktop:preload-init',
} as const;

export const ALLOWED_INVOKE_CHANNELS: ReadonlySet<string> = new Set(Object.values(INVOKE_CHANNELS));
export const ALLOWED_EVENT_CHANNELS: ReadonlySet<string> = new Set(Object.values(EVENT_CHANNELS));
export const ALLOWED_SYNC_CHANNELS: ReadonlySet<string> = new Set(Object.values(SYNC_CHANNELS));
