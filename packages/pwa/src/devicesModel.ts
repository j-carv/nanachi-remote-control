import type { DevicesResponse } from '@nanachi/shared';

/** One device of `GET /api/devices`. */
export type Device = DevicesResponse['devices'][number];

/** When the device was last used, or when it was created if it never was. */
function lastActivity(device: Device): number {
  return device.lastSeenAt ?? device.createdAt;
}

/**
 * The list order: devices that still have access first, then the expired ones. Inside each group, the most recent use
 * first (the current device, which just used the API, is therefore at the top of its group). Returns a new array.
 */
export function sortDevices(devices: readonly Device[]): Device[] {
  return [...devices].sort((a, b) => {
    if (a.expired !== b.expired) return a.expired ? 1 : -1;
    return lastActivity(b) - lastActivity(a);
  });
}

/**
 * Whether the devices screen offers Revogar for this device: only another device that still has access. This device is
 * forgotten from the machine's own menu, and an expired device has no access left to revoke.
 */
export function canRevoke(device: Device): boolean {
  return !device.current && !device.expired;
}
