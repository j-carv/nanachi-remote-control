import type { SessionCounts } from '../machineOverview.js';

/*
 * What a workspace row shows about its sessions: how many run and how many wait for the user's permission. Idle
 * sessions, and stopped or failed ones, are not shown on the row.
 */

export type ActivityKind = 'running' | 'awaiting';

export interface ActivityPart {
  readonly kind: ActivityKind;
  readonly count: number;
}

/**
 * The parts a workspace row shows under its name: only the counts above zero, running first, then awaiting. Empty when
 * neither is above zero, so the row has no status line at all.
 */
export function activityParts(counts: Pick<SessionCounts, 'running' | 'awaiting'>): ActivityPart[] {
  const parts: ActivityPart[] = [];
  if (counts.running > 0) parts.push({ kind: 'running', count: counts.running });
  if (counts.awaiting > 0) parts.push({ kind: 'awaiting', count: counts.awaiting });
  return parts;
}
