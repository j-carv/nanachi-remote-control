import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import {
  describeError,
  describeLoopError,
  describeUsageError,
  ERROR_TEXT,
  usageNeedsResume,
} from './errorMessages.js';

describe('describeError', () => {
  it('limite de sessões ativas diz o que fazer', () => {
    expect(describeError(new ApiError('too_many_sessions', 429))).toBe(
      'Limite de 8 sessões ativas; pare alguma.',
    );
  });

  it('agente que não permite retomar pede uma sessão nova', () => {
    expect(describeError(new ApiError('not_resumable', 409))).toBe(
      'Este agente não permite retomar; abra uma sessão nova.',
    );
  });

  it('sessão já em execução tem texto próprio', () => {
    expect(describeError(new ApiError('already_running', 409))).toBe(
      'Esta sessão já está em execução.',
    );
  });

  it('arquivo acima do limite diz o tamanho máximo', () => {
    expect(describeError(new ApiError('too_large', 413))).toBe('Arquivo maior que 50 MB.');
  });

  it('pasta sem git (worktree pedido) tem texto próprio', () => {
    expect(describeError(new ApiError('not_git', 400))).toBe(
      'Esta pasta não é um repositório git.',
    );
  });

  it('repositório sem commits tem texto próprio', () => {
    expect(describeError(new ApiError('no_commits', 409))).toBe(
      'O repositório ainda não tem commits.',
    );
  });

  it('worktree sujo diz que foi mantido', () => {
    expect(describeError(new ApiError('worktree_dirty', 409))).toBe(
      'O worktree tem alterações não commitadas; ele foi mantido.',
    );
  });

  it('erro que não é ApiError vira texto genérico', () => {
    expect(describeError(new Error('x'))).toBe('Erro inesperado.');
  });

  it('todo tipo de erro tem texto (ERROR_TEXT completo)', () => {
    for (const text of Object.values(ERROR_TEXT)) expect(text.length).toBeGreaterThan(0);
  });
});

describe('describeUsageError', () => {
  it('409 session_not_active pede para retomar', () => {
    const error = new ApiError('unexpected', 409, null, 'session_not_active');
    expect(describeUsageError(error)).toBe('Retome a sessão para ver o uso.');
    expect(usageNeedsResume(error)).toBe(true);
  });

  it('409 session_busy diz para tentar quando o agente terminar', () => {
    expect(describeUsageError(new ApiError('unexpected', 409, null, 'session_busy'))).toBe(
      'O agente está ocupado; tente quando ele terminar.',
    );
  });

  it('400 usage_unsupported diz que o agente não informa uso', () => {
    expect(describeUsageError(new ApiError('invalid_input', 400, null, 'usage_unsupported'))).toBe(
      'Este agente não informa uso.',
    );
  });

  it('504 agent_timeout pede para tentar de novo', () => {
    expect(describeUsageError(new ApiError('agent_timeout', 504, null, 'agent_timeout'))).toBe(
      'O agente demorou para responder. Tente de novo.',
    );
  });

  it('qualquer 504 usa o texto de demora, mesmo sem código conhecido', () => {
    expect(describeUsageError(new ApiError('unexpected', 504))).toBe(
      'O agente demorou para responder. Tente de novo.',
    );
  });

  it('outros erros caem no texto geral (describeError)', () => {
    const error = new ApiError('network');
    expect(describeUsageError(error)).toBe(describeError(error));
    expect(describeUsageError(new ApiError('not_found', 404))).toBe(ERROR_TEXT.not_found);
    expect(describeUsageError(new Error('x'))).toBe('Erro inesperado.');
  });

  it('o texto de uso não substitui o geral: session_busy fora do uso segue genérico', () => {
    const error = new ApiError('unexpected', 409, null, 'session_busy');
    expect(describeError(error)).toBe(ERROR_TEXT.unexpected);
    expect(describeUsageError(error)).not.toBe(describeError(error));
  });

  it('só session_not_active pede retomada', () => {
    expect(usageNeedsResume(new ApiError('unexpected', 409, null, 'session_busy'))).toBe(false);
    expect(usageNeedsResume(new Error('x'))).toBe(false);
  });
});

describe('describeLoopError', () => {
  it('diz o que fazer para cada código de loop', () => {
    expect(describeLoopError(new ApiError('not_found', 404, null, 'loop_not_found'))).toBe(
      'Esta sessão não tem loop. Crie um novo.',
    );
    expect(describeLoopError(new ApiError('unexpected', 409, null, 'loop_finished'))).toBe(
      'Este loop já terminou. Crie um novo para voltar a rodar.',
    );
    expect(describeLoopError(new ApiError('unexpected', 409, null, 'loop_busy'))).toBe(
      'Uma rodada do loop está em andamento. Espere ela terminar e tente de novo.',
    );
    expect(describeLoopError(new ApiError('unexpected', 409, null, 'not_acp'))).toBe(
      'O loop só roda em sessões de agente, não em terminal.',
    );
  });

  it('sem código de loop cai no texto geral do erro', () => {
    expect(describeLoopError(new ApiError('network'))).toBe(ERROR_TEXT.network);
    expect(describeLoopError(new Error('x'))).toBe('Erro inesperado.');
  });
});
