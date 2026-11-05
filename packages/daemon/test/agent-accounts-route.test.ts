import { AgentAccountsResponseSchema, type AgentAccount } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import type { AgentAccountsService, PrincipalAccount } from '../src/agent-accounts.js';
import { authHeader } from './agent-support.js';
import { setupDaemonTests } from './support.js';

/** Principal, como o verificador a devolve (sem os campos de perfis, que o serviço acrescenta). */
const ACCOUNTS: PrincipalAccount[] = [
  {
    agentId: 'claude',
    label: 'Claude Code',
    status: 'logged_in',
    account: 'pessoa@exemplo.com',
    detail: 'Equipe · team',
    checkedAt: 1_700_000_000_000,
  },
  { agentId: 'agy', label: 'Antigravity', status: 'unknown', account: null, detail: 'Sem verificação', checkedAt: 1 },
];

/** Serviço falso: registra cada chamada e devolve ACCOUNTS. */
function recordingService(): { service: AgentAccountsService; calls: Array<{ refresh: boolean }> } {
  const calls: Array<{ refresh: boolean }> = [];
  return {
    calls,
    service: {
      list(options) {
        calls.push({ refresh: options?.refresh === true });
        return Promise.resolve(ACCOUNTS);
      },
    },
  };
}

/** Resposta esperada: a principal mais `supportsAccounts` e `profiles` (só a principal, sem contas extras). */
const EXPECTED: AgentAccount[] = [
  {
    agentId: 'claude',
    label: 'Claude Code',
    status: 'logged_in',
    account: 'pessoa@exemplo.com',
    detail: 'Equipe · team',
    checkedAt: 1_700_000_000_000,
    supportsAccounts: true,
    profiles: [
      {
        id: 'default',
        label: 'Principal',
        isDefault: true,
        active: true,
        status: 'logged_in',
        account: 'pessoa@exemplo.com',
        detail: 'Equipe · team',
        checkedAt: 1_700_000_000_000,
      },
    ],
  },
  {
    agentId: 'agy',
    label: 'Antigravity',
    status: 'unknown',
    account: null,
    detail: 'Sem verificação',
    checkedAt: 1,
    supportsAccounts: false,
    profiles: [],
  },
];

describe('GET /api/agents/accounts', () => {
  const env = setupDaemonTests();

  it('exige Bearer de dispositivo', async () => {
    const daemon = await env.start({ agentAccounts: recordingService().service });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/agents/accounts' });
    expect(res.statusCode).toBe(401);
  });

  it('devolve as contas no formato do shared, sem refresh por padrão', async () => {
    const recorder = recordingService();
    const daemon = await env.start({ agentAccounts: recorder.service });
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/agents/accounts',
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(200);
    expect(AgentAccountsResponseSchema.parse(res.json<unknown>())).toEqual({ accounts: EXPECTED });
    expect(recorder.calls).toEqual([{ refresh: false }]);
  });

  it('?refresh=1 força a verificação', async () => {
    const recorder = recordingService();
    const daemon = await env.start({ agentAccounts: recorder.service });
    await daemon.app.inject({
      method: 'GET',
      url: '/api/agents/accounts?refresh=1',
      headers: await authHeader(daemon),
    });

    expect(recorder.calls).toEqual([{ refresh: true }]);
  });
});
