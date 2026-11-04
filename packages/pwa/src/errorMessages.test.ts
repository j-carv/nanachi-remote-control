import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { describeError, ERROR_TEXT } from './errorMessages.js';

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
