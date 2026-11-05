import {
  AccountLoginCodeRequestSchema,
  CreateAgentAccountRequestSchema,
  RenameAgentAccountRequestSchema,
  SetActiveAccountRequestSchema,
  type AccountLoginState,
  type ActiveAccountResponse,
  type AgentAccountsResponse,
} from '@nanachi/shared';
import type { FastifyInstance } from 'fastify';
import type { AccountsService } from './service.js';

interface AgentParams {
  agent: string;
}

interface AccountParams extends AgentParams {
  accountId: string;
}

/**
 * Rotas de contas de agente (PLAN.md, várias contas por agente). Vão dentro do escopo autenticado de `/api`. Erros saem
 * como `ApiError` (o handler do servidor responde `{ error: <codigo> }`).
 */
export function registerAccountRoutes(api: FastifyInstance, accounts: AccountsService): void {
  api.get<{ Querystring: { refresh?: unknown } }>('/api/agents/accounts', async (request) => {
    const body: AgentAccountsResponse = {
      accounts: await accounts.list({ refresh: request.query.refresh === '1' }),
    };
    return body;
  });

  api.post<{ Params: AgentParams }>('/api/agents/:agent/accounts', async (request, reply) => {
    const parsed = CreateAgentAccountRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const profile = await accounts.create(request.params.agent, parsed.data.label);
    return reply.code(201).send(profile);
  });

  // Antes de `/:accountId`: `active` não é um id de conta.
  api.put<{ Params: AgentParams }>('/api/agents/:agent/accounts/active', async (request, reply) => {
    const parsed = SetActiveAccountRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body: ActiveAccountResponse = { accountId: await accounts.setActive(request.params.agent, parsed.data.accountId) };
    return body;
  });

  api.patch<{ Params: AccountParams }>('/api/agents/:agent/accounts/:accountId', async (request, reply) => {
    const parsed = RenameAgentAccountRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return accounts.rename(request.params.agent, request.params.accountId, parsed.data.label);
  });

  api.delete<{ Params: AccountParams }>('/api/agents/:agent/accounts/:accountId', async (request, reply) => {
    await accounts.remove(request.params.agent, request.params.accountId);
    return reply.code(204).send();
  });

  // Account login (accounts/login.ts). `default` is the principal account.
  api.post<{ Params: AccountParams }>('/api/agents/:agent/accounts/:accountId/login', async (request): Promise<AccountLoginState> => {
    return accounts.startLogin(request.params.agent, request.params.accountId);
  });

  api.get<{ Params: AccountParams }>('/api/agents/:agent/accounts/:accountId/login', async (request): Promise<AccountLoginState> => {
    return accounts.loginState(request.params.agent, request.params.accountId);
  });

  api.delete<{ Params: AccountParams }>('/api/agents/:agent/accounts/:accountId/login', async (request, reply) => {
    await accounts.cancelLogin(request.params.agent, request.params.accountId);
    return reply.code(204).send();
  });

  api.post<{ Params: AccountParams }>('/api/agents/:agent/accounts/:accountId/login/code', async (request, reply) => {
    const parsed = AccountLoginCodeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return accounts.sendLoginCode(request.params.agent, request.params.accountId, parsed.data.code);
  });
}
