import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentAccountsResponseSchema, AgentProfileSchema, type AgentAccount, type AgentProfile } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import type { AgentAccountsService } from '../src/agent-accounts.js';
import type { CommandResult, RunCommand } from '../src/agent-accounts.js';
import type { AccountRuntime } from '../src/accounts/service.js';
import { findSessionById, insertSession } from '../src/repository.js';
import { authHeader } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';

const OK = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });

/** Principal falsa: só o que `GET /api/agents/accounts` lê dela (a verificação real não roda no teste). */
const PRINCIPAL: AgentAccount[] = [
  { agentId: 'claude', label: 'Claude Code', status: 'logged_in', account: 'principal@exemplo.com', detail: null, checkedAt: 1, supportsAccounts: false, profiles: [] },
  { agentId: 'codex', label: 'Codex', status: 'logged_out', account: null, detail: null, checkedAt: 1, supportsAccounts: false, profiles: [] },
  { agentId: 'omp', label: 'Oh My Pi', status: 'unknown', account: null, detail: 'Sem verificação', checkedAt: 1, supportsAccounts: false, profiles: [] },
];

const principalService: AgentAccountsService = {
  list: () => Promise.resolve(PRINCIPAL.map(({ supportsAccounts: _s, profiles: _p, ...rest }) => rest)),
};

interface Probe {
  calls: Array<{ file: string; args: readonly string[]; home: string | undefined }>;
  run: RunCommand;
}

/** Marcador que o teste põe na pasta de um perfil para fingir que a conta dele está logada. */
const LOGGED_IN_MARKER = 'logged-in.marker';

/**
 * `claude auth status` responde pela pasta do perfil (CLAUDE_CONFIG_DIR): com o marcador, logado com e-mail; sem ele,
 * deslogado. Nada de processo de verdade.
 */
function fakeProbe(): Probe {
  const calls: Probe['calls'] = [];
  return {
    calls,
    run: (file, args, options) => {
      const home = options.env.CLAUDE_CONFIG_DIR;
      calls.push({ file, args, home });
      if (home !== undefined && existsSync(join(home, LOGGED_IN_MARKER))) {
        return Promise.resolve(OK(JSON.stringify({ loggedIn: true, email: 'trabalho@exemplo.com', orgName: 'Empresa' })));
      }
      return Promise.resolve(OK(JSON.stringify({ loggedIn: false })));
    },
  };
}

function runtimeWith(probe: Probe, extra: Partial<AccountRuntime> = {}): AccountRuntime {
  return { resolve: () => 'C:\\fake\\claude.exe', run: probe.run, ...extra };
}

/** Config com as pastas principais dentro do NANACHI_HOME do teste (nunca o %USERPROFILE% real). */
function configFor(home: string): Record<string, unknown> {
  return {
    agents: {
      claude: { label: 'Claude Code', command: 'claude-agent-acp', env: { CLAUDE_CONFIG_DIR: join(home, 'principal-claude') } },
      codex: { label: 'Codex', command: 'codex-acp', env: { CODEX_HOME: join(home, 'principal-codex') } },
    },
  };
}

