import { describe, expect, it } from 'vitest';
import { setLanguage } from './i18n/index.js';
import type { Session, SessionStatus } from '@nanachi/shared';
import { removalConfirmText, removalInterruptNotice, visibleSessions } from './sessionRemoval.js';
import { countSessions } from './machineOverview.js';

function session(id: string, updatedAt: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: 'w-1',
    agent: 'omp',
    kind: 'acp',
    title: id,
    status: 'idle',
    accountId: null,
    worktree: null,
    createdAt: 1_700_000_000_000,
    updatedAt,
    ...overrides,
  };
}

describe('removalConfirmText', () => {
  it('usa o texto combinado com o nome do agente', () => {
    expect(removalConfirmText('Oh My Pi')).toBe(
      'Remover esta sessão do app? O histórico continua no Oh My Pi e você pode trazê-la de volta em Retomar do PC.',
    );
  });
});

describe('removalInterruptNotice', () => {
  it.each<[SessionStatus, string]>([
    ['running', 'A sessão está trabalhando. Remover agora interrompe o trabalho.'],
    ['awaiting_permission', 'A sessão está esperando sua permissão. Remover agora interrompe o trabalho.'],
    ['starting', 'A sessão está iniciando. Remover agora interrompe o início.'],
  ])('status %s avisa que será interrompida', (status, text) => {
    expect(removalInterruptNotice(status)).toBe(text);
  });

  it.each<SessionStatus>(['idle', 'stopped', 'error'])('status %s não avisa', (status) => {
    expect(removalInterruptNotice(status)).toBeNull();
  });
});

describe('visibleSessions', () => {
  it('junta a lista do servidor com os broadcasts (o broadcast vence) e ordena pelo mais recente', () => {
    const loaded = [session('a', 1), session('b', 3)];
    const live = { a: session('a', 5, { status: 'running' }), c: session('c', 2) };

    const result = visibleSessions(loaded, live, new Set());

    expect(result.map((item) => [item.id, item.updatedAt, item.status])).toEqual([
      ['a', 5, 'running'],
      ['b', 3, 'idle'],
      ['c', 2, 'idle'],
    ]);
  });

  it('some com as sessões removidas, mesmo que o servidor ou um broadcast ainda as traga', () => {
    const loaded = [session('a', 1), session('b', 2)];
    const live = { a: session('a', 3) };

    expect(visibleSessions(loaded, live, new Set(['a'])).map((item) => item.id)).toEqual(['b']);
  });

  it('hides loaded and live automation runs while retaining ordinary rows and counts', () => {
    const loaded = [
      session('running', 3, { status: 'running' }),
      session('idle', 2),
      session('scheduled-loaded', 10, { automationRunId: 'run-loaded', status: 'running' }),
    ];
    const live = {
      waiting: session('waiting', 1, { status: 'awaiting_permission' }),
      scheduled: session('scheduled-live', 11, { automationRunId: 'run-live', status: 'awaiting_permission' }),
    };

    const shown = visibleSessions(loaded, live, new Set());

    expect(shown.map((item) => item.id)).toEqual(['waiting', 'running', 'idle']);
    expect(countSessions(shown)).toEqual({ running: 1, awaiting: 1, idle: 1 });
  });

  it('removes a loaded ordinary row and its count when a live message identifies it as an automation run', () => {
    const loaded = [
      session('becomes-scheduled', 10, { status: 'awaiting_permission' }),
      session('ordinary', 2, { status: 'running' }),
    ];
    const before = visibleSessions(loaded, {}, new Set());
    expect(before.map((item) => item.id)).toEqual(['becomes-scheduled', 'ordinary']);
    expect(countSessions(before)).toEqual({ running: 1, awaiting: 1, idle: 0 });

    const shown = visibleSessions(loaded, {
      'becomes-scheduled': session('becomes-scheduled', 11, { automationRunId: 'run', status: 'awaiting_permission' }),
      ordinary: session('ordinary', 12, { status: 'idle' }),
    }, new Set());

    expect(shown.map((item) => [item.id, item.status])).toEqual([['ordinary', 'idle']]);
    expect(countSessions(shown)).toEqual({ running: 0, awaiting: 0, idle: 1 });
  });

  it('does not reinsert a loaded automation run through an ordinary live snapshot', () => {
    const loaded = [session('scheduled', 10, { automationRunId: 'run', status: 'running' })];
    const live = { scheduled: session('scheduled', 9, { status: 'idle' }) };

    expect(visibleSessions(loaded, live, new Set())).toEqual([]);
    expect(loaded[0]?.automationRunId).toBe('run');
    expect(live.scheduled.automationRunId).toBeUndefined();
  });

  it('lista vazia e nada removido devolve lista vazia', () => {
    expect(visibleSessions([], {}, new Set())).toEqual([]);
  });

  it('puts approvals before errors and sorts each group by recency', () => {
    const loaded = [
      session('idle', 10),
      session('old-error', 1, { status: 'error' }),
      session('waiting', 2, { status: 'awaiting_permission' }),
      session('new-error', 5, { status: 'error' }),
    ];
    expect(visibleSessions(loaded, {}, new Set()).map((item) => item.id))
      .toEqual(['waiting', 'new-error', 'old-error', 'idle']);
  });
});

describe('removal texts in English', () => {
  it('the confirmation names the agent', () => {
    setLanguage('en');
    expect(removalConfirmText('Oh My Pi')).toBe(
      'Remove this session from the app? The history stays in Oh My Pi, and you can bring it back from Resume from PC.',
    );
  });

  it('the notice depends on what the session is doing', () => {
    setLanguage('en');
    expect(removalInterruptNotice('running')).toBe('The session is working. Removing it now interrupts the work.');
    expect(removalInterruptNotice('awaiting_permission')).toBe(
      'The session is waiting for your permission. Removing it now interrupts the work.',
    );
    expect(removalInterruptNotice('starting')).toBe('The session is starting. Removing it now interrupts the start.');
    expect(removalInterruptNotice('idle')).toBeNull();
  });
});
