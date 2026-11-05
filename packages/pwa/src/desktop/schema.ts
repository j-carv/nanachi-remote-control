import { z } from 'zod';

/**
 * What Nanachi Desktop's preload bridge (`window.nanachiDesktop`) sends the page. The Electron side validates what
 * goes in; the page validates what comes back, so a malformed answer never reaches a component. Shapes mirror
 * `packages/desktop/src/common/types.ts`; this package never imports from Electron or from the desktop package.
 */

/** A link the page renders: only https, so a `javascript:` URL can never become an `href`. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const httpsUrl = z.string().refine(isHttpsUrl, 'https only');

export const daemonStatusSchema = z.object({
  /** `starting` while a spawned daemon does not answer yet; `attached` when one already answered. */
  state: z.enum(['starting', 'running', 'attached', 'stopped', 'error']),
  port: z.number().int().min(1).max(65535),
  /** Who owns the process: Desktop spawned it, it was already there, or nothing runs. */
  mode: z.enum(['spawned', 'attached', 'none']),
  pid: z.number().int().nullable(),
  version: z.string().nullable(),
  machineName: z.string().nullable(),
  /** The daemon answers but refuses requests from this PC that do not come through Tailscale. */
  restricted: z.boolean(),
  message: z.string().nullable(),
  /** Last lines of the daemon log, filled when `state` is `error`. */
  logTail: z.array(z.string()),
});
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export const pairingCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  /** Epoch ms. */
  expiresAt: z.number(),
});
export type PairingCode = z.infer<typeof pairingCodeSchema>;

export const updateCheckSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('up-to-date'), current: z.string() }),
  z.object({ status: z.literal('available'), current: z.string(), latest: z.string(), url: httpsUrl }),
  z.object({ status: z.literal('error'), current: z.string(), message: z.string() }),
]);
export type UpdateCheckResult = z.infer<typeof updateCheckSchema>;

export const tailscaleStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('off') }),
  z.object({ state: z.literal('starting') }),
  z.object({ state: z.literal('needs_login'), authUrl: httpsUrl }),
  z.object({
    state: z.literal('running'),
    dnsName: z.string().min(1),
    tailnet: z.string(),
    ips: z.array(z.string()),
  }),
  z.object({ state: z.literal('error'), message: z.string() }),
]);
export type TailscaleStatus = z.infer<typeof tailscaleStatusSchema>;

function parser<T>(schema: z.ZodType<T>): (value: unknown) => T | null {
  return (value) => {
    const result = schema.safeParse(value);
    return result.success ? result.data : null;
  };
}

export const parseDaemonStatus = parser(daemonStatusSchema);
export const parsePairingCode = parser(pairingCodeSchema);
export const parseUpdateCheck = parser(updateCheckSchema);
export const parseTailscaleStatus = parser(tailscaleStatusSchema);
