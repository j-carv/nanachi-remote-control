import type { TailscaleStatus } from './types.js';

/**
 * A host on the tailnet: `<node>.<tailnet>.ts.net` (MagicDNS), labels of letters, digits and inner hyphens. The node serves
 * the PWA over HTTPS on port 443 (`packages/desktop/tsnet`), so the origin carries no port.
 */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function tailscaleHttpsOrigin(hostname: string): string | null {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  return HOSTNAME.test(host) && host.endsWith('.ts.net') ? `https://${host}` : null;
}

/** The HTTPS origin the phone uses to reach this PC, or null when the embedded node is not running. */
export function phoneOrigin(status: TailscaleStatus | null): string | null {
  return status?.state === 'running' ? tailscaleHttpsOrigin(status.dnsName) : null;
}

/**
 * The link the QR code carries: the PWA's root with the six digits in the fragment. The fragment never reaches a server or a
 * log, which is why the code is there and not in the path or the query. Null unless the code is exactly six digits.
 */
export function pairingLink(origin: string | null, code: string): string | null {
  if (origin === null || !/^\d{6}$/.test(code)) return null;
  return `${origin}/#pair=${code}`;
}
