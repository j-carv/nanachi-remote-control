import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_VERIFIERS,
  createAgentAccounts,
  type CommandResult,
  type ProbeContext,
  resolveVerifierCommand,
  type RunCommand,
} from '../src/agent-accounts.js';
import { removeTempDir } from './temp.js';

/** JWT falso: header e assinatura inventados, só o payload importa para o verificador. */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.assinatura-falsa`;
}

const OK = (stdout: string, stderr = ''): CommandResult => ({ code: 0, stdout, stderr });

interface Fixture {
  calls: Array<{ file: string; args: readonly string[] }>;
  context(overrides?: Partial<ProbeContext>): ProbeContext;
}

/** Contexto com `run` falso: a resposta vem do mapa pela linha de argumentos (`auth status`, `login status`). */
function fixture(home: string, answers: Record<string, CommandResult | Error> = {}): Fixture {
  const calls: Fixture['calls'] = [];
  const run: RunCommand = (file, args) => {
    calls.push({ file, args });
    const answer = answers[args.join(' ')];
    if (answer === undefined) return Promise.reject(new Error('sem resposta configurada'));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  return {
    calls,
    context: (overrides = {}) => ({
      home,
      env: {},
      timeoutMs: 15_000,
      resolve: (command) => `/fake/bin/${command}`,
      run,
      ...overrides,
    }),
  };
}

describe('verificador do Claude Code (claude auth status)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'nanachi-accounts-'));
  });
  afterEach(async () => {
    await removeTempDir(home);
  });

  it('logado: e-mail como conta e organização · plano como detalhe', async () => {
    const json = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'pessoa@exemplo.com',
      orgName: 'Equipe Teste',
      subscriptionType: 'team',
    });
    const f = fixture(home, { 'auth status': OK(json) });
    const check = await ACCOUNT_VERIFIERS.claude?.(f.context());

    expect(check).toEqual({ status: 'logged_in', account: 'pessoa@exemplo.com', detail: 'Equipe Teste · team' });
    expect(f.calls).toEqual([{ file: '/fake/bin/claude', args: ['auth', 'status'] }]);
  });

  it('deslogado: logged_out sem conta, mesmo com código de saída diferente de zero', async () => {
    const f = fixture(home, { 'auth status': { code: 1, stdout: '{"loggedIn": false}', stderr: '' } });
    expect(await ACCOUNT_VERIFIERS.claude?.(f.context())).toEqual({
      status: 'logged_out',
      account: null,
      detail: null,
    });
  });

  it('saída que não é JSON vira unknown sem ecoar a saída', async () => {
    const f = fixture(home, { 'auth status': OK('token=SEGREDO-NAO-PODE-VAZAR') });
    const check = await ACCOUNT_VERIFIERS.claude?.(f.context());
    expect(check).toEqual({ status: 'unknown', account: null, detail: 'Saída inesperada' });
    expect(JSON.stringify(check)).not.toContain('SEGREDO');
  });

  it('sem comando no PATH vira unknown sem rodar nada', async () => {
    const f = fixture(home);
    const check = await ACCOUNT_VERIFIERS.claude?.(f.context({ resolve: () => undefined }));
    expect(check).toEqual({ status: 'unknown', account: null, detail: 'Comando não encontrado no PATH' });
    expect(f.calls).toEqual([]);
  });

  it('launcher .cmd não roda sem shell: unknown com motivo', async () => {
    const f = fixture(home);
    const check = await ACCOUNT_VERIFIERS.claude?.(f.context({ resolve: () => 'C:/npm/claude.cmd' }));
    expect(check).toEqual({
      status: 'unknown',
      account: null,
      detail: 'Launcher .cmd: verificação sem shell não suportada',
    });
    expect(f.calls).toEqual([]);
  });

  it('falha ao executar vira unknown genérico, sem a mensagem de erro', async () => {
    const f = fixture(home, { 'auth status': new Error('falhou com SEGREDO-NA-MENSAGEM') });
    const check = await ACCOUNT_VERIFIERS.claude?.(f.context());
    expect(check).toEqual({ status: 'unknown', account: null, detail: 'Falha ao verificar' });
    expect(JSON.stringify(check)).not.toContain('SEGREDO');
  });
});

describe('verificador do Codex (codex login status + auth.json)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'nanachi-accounts-'));
  });
  afterEach(async () => {
    await removeTempDir(home);
  });

  async function writeCodexAuth(content: unknown): Promise<void> {
    await mkdir(join(home, '.codex'), { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(home, '.codex', 'auth.json'), text);
  }

  it('ChatGPT: e-mail e plano do payload do id_token; o resto do arquivo nunca sai', async () => {
    await writeCodexAuth({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: fakeJwt({
          email: 'pessoa@exemplo.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        access_token: 'SEGREDO-ACESSO',
        refresh_token: 'SEGREDO-REFRESH',
      },
    });
    const f = fixture(home, { 'login status': OK('', 'Logged in using ChatGPT') });
    const check = await ACCOUNT_VERIFIERS.codex?.(f.context());

    expect(check).toEqual({ status: 'logged_in', account: 'pessoa@exemplo.com', detail: 'ChatGPT · plus' });
    expect(JSON.stringify(check)).not.toMatch(/SEGREDO|eyJ/);
  });

  it('ChatGPT sem auth.json legível: logado sem conta', async () => {
    const f = fixture(home, { 'login status': OK('', 'Logged in using ChatGPT') });
    expect(await ACCOUNT_VERIFIERS.codex?.(f.context())).toEqual({
      status: 'logged_in',
      account: null,
      detail: 'ChatGPT',
    });
  });

  it('auth.json malformado não vaza o conteúdo', async () => {
    await writeCodexAuth('{"tokens": SEGREDO-QUEBRADO');
    const f = fixture(home, { 'login status': OK('', 'Logged in using ChatGPT') });
    const check = await ACCOUNT_VERIFIERS.codex?.(f.context());

    expect(check).toEqual({ status: 'logged_in', account: null, detail: 'ChatGPT' });
    expect(JSON.stringify(check)).not.toContain('SEGREDO');
  });

  it('deslogado pelo status: logged_out e não lê o auth.json', async () => {
    await writeCodexAuth({ auth_mode: 'chatgpt', tokens: { id_token: fakeJwt({ email: 'velho@exemplo.com' }) } });
    const f = fixture(home, { 'login status': OK('', 'Not logged in') });
    expect(await ACCOUNT_VERIFIERS.codex?.(f.context())).toEqual({
      status: 'logged_out',
      account: null,
      detail: null,
    });
  });

  it('login por API key: detalhe fixo, sem a chave que o status pode mostrar', async () => {
    const f = fixture(home, { 'login status': OK('', 'Logged in using an API key - sk-proj-SEGREDO1234') });
    const check = await ACCOUNT_VERIFIERS.codex?.(f.context());

    expect(check).toEqual({ status: 'logged_in', account: null, detail: 'API key' });
    expect(JSON.stringify(check)).not.toContain('sk-');
  });

  it('saída desconhecida do status vira unknown', async () => {
    const f = fixture(home, { 'login status': OK('algo novo', '') });
    expect(await ACCOUNT_VERIFIERS.codex?.(f.context())).toEqual({
      status: 'unknown',
      account: null,
      detail: 'Saída inesperada',
    });
  });
});

describe('verificador do Oh My Pi (agent.db somente leitura)', () => {
  let home: string;
  let dbPath: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'nanachi-accounts-'));
    await mkdir(join(home, '.omp', 'agent'), { recursive: true });
    dbPath = join(home, '.omp', 'agent', 'agent.db');
  });
  afterEach(async () => {
    await removeTempDir(home);
  });

  /** Banco falso com as mesmas colunas do agent.db real. Dados inventados. */
  function seed(rows: Array<Record<string, unknown>>): void {
    const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL,
        disabled_cause TEXT, identity_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      const insert = db.prepare(
        `INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
         VALUES (@provider, @credential_type, @data, @disabled_cause, @identity_key, @created_at, @updated_at)`,
      );
      for (const row of rows) {
        insert.run({ disabled_cause: null, identity_key: null, created_at: 1, updated_at: 1, ...row });
      }
    } finally {
      db.close();
    }
  }

  it('logado: conta é o e-mail da credencial mais recente; detalhe lista provedores ativos', async () => {
    seed([
      { provider: 'cursor', credential_type: 'oauth', data: '{"email":"antigo@exemplo.com"}', updated_at: 100 },
      { provider: 'openrouter', credential_type: 'api_key', data: '{"key":"SEGREDO-CHAVE"}', updated_at: 150 },
      { provider: 'openai-codex', credential_type: 'oauth', data: '{"email":"novo@exemplo.com"}', updated_at: 200 },
      {
        provider: 'desativado',
        credential_type: 'oauth',
        data: '{"email":"x@exemplo.com"}',
        disabled_cause: 'expirou',
        updated_at: 300,
      },
    ]);
    const check = await ACCOUNT_VERIFIERS.omp?.(fixture(home).context());

    expect(check).toEqual({
      status: 'logged_in',
      account: 'novo@exemplo.com',
      detail: 'openai-codex · openrouter · cursor',
    });
    expect(JSON.stringify(check)).not.toMatch(/SEGREDO|desativado/);
  });

  it('só credenciais desativadas ou nenhuma: logged_out', async () => {
    seed([{ provider: 'cursor', credential_type: 'oauth', data: '{}', disabled_cause: 'revogado' }]);
    expect(await ACCOUNT_VERIFIERS.omp?.(fixture(home).context())).toEqual({
      status: 'logged_out',
      account: null,
      detail: null,
    });
  });

  it('sem agent.db: logged_out (o omp nunca foi autenticado aqui)', async () => {
    const check = await ACCOUNT_VERIFIERS.omp?.(fixture(home).context());
    expect(check).toEqual({ status: 'logged_out', account: null, detail: null });
  });

  it('data que não é JSON: provedor aparece, sem conta, sem vazar o texto', async () => {
    seed([{ provider: 'openrouter', credential_type: 'api_key', data: 'SEGREDO-NAO-JSON' }]);
    const check = await ACCOUNT_VERIFIERS.omp?.(fixture(home).context());

    expect(check).toEqual({ status: 'logged_in', account: null, detail: 'openrouter' });
    expect(JSON.stringify(check)).not.toContain('SEGREDO');
  });

  it('banco sem a tabela esperada vira unknown', async () => {
    new Database(dbPath).close();
    const check = await ACCOUNT_VERIFIERS.omp?.(fixture(home).context());
    expect(check).toEqual({ status: 'unknown', account: null, detail: 'Esquema desconhecido' });
  });
});

describe('agentes sem verificação completa', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'nanachi-accounts-'));
  });
  afterEach(async () => {
    await removeTempDir(home);
  });

  it('Antigravity: unknown, login fica no cofre do Windows', async () => {
    const check = await ACCOUNT_VERIFIERS.agy?.(fixture(home).context());
    expect(check).toMatchObject({ status: 'unknown', account: null });
    expect(check?.detail).toContain('cofre');
  });

  it('agente do config sem verificador: unknown "Sem verificação"', async () => {
    const service = createAgentAccounts({
      agents: { pi: { label: 'Pi' } },
      home,
      env: {},
      run: () => Promise.reject(new Error('não deveria rodar')),
      resolve: () => '/fake/pi',
      now: () => 1_000,
    });
    expect(await service.list()).toEqual([
      { agentId: 'pi', label: 'Pi', status: 'unknown', account: null, detail: 'Sem verificação', checkedAt: 1_000 },
    ]);
  });
});

describe('conta principal com pasta configurada (principalOf)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'nanachi-accounts-'));
  });
  afterEach(async () => {
    await removeTempDir(home);
  });

  async function writeAuth(codexHome: string, email: string): Promise<void> {
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({ tokens: { id_token: fakeJwt({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }) } }),
    );
  }

  /** Records the env of each command to see which folder the status check ran against. */
  function recordingRun(envs: Array<NodeJS.ProcessEnv>): RunCommand {
    return (_file, args, options) => {
      envs.push(options.env);
      return Promise.resolve(args[0] === 'auth' ? OK('{"loggedIn": false}') : OK('', 'Logged in using ChatGPT'));
    };
  }

  it('Codex: o e-mail vem do auth.json da pasta configurada, não de ~/.codex', async () => {
    const configured = join(home, 'codex-configurada');
    await writeAuth(join(home, '.codex'), 'padrao@exemplo.com');
    await writeAuth(configured, 'configurada@exemplo.com');
    const envs: Array<NodeJS.ProcessEnv> = [];
    const accounts = createAgentAccounts({
      agents: { codex: { label: 'Codex' } },
      home,
      env: {},
      resolve: (command) => `/fake/bin/${command}`,
      run: recordingRun(envs),
      principalOf: () => ({ home: configured, homeEnv: 'CODEX_HOME', configured: true }),
    });

    const [entry] = await accounts.list();

    expect(entry).toMatchObject({ agentId: 'codex', status: 'logged_in', account: 'configurada@exemplo.com' });
    // The status command runs against the same folder the agent uses.
    expect(envs.map((env) => env.CODEX_HOME)).toEqual([configured]);
  });

  it('pasta padrão (não configurada): lê ~/.codex e não força CODEX_HOME; uma variável herdada some do env', async () => {
    await writeAuth(join(home, '.codex'), 'padrao@exemplo.com');
    const envs: Array<NodeJS.ProcessEnv> = [];
    const accounts = createAgentAccounts({
      agents: { codex: { label: 'Codex' } },
      home,
      // The daemon env carries a leftover variable that the launcher decided to ignore.
      env: { CODEX_HOME: join(home, 'sujeira') },
      resolve: (command) => `/fake/bin/${command}`,
      run: recordingRun(envs),
      principalOf: () => ({ home: join(home, '.codex'), homeEnv: 'CODEX_HOME', configured: false }),
    });

    const [entry] = await accounts.list();

    expect(entry).toMatchObject({ account: 'padrao@exemplo.com' });
    expect(envs).toHaveLength(1);
    expect(Object.keys(envs[0] ?? {})).not.toContain('CODEX_HOME');
  });

  it('Claude: a pasta configurada vai em CLAUDE_CONFIG_DIR do comando de status', async () => {
    const configured = join(home, 'claude-configurada');
    const envs: Array<NodeJS.ProcessEnv> = [];
    const accounts = createAgentAccounts({
      agents: { claude: { label: 'Claude Code' } },
      home,
      env: {},
      resolve: (command) => `/fake/bin/${command}`,
      run: recordingRun(envs),
      principalOf: () => ({ home: configured, homeEnv: 'CLAUDE_CONFIG_DIR', configured: true }),
    });

    await accounts.list();

    expect(envs.map((env) => env.CLAUDE_CONFIG_DIR)).toEqual([configured]);
  });

  it('principalOf sem resposta (agente sem contas extras): o env fica como veio', async () => {
    const envs: Array<NodeJS.ProcessEnv> = [];
    const accounts = createAgentAccounts({
      agents: { claude: { label: 'Claude Code' } },
      home,
      env: { CLAUDE_CONFIG_DIR: join(home, 'do-daemon') },
      resolve: (command) => `/fake/bin/${command}`,
      run: recordingRun(envs),
      principalOf: () => undefined,
    });

    await accounts.list();

    expect(envs.map((env) => env.CLAUDE_CONFIG_DIR)).toEqual([join(home, 'do-daemon')]);
  });
});

describe('createAgentAccounts (lista, cache e tempo)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'nanachi-accounts-'));
  });
  afterEach(async () => {
    await removeTempDir(home);
  });

  function service(options: {
    now: { value: number };
    run: RunCommand;
    timeoutMs?: number;
    ttlMs?: number;
  }): ReturnType<typeof createAgentAccounts> {
    return createAgentAccounts({
      agents: {
        claude: { label: 'Claude Code' },
        codex: { label: 'Codex' },
        agy: { label: 'Antigravity' },
      },
      home,
      env: {},
      resolve: (command) => `/fake/bin/${command}`,
      run: options.run,
      now: () => options.now.value,
      timeoutMs: options.timeoutMs ?? 15_000,
      ttlMs: options.ttlMs ?? 5 * 60_000,
    });
  }

  function countingRun(): { run: RunCommand; count: () => number } {
    let calls = 0;
    const run: RunCommand = (_file, args) => {
      calls += 1;
      if (args[0] === 'auth') return Promise.resolve(OK('{"loggedIn": false}'));
      return Promise.resolve(OK('', 'Not logged in'));
    };
    return { run, count: () => calls };
  }

  it('devolve uma entrada por agente, na ordem do config, com label e checkedAt', async () => {
    const clock = { value: 42 };
    const accounts = await service({ now: clock, run: countingRun().run }).list();

    expect(accounts.map((a) => [a.agentId, a.label, a.checkedAt])).toEqual([
      ['claude', 'Claude Code', 42],
      ['codex', 'Codex', 42],
      ['agy', 'Antigravity', 42],
    ]);
  });

  it('cache de 5 min: segunda chamada não roda comando; passado o prazo, roda de novo', async () => {
    const clock = { value: 0 };
    const counter = countingRun();
    const svc = service({ now: clock, run: counter.run });

    await svc.list();
    const afterFirst = counter.count();
    clock.value = 4 * 60_000;
    await svc.list();
    expect(counter.count()).toBe(afterFirst);

    clock.value = 5 * 60_000 + 1;
    await svc.list();
    expect(counter.count()).toBe(afterFirst * 2);
  });

  it('refresh força a verificação mesmo dentro do cache', async () => {
    const clock = { value: 0 };
    const counter = countingRun();
    const svc = service({ now: clock, run: counter.run });

    await svc.list();
    const afterFirst = counter.count();
    const refreshed = await svc.list({ refresh: true });

    expect(counter.count()).toBe(afterFirst * 2);
    expect(refreshed[0]?.checkedAt).toBe(0);
  });

  it('chamadas simultâneas compartilham uma única verificação', async () => {
    const counter = countingRun();
    const svc = service({ now: { value: 0 }, run: counter.run });

    await Promise.all([svc.list(), svc.list(), svc.list()]);
    expect(counter.count()).toBe(2); // claude e codex; agy não roda comando
  });

  it('verificação que não responde vira unknown "Tempo esgotado" dentro do limite', async () => {
    const hanging: RunCommand = () => new Promise<CommandResult>(() => undefined);
    const accounts = await service({ now: { value: 7 }, run: hanging, timeoutMs: 30 }).list();

    expect(accounts.find((a) => a.agentId === 'claude')).toEqual({
      agentId: 'claude',
      label: 'Claude Code',
      status: 'unknown',
      account: null,
      detail: 'Tempo esgotado',
      checkedAt: 7,
    });
  });
});

describe('resolveVerifierCommand (exe nativo antes de launcher .cmd)', () => {
  let dirA: string;
  let dirB: string;
  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), 'nanachi-path-a-'));
    dirB = await mkdtemp(join(tmpdir(), 'nanachi-path-b-'));
  });
  afterEach(async () => {
    await removeTempDir(dirA);
    await removeTempDir(dirB);
  });

  it.skipIf(process.platform !== 'win32')('prefere codex.exe em outra pasta do PATH a um codex.cmd que vem antes', async () => {
    await writeFile(join(dirA, 'codex.cmd'), '@echo off');
    await writeFile(join(dirB, 'codex.exe'), '');
    const env = { PATH: `${dirA};${dirB}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

    expect(resolveVerifierCommand('codex', env, 'win32')).toBe(join(dirB, 'codex.exe'));
  });

  it.skipIf(process.platform !== 'win32')('sem exe nenhum, devolve o .cmd (quem chama recusa por causa do shell)', async () => {
    await writeFile(join(dirA, 'codex.cmd'), '@echo off');
    const env = { PATH: dirA, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

    expect(resolveVerifierCommand('codex', env, 'win32')).toBe(join(dirA, 'codex.cmd'));
  });

  it('comando ausente: undefined', () => {
    expect(resolveVerifierCommand('nao-existe-xyz', { PATH: dirA }, 'win32')).toBeUndefined();
  });
});
