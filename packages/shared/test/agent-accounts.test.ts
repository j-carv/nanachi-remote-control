import { describe, expect, it } from 'vitest';
import {
  AccountLoginCodeRequestSchema,
  AccountLoginStateSchema,
  ActiveAccountResponseSchema,
  AgentAccountSchema,
  AgentAccountsResponseSchema,
  AgentProfileSchema,
  CreateAgentAccountRequestSchema,
  CreateSessionRequestSchema,
  RenameAgentAccountRequestSchema,
  SetActiveAccountRequestSchema,
  SetSessionAccountRequestSchema,
} from '../src/index.js';

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
    expect(AgentAccountSchema.parse(valid)).toEqual({ ...valid, supportsAccounts: false, profiles: [] });
  });

  it('aceita account e detail nulos (deslogado ou sem dado)', () => {
    const loggedOut = { ...valid, status: 'logged_out', account: null, detail: null };
    expect(AgentAccountSchema.parse(loggedOut)).toEqual({ ...loggedOut, supportsAccounts: false, profiles: [] });
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

describe('AgentProfileSchema e contas com perfis', () => {
  const principal = {
    id: 'default',
    label: 'Principal',
    isDefault: true,
    active: true,
    status: 'logged_in',
    account: 'pessoa@exemplo.com',
    detail: 'Equipe · team',
    checkedAt: 1_700_000_000_000,
  };

  it('aceita um perfil com identidade verificada e um perfil deslogado sem dados', () => {
    expect(AgentProfileSchema.parse(principal)).toEqual(principal);
    const loggedOut = { ...principal, id: 'a1', label: 'Trabalho', isDefault: false, active: false, status: 'logged_out', account: null, detail: null };
    expect(AgentProfileSchema.parse(loggedOut)).toEqual(loggedOut);
  });

  it('recusa id ou label vazio e status fora do conjunto', () => {
    expect(AgentProfileSchema.safeParse({ ...principal, id: '' }).success).toBe(false);
    expect(AgentProfileSchema.safeParse({ ...principal, label: '' }).success).toBe(false);
    expect(AgentProfileSchema.safeParse({ ...principal, status: 'expired' }).success).toBe(false);
  });

  it('AgentAccountSchema aplica padrão: supportsAccounts false e profiles vazio (respostas antigas continuam válidas)', () => {
    const account = {
      agentId: 'agy',
      label: 'Antigravity',
      status: 'unknown',
      account: null,
      detail: 'Sem verificação',
      checkedAt: 1,
    };
    expect(AgentAccountSchema.parse(account)).toEqual({ ...account, supportsAccounts: false, profiles: [] });
  });

  it('AgentAccountSchema lê supportsAccounts e profiles quando vêm', () => {
    const account = {
      agentId: 'claude',
      label: 'Claude Code',
      status: 'logged_in',
      account: 'pessoa@exemplo.com',
      detail: null,
      checkedAt: 1,
      supportsAccounts: true,
      profiles: [principal],
    };
    expect(AgentAccountSchema.parse(account)).toEqual(account);
    expect(AgentAccountSchema.safeParse({ ...account, profiles: [{ ...principal, id: '' }] }).success).toBe(false);
  });
});

describe('requests de contas', () => {
  it('CreateAgentAccountRequestSchema e RenameAgentAccountRequestSchema recortam o label e limitam a 40 caracteres', () => {
    for (const schema of [CreateAgentAccountRequestSchema, RenameAgentAccountRequestSchema]) {
      expect(schema.parse({ label: '  Trabalho  ' })).toEqual({ label: 'Trabalho' });
      expect(schema.parse({ label: 'a'.repeat(40) })).toEqual({ label: 'a'.repeat(40) });
      expect(schema.safeParse({ label: '   ' }).success).toBe(false);
      expect(schema.safeParse({ label: '' }).success).toBe(false);
      expect(schema.safeParse({ label: 'a'.repeat(41) }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });

  it('SetActiveAccountRequestSchema e SetSessionAccountRequestSchema exigem accountId não vazio', () => {
    for (const schema of [SetActiveAccountRequestSchema, SetSessionAccountRequestSchema]) {
      expect(schema.parse({ accountId: 'default' })).toEqual({ accountId: 'default' });
      expect(schema.safeParse({ accountId: '' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });

  it('ActiveAccountResponseSchema devolve só o accountId', () => {
    expect(ActiveAccountResponseSchema.parse({ accountId: 'a1' })).toEqual({ accountId: 'a1' });
    expect(ActiveAccountResponseSchema.safeParse({}).success).toBe(false);
  });

  it('CreateSessionRequestSchema aceita accountId opcional e recusa vazio', () => {
    const base = { workspaceId: 'w-1', agent: 'claude' };
    expect(CreateSessionRequestSchema.parse(base)).toEqual(base);
    expect(CreateSessionRequestSchema.parse({ ...base, accountId: 'a1' })).toEqual({ ...base, accountId: 'a1' });
    expect(CreateSessionRequestSchema.safeParse({ ...base, accountId: '' }).success).toBe(false);
  });
});

describe('AccountLoginStateSchema', () => {
  const waiting = {
    accountId: 'a1',
    state: 'waiting',
    url: 'https://claude.com/cai/oauth/authorize?code=true',
    userCode: null,
    needsCode: true,
    codeSent: false,
    output: "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true",
    error: null,
    account: null,
  };

  it('accepts each of the six states', () => {
    for (const state of ['starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled']) {
      expect(AccountLoginStateSchema.parse({ ...waiting, state }).state).toBe(state);
    }
  });

  it('rejects a state outside the set', () => {
    expect(AccountLoginStateSchema.safeParse({ ...waiting, state: 'done' }).success).toBe(false);
  });

  it('accepts null url, userCode, error and account and an empty output (a login that just started)', () => {
    const starting = { ...waiting, state: 'starting', url: null, userCode: null, output: '' };
    expect(AccountLoginStateSchema.parse(starting)).toEqual(starting);
  });

  it('accepts the Codex code and the e-mail of the connected account', () => {
    const codex = { ...waiting, url: 'https://auth.openai.com/codex/device', userCode: '0HKH-0YU99', needsCode: false };
    expect(AccountLoginStateSchema.parse(codex)).toEqual(codex);
    const done = { ...waiting, state: 'succeeded', account: 'pessoa@exemplo.com', codeSent: true };
    expect(AccountLoginStateSchema.parse(done)).toEqual(done);
    const failed = { ...waiting, state: 'failed', error: 'o login falhou (código 1)' };
    expect(AccountLoginStateSchema.parse(failed)).toEqual(failed);
  });

  it('rejects an empty url, userCode, error or account (null is how to say there is none)', () => {
    for (const field of ['url', 'userCode', 'error', 'account']) {
      expect(AccountLoginStateSchema.safeParse({ ...waiting, [field]: '' }).success).toBe(false);
    }
  });

  it('requires every field and a non-empty accountId', () => {
    for (const field of Object.keys(waiting)) {
      const { [field]: _removed, ...rest } = waiting as Record<string, unknown>;
      expect(AccountLoginStateSchema.safeParse(rest).success).toBe(false);
    }
    expect(AccountLoginStateSchema.safeParse({ ...waiting, accountId: '' }).success).toBe(false);
  });
});

describe('AccountLoginCodeRequestSchema', () => {
  it('accepts a code pasted from Claude (with # and other symbols)', () => {
    const code = 'AbC123-_xyz#Qw9Er8Ty7';
    expect(AccountLoginCodeRequestSchema.parse({ code })).toEqual({ code });
  });

  it('accepts 1 to 2000 characters and rejects empty and above 2000', () => {
    expect(AccountLoginCodeRequestSchema.safeParse({ code: 'a' }).success).toBe(true);
    expect(AccountLoginCodeRequestSchema.safeParse({ code: 'a'.repeat(2000) }).success).toBe(true);
    expect(AccountLoginCodeRequestSchema.safeParse({ code: '' }).success).toBe(false);
    expect(AccountLoginCodeRequestSchema.safeParse({ code: 'a'.repeat(2001) }).success).toBe(false);
  });

  it('rejects control characters: line break, tab, ESC, NUL, DEL and C1', () => {
    for (const code of ['abc\n', 'abc\r', 'a\tb', 'abc\u001b[31m', 'a\u0000b', 'a\u007fb', 'a\u0085b']) {
      expect(AccountLoginCodeRequestSchema.safeParse({ code }).success).toBe(false);
    }
  });

  it('requires the code field as text', () => {
    expect(AccountLoginCodeRequestSchema.safeParse({}).success).toBe(false);
    expect(AccountLoginCodeRequestSchema.safeParse({ code: 123 }).success).toBe(false);
  });
});
