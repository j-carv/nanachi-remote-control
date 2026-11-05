import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProbeContext, type CommandResult, type RunCommand, type RunOptions } from '../src/agent-accounts.js';
import { ACCOUNT_ADAPTERS, accountAdapterOf } from '../src/accounts/adapters.js';
import { resolveCodexLauncher, resolveBundledCodex } from '../src/accounts/codex-cli.js';
import { removeTempDir } from './temp.js';

/** JWT falso: só o payload importa para o verificador. */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.assinatura-falsa`;
}

const OK = (stdout: string, stderr = ''): CommandResult => ({ code: 0, stdout, stderr });

let root: string;
let userHome: string;
let profile: string;
let calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nanachi-adapters-'));
  userHome = join(root, 'user');
  profile = join(root, 'nanachi', 'accounts', 'codex', 'a1');
  calls = [];
});

afterEach(async () => {
  await removeTempDir(root);
});

/** Contexto com `run` falso que grava cada chamada (arquivo, argumentos e env). */
function context(answer: (args: readonly string[], options: RunOptions) => CommandResult) {
  const run: RunCommand = (file, args, options) => {
    calls.push({ file, args, env: options.env });
    return Promise.resolve(answer(args, options));
  };
  return createProbeContext({ home: userHome, env: { PATH: 'C:\\bin' }, timeoutMs: 1000, resolve: () => 'C:\\bin\\x.exe', run });
}

describe('registro de adaptadores', () => {
  it('claude e codex têm adaptador; omp, agy, shell e ids desconhecidos não', () => {
    expect(accountAdapterOf('claude')?.homeEnv).toBe('CLAUDE_CONFIG_DIR');
    expect(accountAdapterOf('codex')?.homeEnv).toBe('CODEX_HOME');
    for (const id of ['omp', 'agy', 'shell', 'toString', 'nada']) {
      expect(accountAdapterOf(id)).toBeUndefined();
    }
    expect(Object.keys(ACCOUNT_ADAPTERS).sort()).toEqual(['claude', 'codex']);
  });
});

describe('claude', () => {
  const claude = accountAdapterOf('claude');
  if (claude === undefined) throw new Error('adaptador claude ausente');

  it('principal: CLAUDE_CONFIG_DIR do env do agente quando existe; senão %USERPROFILE%\\.claude e .claude.json fora dela', () => {
    const configured = join(root, 'cfg');
    expect(claude.principal({ CLAUDE_CONFIG_DIR: configured }, userHome)).toEqual({
      home: configured,
      stateFile: join(configured, '.claude.json'),
    });
    expect(claude.principal({}, userHome)).toEqual({
      home: join(userHome, '.claude'),
      stateFile: join(userHome, '.claude.json'),
    });
    expect(claude.principal({ CLAUDE_CONFIG_DIR: '' }, userHome).home).toBe(join(userHome, '.claude'));
  });

  it('pastas e arquivos compartilhados seguem o contrato', async () => {
    expect(claude.sharedDirs).toEqual([
      'projects',
      'skills',
      'agents',
      'commands',
      'hooks',
      'plugins',
      'plans',
      'file-history',
      'todos',
      'tasks',
      'output-styles',
    ]);
    expect(claude.stateFile?.sharedKeys).toEqual(['mcpServers', 'projects', 'hasCompletedOnboarding', 'lastOnboardingVersion', 'theme']);

    const principal = join(root, 'principal');
    await mkdir(principal, { recursive: true });
    await writeFile(join(principal, 'CLAUDE.md'), 'x');
    await writeFile(join(principal, 'notes.md'), 'x');
    await writeFile(join(principal, 'file.txt'), 'x');
    await mkdir(join(principal, 'docs.md'));
    const files = await claude.sharedFiles(principal);
    expect(files).toEqual(expect.arrayContaining(['settings.json', 'keybindings.json', 'CLAUDE.md', 'notes.md']));
    expect(files).not.toContain('docs.md');
    expect(files).not.toContain('file.txt');
  });

  it('sharedFiles com principal ausente devolve só os nomes fixos', async () => {
    expect(await claude.sharedFiles(join(root, 'nao-existe'))).toEqual(['settings.json', 'keybindings.json']);
  });

  it('identidade: roda claude auth status com CLAUDE_CONFIG_DIR apontando para o perfil, sem alterar o env de quem chamou', async () => {
    const ctx = context(() => OK(JSON.stringify({ loggedIn: true, email: 'a@exemplo.com', orgName: 'Equipe', subscriptionType: 'team' })));
    const check = await claude.identity(profile, ctx);

    expect(check).toEqual({ status: 'logged_in', account: 'a@exemplo.com', detail: 'Equipe · team' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['auth', 'status']);
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(profile);
    expect(ctx.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('login: claude auth login pelo PATH, com código colado de volta, sem padrão de código', () => {
    expect(claude.login).toEqual({ command: 'claude', args: ['auth', 'login'], launcher: 'path', needsCode: true, codePattern: null });
  });
});

describe('codex', () => {
  const codex = accountAdapterOf('codex');
  if (codex === undefined) throw new Error('adaptador codex ausente');

  it('principal: CODEX_HOME do env quando existe; senão %USERPROFILE%\\.codex; sem arquivo de estado extra', () => {
    expect(codex.principal({ CODEX_HOME: join(root, 'cx') }, userHome)).toEqual({ home: join(root, 'cx') });
    expect(codex.principal({}, userHome)).toEqual({ home: join(userHome, '.codex') });
    expect(codex.stateFile).toBeUndefined();
  });

  it('pastas e arquivos compartilhados seguem o contrato', async () => {
    expect(codex.sharedDirs).toEqual([
      'sessions',
      'archived_sessions',
      'skills',
      'prompts',
      'rules',
      'memories',
      '.sandbox',
      '.sandbox-bin',
      '.sandbox-secrets',
    ]);
    expect(await codex.sharedFiles(join(root, 'qualquer'))).toEqual([
      'config.toml',
      'AGENTS.md',
      'AGENTS.override.md',
      'hooks.json',
      'cap_sid',
    ]);
  });

  it('identidade: lê o id_token de auth.json na pasta do perfil e roda codex login status com CODEX_HOME do perfil', async () => {
    await mkdir(profile, { recursive: true });
    const token = fakeJwt({ email: 'b@exemplo.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } });
    await writeFile(join(profile, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token } }));
    const ctx = context(() => OK('', 'Logged in using ChatGPT'));

    const check = await codex.identity(profile, ctx);

    expect(check).toEqual({ status: 'logged_in', account: 'b@exemplo.com', detail: 'ChatGPT · plus' });
    expect(calls[0]?.args).toEqual(['login', 'status']);
    expect(calls[0]?.env.CODEX_HOME).toBe(profile);
  });

  it('login: codex bundled, login --device-auth, sem código colado, com o padrão do código do dispositivo', () => {
    expect(codex.login.command).toBe('codex');
    expect(codex.login.args).toEqual(['login', '--device-auth']);
    expect(codex.login.launcher).toBe('bundled-codex');
    expect(codex.login.needsCode).toBe(false);
    const pattern = codex.login.codePattern;
    expect(pattern).not.toBeNull();
    expect('expires in 15 minutes: 0HKH-0YU99'.match(pattern ?? /$^/)?.[0]).toBe('0HKH-0YU99');
    expect('https://auth.openai.com/codex/device'.match(pattern ?? /$^/)).toBeNull();
  });
});

describe('codex-cli', () => {
  it('o codex empacotado existe e é o codex.js do pacote @openai/codex', () => {
    const bundled = resolveBundledCodex();
    expect(bundled.endsWith(join('@openai', 'codex', 'bin', 'codex.js'))).toBe(true);
  });

  it('sem CODEX_PATH roda o codex empacotado com o node atual; CODEX_PATH vence', () => {
    const bundled = resolveBundledCodex();
    expect(resolveCodexLauncher({})).toEqual({ file: process.execPath, prefixArgs: [bundled] });
    expect(resolveCodexLauncher({ CODEX_PATH: '' })).toEqual({ file: process.execPath, prefixArgs: [bundled] });
    expect(resolveCodexLauncher({ CODEX_PATH: 'C:\\codex\\codex.exe' })).toEqual({
      file: 'C:\\codex\\codex.exe',
      prefixArgs: [],
    });
  });
});
