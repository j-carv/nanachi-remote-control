import { describe, expect, it } from 'vitest';
import type { AgentSessionSummary } from '@nanachi/shared';
import { ApiError } from './api.js';
import {
  appendListing,
  conflictSessionId,
  resumableAgents,
  sessionAgeText,
} from './resume.js';

function local(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function summary(acpSessionId: string, title: string | null, updatedAt: number | null): AgentSessionSummary {
  return { acpSessionId, title, updatedAt, linkedSessionId: null };
}

describe('resumableAgents', () => {
  it('fica só com agentes ACP (terminal não lista sessões)', () => {
    const agents = [
      { id: 'omp', label: 'Oh My Pi', kind: 'acp' as const },
      { id: 'agy', label: 'Antigravity', kind: 'pty' as const },
      { id: 'claude', label: 'Claude Code', kind: 'acp' as const },
    ];
    expect(resumableAgents(agents).map((agent) => agent.id)).toEqual(['omp', 'claude']);
  });

  it('lista vazia continua vazia', () => {
    expect(resumableAgents([])).toEqual([]);
  });
});

describe('sessionAgeText', () => {
  it('tempo relativo quando há data', () => {
    const now = local(2026, 11, 3, 12, 0);
    expect(sessionAgeText(local(2026, 11, 3, 11, 30), now)).toBe('há 30 min');
  });

  it('sem data não mostra nada', () => {
    expect(sessionAgeText(null, local(2026, 11, 3, 12, 0))).toBeNull();
  });
});

describe('conflictSessionId', () => {
  it('409 already_running: devolve a sessão aberta para abrir', () => {
    expect(conflictSessionId(new ApiError('already_running', 409, 's-7'))).toBe('s-7');
  });

  it('409 already_linked: devolve a sessão parada para abrir e retomar', () => {
    expect(conflictSessionId(new ApiError('already_linked', 409, 's-8'))).toBe('s-8');
  });

  it('conflito sem sessionId não dá o que abrir', () => {
    expect(conflictSessionId(new ApiError('already_linked', 409, null))).toBeNull();
  });

  it('outros erros (incluindo busy e agent_timeout) não viram abertura', () => {
    expect(conflictSessionId(new ApiError('busy', 429))).toBeNull();
    expect(conflictSessionId(new ApiError('agent_timeout', 504))).toBeNull();
    expect(conflictSessionId(new Error('boom'))).toBeNull();
    expect(conflictSessionId(null)).toBeNull();
  });
});

describe('appendListing', () => {
  it('junta a página seguinte no fim, na ordem recebida', () => {
    const first = [summary('a', 'A', 1), summary('b', 'B', 2)];
    const next = [summary('c', 'C', 3)];
    expect(appendListing(first, next).map((item) => item.acpSessionId)).toEqual(['a', 'b', 'c']);
  });

  it('não repete a mesma sessão vinda de duas páginas', () => {
    const first = [summary('a', 'A', 1)];
    const next = [summary('a', 'A', 1), summary('b', 'B', 2)];
    expect(appendListing(first, next).map((item) => item.acpSessionId)).toEqual(['a', 'b']);
  });
});
