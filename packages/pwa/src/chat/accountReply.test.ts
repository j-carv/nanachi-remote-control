import type { Session } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { applyAccountReply } from './accountReply.js';

const SESSION: Session = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'claude',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'idle',
  accountId: null,
  worktree: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe('applyAccountReply', () => {
  it('takes the account and the other fields from the reply', () => {
    const reply: Session = { ...SESSION, accountId: 'a-1', title: 'Renomeada', updatedAt: 1_700_000_005_000 };
    expect(applyAccountReply(SESSION, reply)).toMatchObject({
      accountId: 'a-1',
      title: 'Renomeada',
      updatedAt: 1_700_000_005_000,
    });
  });

  it('keeps the status the live connection reported, even when the reply is older', () => {
    const live: Session = { ...SESSION, status: 'running' };
    const reply: Session = { ...SESSION, status: 'idle', accountId: 'a-1' };
    expect(applyAccountReply(live, reply)).toEqual({ ...reply, status: 'running' });
  });

  it('keeps a stopped or error status too (the WS decides when the agent is back)', () => {
    for (const status of ['stopped', 'error', 'starting', 'awaiting_permission'] as const) {
      expect(applyAccountReply({ ...SESSION, status }, { ...SESSION, accountId: 'a-1' }).status).toBe(status);
    }
  });

  it('does not change the objects it was given', () => {
    const live: Session = { ...SESSION, status: 'running' };
    const reply: Session = { ...SESSION, accountId: 'a-1' };
    applyAccountReply(live, reply);
    expect(live.status).toBe('running');
    expect(reply.status).toBe('idle');
  });
});
