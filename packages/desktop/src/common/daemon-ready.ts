import type { DaemonStatus } from './types.js';

/**
 * The PWA can be loaded: a daemon is up and it accepts calls from this PC (not Tailscale-only). The sessions view is shown
 * only then; otherwise the control center shows its own state in that place.
 */
export function daemonReady(status: Pick<DaemonStatus, 'state' | 'restricted'>): boolean {
  return (status.state === 'running' || status.state === 'attached') && !status.restricted;
}
