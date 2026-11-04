import { describe, expect, it } from 'vitest';
import { AgentAccountSchema, AgentAccountsResponseSchema } from '../src/index.js';

describe('AgentAccountSchema', () => {
  const valid = {
    agentId: 'claude',
    label: 'Claude Code',
    status: 'logged_in',
    account: 'pessoa@exemplo.com',
    detail: 'Equipe · team',
    checkedAt: 1_700_000_000_000,
  };

  it('aceita uma conta verificada', () => {
    expect(AgentAccountSchema.parse(valid)).toEqual(valid);
  });

  it('aceita account e detail nulos (deslogado ou sem dado)', () => {
    const loggedOut = { ...valid, status: 'logged_out', account: null, detail: null };
    expect(AgentAccountSchema.parse(loggedOut)).toEqual(loggedOut);
  });

  it('aceita os três estados', () => {
    for (const status of ['logged_in', 'logged_out', 'unknown']) {
      expect(AgentAccountSchema.parse({ ...valid, status }).status).toBe(status);
    }
  });

  it('recusa status fora do conjunto', () => {
    expect(AgentAccountSchema.safeParse({ ...valid, status: 'expired' }).success).toBe(false);
  });

  it('recusa checkedAt que não é inteiro não negativo', () => {
    expect(AgentAccountSchema.safeParse({ ...valid, checkedAt: -1 }).success).toBe(false);
    expect(AgentAccountSchema.safeParse({ ...valid, checkedAt: 1.5 }).success).toBe(false);
  });

  it('recusa agentId vazio', () => {
    expect(AgentAccountSchema.safeParse({ ...valid, agentId: '' }).success).toBe(false);
  });
});

describe('AgentAccountsResponseSchema', () => {
  it('aceita lista vazia e lista com contas', () => {
    expect(AgentAccountsResponseSchema.parse({ accounts: [] })).toEqual({ accounts: [] });
    const account = {
      agentId: 'agy',
      label: 'Antigravity',
      status: 'unknown',
      account: null,
      detail: 'Sem verificação',
      checkedAt: 1,
    };
    expect(AgentAccountsResponseSchema.parse({ accounts: [account] }).accounts).toHaveLength(1);
  });

  it('recusa corpo sem accounts', () => {
    expect(AgentAccountsResponseSchema.safeParse({}).success).toBe(false);
  });
});
