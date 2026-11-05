import { describe, expect, it } from 'vitest';
import { setLanguage } from './i18n/index.js';
import type { Session, SessionStatus } from '@nanachi/shared';
import { removalConfirmText, removalInterruptNotice, visibleSessions } from './sessionRemoval.js';

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

  it('lista vazia e nada removido devolve lista vazia', () => {
    expect(visibleSessions([], {}, new Set())).toEqual([]);
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
