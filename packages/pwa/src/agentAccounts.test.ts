import { describe, expect, it } from 'vitest';
import { accountView, checkedText, LOGIN_HELP } from './agentAccounts.js';

describe('accountView', () => {
  it('logado: "Logado", verde, sem ajuda', () => {
    expect(accountView({ status: 'logged_in' })).toEqual({ statusLabel: 'Logado', tone: 'ok', help: null });
  });

  it('deslogado: "Deslogado", amarelo, com a ajuda de login no terminal', () => {
    expect(accountView({ status: 'logged_out' })).toEqual({
      statusLabel: 'Deslogado',
      tone: 'warn',
      help: 'Faça login no terminal do PC (ex.: claude, codex login, agy).',
    });
    expect(LOGIN_HELP).toBe('Faça login no terminal do PC (ex.: claude, codex login, agy).');
  });

  it('não verificado: cinza, sem ajuda (o detalhe da conta explica o motivo)', () => {
    expect(accountView({ status: 'unknown' })).toEqual({ statusLabel: 'Não verificado', tone: 'muted', help: null });
  });
});

describe('checkedText', () => {
  const now = 1_700_000_000_000;

  it('usa o tempo relativo do app', () => {
    expect(checkedText(now - 2 * 60_000, now)).toBe('Verificado há 2 min');
    expect(checkedText(now, now)).toBe('Verificado agora');
  });
});
