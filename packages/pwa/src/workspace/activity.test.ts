import { describe, expect, it } from 'vitest';
import type { SessionCounts } from '../machineOverview.js';
import { activityParts } from './activity.js';

describe('activityParts', () => {
  it('has nothing to show when no session runs and none waits for the user', () => {
    const counts: SessionCounts = { running: 0, awaiting: 0, idle: 0 };
    expect(activityParts(counts)).toEqual([]);
  });

  it('leaves idle sessions out: a workspace of ready sessions shows no line', () => {
    const counts: SessionCounts = { running: 0, awaiting: 0, idle: 5 };
    expect(activityParts(counts)).toEqual([]);
  });

  it('shows the running count alone when only sessions run', () => {
    expect(activityParts({ running: 2, awaiting: 0 })).toEqual([{ kind: 'running', count: 2 }]);
  });

  it('shows the awaiting count alone when only a session waits for permission', () => {
    expect(activityParts({ running: 0, awaiting: 1 })).toEqual([{ kind: 'awaiting', count: 1 }]);
  });

  it('keeps the running part before the awaiting one when both are there', () => {
    expect(activityParts({ running: 1, awaiting: 3 })).toEqual([
      { kind: 'running', count: 1 },
      { kind: 'awaiting', count: 3 },
    ]);
  });
});