describe('contas de agente: rotas', () => {
  const env = setupDaemonTests();

  async function start(probe: Probe = fakeProbe(), runtime: Partial<AccountRuntime> = {}): Promise<TestDaemon> {
    // The principal folders exist, as they do on a PC where the agents have run: Nanachi never creates them.
    await mkdir(join(env.home, 'principal-claude'), { recursive: true });
    await mkdir(join(env.home, 'principal-codex'), { recursive: true });
    return env.start({
      config: configFor(env.home),
      agentAccounts: principalService,
      accountRuntime: runtimeWith(probe, { userHome: join(env.home, 'user-home'), ...runtime }),
    });
  }

  async function listAccounts(daemon: TestDaemon, query = ''): Promise<AgentAccount[]> {
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/agents/accounts${query}`,
      headers: await authHeader(daemon),
    });
    expect(res.statusCode).toBe(200);
    return AgentAccountsResponseSchema.parse(res.json<unknown>()).accounts;
  }

  function profilesOf(accounts: AgentAccount[], agentId: string): AgentProfile[] {
    return accounts.find((account) => account.agentId === agentId)?.profiles ?? [];
  }

  it('GET: supportsAccounts por agente; principal primeiro com id default; agente sem conta extra não tem perfis', async () => {
    const daemon = await start();
    const accounts = await listAccounts(daemon);

    expect(accounts.find((a) => a.agentId === 'claude')?.supportsAccounts).toBe(true);
    expect(accounts.find((a) => a.agentId === 'codex')?.supportsAccounts).toBe(true);
    expect(accounts.find((a) => a.agentId === 'omp')?.supportsAccounts).toBe(false);
    expect(accounts.find((a) => a.agentId === 'omp')?.profiles).toEqual([]);
    expect(profilesOf(accounts, 'claude')).toEqual([
      {
        id: 'default',
        label: 'Principal',
        isDefault: true,
        active: true,
        status: 'logged_in',
        account: 'principal@exemplo.com',
        detail: null,
        checkedAt: 1,
      },
    ]);
  });

  it('GET: a identidade de cada conta extra vem da pasta dela, com cache de 5 min; ?refresh=1 verifica de novo', async () => {
    const probe = fakeProbe();
    const daemon = await start(probe);
    const created = await daemon.app.inject({
      method: 'POST',
      url: '/api/agents/claude/accounts',
      headers: await authHeader(daemon),
      payload: { label: '  Trabalho  ' },
    });
    expect(created.statusCode).toBe(201);
    const profile = AgentProfileSchema.parse(created.json<unknown>());
    expect(profile).toMatchObject({ label: 'Trabalho', isDefault: false, active: false, status: 'logged_out', account: null });

    const first = await listAccounts(daemon);
    expect(profilesOf(first, 'claude').find((p) => p.id === profile.id)).toMatchObject({ status: 'logged_out', account: null });
    const callsAfterFirst = probe.calls.length;

    // A conta entra (o marcador aparece na pasta dela): até o cache vencer, a lista ainda mostra o valor antigo.
    await writeFile(join(profileFolder(profile.id), LOGGED_IN_MARKER), '');
    expect(profilesOf(await listAccounts(daemon), 'claude').find((p) => p.id === profile.id)).toMatchObject({ status: 'logged_out' });
    expect(probe.calls.length).toBe(callsAfterFirst);

    const refreshed = await listAccounts(daemon, '?refresh=1');
    expect(profilesOf(refreshed, 'claude').find((p) => p.id === profile.id)).toMatchObject({
      status: 'logged_in',
      account: 'trabalho@exemplo.com',
      detail: 'Empresa',
    });
    expect(probe.calls.every((call) => call.file === 'C:\\fake\\claude.exe')).toBe(true);
  });

  function profileFolder(id: string): string {
    return join(env.home, 'accounts', 'claude', id);
  }

  it('POST: cria a pasta do perfil com as junções, 201 com status logged_out; nome vazio é 400', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);

    const empty = await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: '   ' } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: 'invalid_request' });

    const res = await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: 'Pessoal' } });
    expect(res.statusCode).toBe(201);
    const profile = AgentProfileSchema.parse(res.json<unknown>());
    expect(profile).toMatchObject({ label: 'Pessoal', status: 'logged_out', account: null, detail: null, active: false });

    const home = join(env.home, 'accounts', 'claude', profile.id);
    expect((await lstat(join(home, 'projects'))).isSymbolicLink()).toBe(true);
    expect((await stat(join(env.home, 'principal-claude', 'plans'))).isDirectory()).toBe(true);
  });

  it('POST: codex cria a pasta com as junções do Codex; agente desconhecido é 404; sem contas extras é 400', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);

    const codex = await daemon.app.inject({ method: 'POST', url: '/api/agents/codex/accounts', headers, payload: { label: 'Codex 2' } });
    expect(codex.statusCode).toBe(201);
    const id = AgentProfileSchema.parse(codex.json<unknown>()).id;
    expect((await lstat(join(env.home, 'accounts', 'codex', id, 'sessions'))).isSymbolicLink()).toBe(true);

    const unknown = await daemon.app.inject({ method: 'POST', url: '/api/agents/nao-existe/accounts', headers, payload: { label: 'x' } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });

    const omp = await daemon.app.inject({ method: 'POST', url: '/api/agents/omp/accounts', headers, payload: { label: 'x' } });
    expect(omp.statusCode).toBe(400);
    expect(omp.json()).toEqual({ error: 'accounts_unsupported' });
  });

  it('POST: pasta principal inexistente não é criada; o perfil nasce sem junções', async () => {
    const daemon = await start();
    await rm(join(env.home, 'principal-claude'), { recursive: true });
    const headers = await authHeader(daemon);

    const res = await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: 'Pessoal' } });

    expect(res.statusCode).toBe(201);
    const profile = AgentProfileSchema.parse(res.json<unknown>());
    expect(existsSync(join(env.home, 'principal-claude'))).toBe(false);
    expect(existsSync(join(env.home, 'accounts', 'claude', profile.id))).toBe(true);
    expect(existsSync(join(env.home, 'accounts', 'claude', profile.id, 'projects'))).toBe(false);
  });

  it('POST: criações simultâneas não passam do limite de 10 (as outras são 409)', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);

    const replies = await Promise.all(
      Array.from({ length: 14 }, (_, i) =>
        daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: `c${i}` } }),
      ),
    );

    expect(replies.filter((reply) => reply.statusCode === 201)).toHaveLength(10);
    expect(replies.filter((reply) => reply.statusCode === 409).map((reply) => reply.json<unknown>())).toEqual(
      Array.from({ length: 4 }, () => ({ error: 'too_many_accounts' })),
    );
    const listed = profilesOf(await listAccounts(daemon), 'claude');
    expect(listed.filter((profile) => !profile.isDefault)).toHaveLength(10);
  });

  it('POST: mais de 10 contas extras por agente é 409 too_many_accounts', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);
    for (let i = 0; i < 10; i++) {
      const res = await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: `c${i}` } });
      expect(res.statusCode).toBe(201);
    }
    const res = await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: 'extra' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'too_many_accounts' });
  });

  it('PATCH: renomeia; default é 400; conta desconhecida é 404', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);
    const created = AgentProfileSchema.parse(
      (await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: 'antes' } })).json<unknown>(),
    );

    const renamed = await daemon.app.inject({
      method: 'PATCH',
      url: `/api/agents/claude/accounts/${created.id}`,
      headers,
      payload: { label: 'depois' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(AgentProfileSchema.parse(renamed.json<unknown>()).label).toBe('depois');

    const principal = await daemon.app.inject({ method: 'PATCH', url: '/api/agents/claude/accounts/default', headers, payload: { label: 'x' } });
    expect(principal.statusCode).toBe(400);
    expect(principal.json()).toEqual({ error: 'invalid_request' });

    const missing = await daemon.app.inject({ method: 'PATCH', url: '/api/agents/claude/accounts/nope', headers, payload: { label: 'x' } });
    expect(missing.statusCode).toBe(404);
  });

  it('PUT active: default e contas existentes; desconhecida é 404; a lista mostra a ativa', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);
    const created = AgentProfileSchema.parse(
      (await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: 'Trabalho' } })).json<unknown>(),
    );

    const set = await daemon.app.inject({
      method: 'PUT',
      url: '/api/agents/claude/accounts/active',
      headers,
      payload: { accountId: created.id },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ accountId: created.id });

    const accounts = await listAccounts(daemon);
    expect(profilesOf(accounts, 'claude').find((p) => p.id === created.id)?.active).toBe(true);
    expect(profilesOf(accounts, 'claude').find((p) => p.id === 'default')?.active).toBe(false);

    const back = await daemon.app.inject({ method: 'PUT', url: '/api/agents/claude/accounts/active', headers, payload: { accountId: 'default' } });
    expect(back.statusCode).toBe(200);
    expect(profilesOf(await listAccounts(daemon), 'claude').find((p) => p.id === 'default')?.active).toBe(true);

    const missing = await daemon.app.inject({ method: 'PUT', url: '/api/agents/claude/accounts/active', headers, payload: { accountId: 'nope' } });
    expect(missing.statusCode).toBe(404);

    const omp = await daemon.app.inject({ method: 'PUT', url: '/api/agents/omp/accounts/active', headers, payload: { accountId: 'default' } });
    expect(omp.statusCode).toBe(400);
    expect(omp.json()).toEqual({ error: 'accounts_unsupported' });
  });

  it('DELETE: default é 400; desconhecida é 404; com sessão viva na conta é 409 account_in_use', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);
    const created = AgentProfileSchema.parse(
      (await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: 'Trabalho' } })).json<unknown>(),
    );
    insertSession(daemon.db, { id: 's-live', workspaceId: 'w-1', agent: 'claude', title: 't', status: 'idle', createdAt: 1, accountId: created.id });

    const busy = await daemon.app.inject({ method: 'DELETE', url: `/api/agents/claude/accounts/${created.id}`, headers });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: 'account_in_use' });

    const principal = await daemon.app.inject({ method: 'DELETE', url: '/api/agents/claude/accounts/default', headers });
    expect(principal.statusCode).toBe(400);
    const missing = await daemon.app.inject({ method: 'DELETE', url: '/api/agents/claude/accounts/nope', headers });
    expect(missing.statusCode).toBe(404);
  });

  it('DELETE: 204 remove a linha, a pasta do perfil e o ponteiro; as sessões da conta voltam à principal; o principal fica intacto', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);
    const created = AgentProfileSchema.parse(
      (await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', headers, payload: { label: 'Trabalho' } })).json<unknown>(),
    );
    const folder = join(env.home, 'accounts', 'claude', created.id);
    await writeFile(join(env.home, 'principal-claude', 'projects', 'historico.jsonl'), 'do principal');
    await mkdir(join(folder, 'privado'), { recursive: true });
    await writeFile(join(folder, 'privado', 'token.json'), 'privado');
    await daemon.app.inject({ method: 'PUT', url: '/api/agents/claude/accounts/active', headers, payload: { accountId: created.id } });
    insertSession(daemon.db, { id: 's-old', workspaceId: 'w-1', agent: 'claude', title: 't', status: 'stopped', createdAt: 1, accountId: created.id });

    const res = await daemon.app.inject({ method: 'DELETE', url: `/api/agents/claude/accounts/${created.id}`, headers });

    expect(res.statusCode).toBe(204);
    expect(profilesOf(await listAccounts(daemon), 'claude').map((p) => p.id)).toEqual(['default']);
    await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(env.home, 'principal-claude', 'projects', 'historico.jsonl'), 'utf8')).toBe('do principal');
    expect(findSessionById(daemon.db, 's-old')?.accountId).toBeNull();
    const active = await daemon.app.inject({ method: 'PUT', url: '/api/agents/claude/accounts/active', headers, payload: { accountId: 'default' } });
    expect(active.statusCode).toBe(200);
  });

  it('exige Bearer de dispositivo nas rotas novas', async () => {
    const daemon = await start();
    const res = await daemon.app.inject({ method: 'POST', url: '/api/agents/claude/accounts', payload: { label: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});
