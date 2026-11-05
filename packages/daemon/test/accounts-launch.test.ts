import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentConfig } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountRemovingError,
  AccountSelectionError,
  createAccountLauncher,
  type AccountLauncher,
} from '../src/accounts/launch.js';
import { openDatabase } from '../src/db.js';
import { insertAgentProfile, setActiveAccountId } from '../src/repository.js';
import { removeTempDir } from './temp.js';

/*
 * AccountLauncher (accounts/launch.ts): que conta cada sessão usa, o env que aponta o agente para a pasta do perfil e o
 * preparo dessa pasta. Só pastas temporárias: a principal vem do env do agente do config (nunca o %USERPROFILE% real).
 */

let dir: string;
let db: Database.Database;
let nanachiHome: string;
let userHome: string;
let warnings: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-launch-'));
  db = openDatabase(join(dir, 'data.db'));
  nanachiHome = join(dir, 'nanachi');
  userHome = join(dir, 'user');
  warnings = [];
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

function agent(env: Record<string, string> = {}, kind: AgentConfig['kind'] = 'acp'): AgentConfig {
  return { label: 'Fake', command: 'fake', args: [], env, kind };
}

function launcherWith(agents: Record<string, AgentConfig>, daemonEnv: NodeJS.ProcessEnv = {}): AccountLauncher {
  return createAccountLauncher({
    db,
    agents,
    nanachiHome,
    userHome,
    daemonEnv,
    log: (message) => warnings.push(message),
  });
}

function addAccount(agentId: string, id: string, label = `Conta ${id}`): void {
  insertAgentProfile(db, { id, agent: agentId, label, createdAt: 1 });
}

describe('AccountLauncher.choose', () => {
  it('agente sem contas extras: ausente e default são a principal; outra conta é accounts_unsupported', () => {
    const launcher = launcherWith({ omp: agent() });

    expect(launcher.choose('omp', undefined)).toBeNull();
    expect(launcher.choose('omp', 'default')).toBeNull();
    expect(() => launcher.choose('omp', 'qualquer')).toThrow(AccountSelectionError);
    try {
      launcher.choose('omp', 'qualquer');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'accounts_unsupported' });
    }
  });

  it('agente de terminal com id de harness também não tem contas extras', () => {
    const launcher = launcherWith({ claude: agent({}, 'pty') });
    addAccount('claude', 'a');

    expect(launcher.choose('claude', undefined)).toBeNull();
    expect(() => launcher.choose('claude', 'a')).toThrow(/não tem contas extras/);
  });

  it('com adaptador: ausente vira a conta ativa; default é a principal; conta conhecida passa', () => {
    const launcher = launcherWith({ claude: agent() });
    addAccount('claude', 'a');
    addAccount('claude', 'b');

    expect(launcher.choose('claude', undefined)).toBeNull();
    setActiveAccountId(db, 'claude', 'b');
    expect(launcher.choose('claude', undefined)).toBe('b');
    expect(launcher.choose('claude', 'default')).toBeNull();
    expect(launcher.choose('claude', 'a')).toBe('a');
    expect(warnings).toEqual([]);
  });

  it('conta desconhecida, ou de outro agente, é invalid_request', () => {
    const launcher = launcherWith({ claude: agent(), codex: agent() });
    addAccount('codex', 'so-do-codex');

    for (const requested of ['fantasma', 'so-do-codex']) {
      try {
        launcher.choose('claude', requested);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AccountSelectionError);
        expect(error).toMatchObject({ code: 'invalid_request' });
      }
    }
  });

  it('ponteiro de conta ativa que aponta para conta inexistente cai na principal, com aviso', () => {
    const launcher = launcherWith({ claude: agent() });
    setActiveAccountId(db, 'claude', 'sumiu');

    expect(launcher.choose('claude', undefined)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('sumiu');
  });
});

describe('AccountLauncher.effective e labelOf', () => {
  it('conta gravada que existe vale; principal fica principal', () => {
    const launcher = launcherWith({ claude: agent() });
    addAccount('claude', 'a', 'Trabalho');

    expect(launcher.effective('claude', null)).toBeNull();
    expect(launcher.effective('claude', 'a')).toBe('a');
    expect(warnings).toEqual([]);
    expect(launcher.labelOf('claude', 'a')).toBe('Trabalho');
    expect(launcher.labelOf('claude', null)).toBe('Principal');
  });

  it('conta removida ou desconhecida cai na principal com aviso no log (sem lançar)', () => {
    const launcher = launcherWith({ claude: agent(), omp: agent() });

    expect(launcher.effective('claude', 'removida')).toBeNull();
    expect(warnings.some((message) => message.includes('removida'))).toBe(true);
    expect(launcher.effective('omp', 'qualquer')).toBeNull();
    expect(warnings).toHaveLength(2);
  });
});

describe('AccountLauncher.env', () => {
  it('principal e agente sem adaptador não trazem variável; conta extra aponta para a pasta do perfil', () => {
    const launcher = launcherWith({ claude: agent(), codex: agent(), omp: agent() });

    expect(launcher.env('claude', null)).toEqual({});
    expect(launcher.env('omp', 'qualquer')).toEqual({});
    expect(launcher.env('claude', 'a')).toEqual({ CLAUDE_CONFIG_DIR: join(nanachiHome, 'accounts', 'claude', 'a') });
    expect(launcher.env('codex', 'b')).toEqual({ CODEX_HOME: join(nanachiHome, 'accounts', 'codex', 'b') });
  });
});

describe('AccountLauncher.prepare', () => {
  async function principalClaude(): Promise<string> {
    const home = join(dir, 'principal-claude');
    await mkdir(join(home, 'skills'), { recursive: true });
    await writeFile(join(home, 'settings.json'), '{"model":"opus"}');
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ theme: 'dark', oauthAccount: { emailAddress: 'principal@exemplo.com' } }),
    );
    return home;
  }

  it('principal e agente sem adaptador: nada é criado', async () => {
    const launcher = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: join(dir, 'principal-claude') }), omp: agent() });

    await launcher.prepare('claude', null);
    await launcher.prepare('omp', 'qualquer');

    expect(existsSync(join(dir, 'principal-claude'))).toBe(false);
    expect(existsSync(nanachiHome)).toBe(false);
  });

  it('conta extra: junção para as pastas da principal do env do agente, arquivos copiados e .claude.json mesclado', async () => {
    const principal = await principalClaude();
    const launcher = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: principal }) });
    const profile = join(nanachiHome, 'accounts', 'claude', 'a');

    await launcher.prepare('claude', 'a');

    expect((await lstat(join(profile, 'skills'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(profile, 'settings.json'), 'utf8')).toBe('{"model":"opus"}');
    const state: unknown = JSON.parse(await readFile(join(profile, '.claude.json'), 'utf8'));
    expect(state).toEqual({ theme: 'dark' });
  });

  it('sem CLAUDE_CONFIG_DIR no config nem no env do daemon, a principal é a pasta do usuário', async () => {
    const launcher = launcherWith({ claude: agent() });
    // A pasta principal já existe (o próprio Claude a criou): as pastas compartilhadas que faltam nela são criadas.
    await mkdir(join(userHome, '.claude'), { recursive: true });
    await writeFile(join(userHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));

    await launcher.prepare('claude', 'a');

    const profile = join(nanachiHome, 'accounts', 'claude', 'a');
    expect(JSON.parse(await readFile(join(profile, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true });
    expect(existsSync(join(userHome, '.claude', 'projects'))).toBe(true);
  });

  it('preparos simultâneos da mesma conta não brigam (um por vez) e repetir é idempotente', async () => {
    const principal = await principalClaude();
    const launcher = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: principal }) });

    await Promise.all(Array.from({ length: 6 }, () => launcher.prepare('claude', 'a')));
    await launcher.prepare('claude', 'a');

    const profile = join(nanachiHome, 'accounts', 'claude', 'a');
    expect((await lstat(join(profile, 'projects'))).isSymbolicLink()).toBe(true);
  });

  it('uma falha não trava a fila: o preparo seguinte roda (e falha por conta própria)', async () => {
    // `accounts` é um arquivo comum: criar a pasta do perfil dentro dele falha.
    await mkdir(nanachiHome, { recursive: true });
    await writeFile(join(nanachiHome, 'accounts'), 'arquivo');
    const launcher = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: join(dir, 'principal-claude') }) });

    await expect(launcher.prepare('claude', 'a')).rejects.toThrow();
    await expect(launcher.prepare('claude', 'a')).rejects.toThrow();
  });
});

describe('AccountLauncher: pasta principal', () => {
  const accountsRoot = (): string => join(nanachiHome, 'accounts');

  it('principalOf: pasta absoluta, com o arquivo de estado dentro dela quando CLAUDE_CONFIG_DIR está definido', () => {
    const relative = 'principal-relativa';
    const launcher = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: relative }), codex: agent(), omp: agent() });

    expect(launcher.principalOf('claude')).toEqual({
      home: resolve(relative),
      stateFile: join(resolve(relative), '.claude.json'),
      homeEnv: 'CLAUDE_CONFIG_DIR',
      configured: true,
    });
    expect(launcher.principalOf('codex')).toEqual({ home: join(userHome, '.codex'), stateFile: undefined, homeEnv: 'CODEX_HOME', configured: false });
    expect(launcher.principalOf('omp')).toBeUndefined();
  });

  it('principalOf: sem variável, a principal do Claude é ~/.claude e ~/.claude.json', () => {
    const launcher = launcherWith({ claude: agent() });

    expect(launcher.principalOf('claude')).toEqual({
      home: join(userHome, '.claude'),
      stateFile: join(userHome, '.claude.json'),
      homeEnv: 'CLAUDE_CONFIG_DIR',
      configured: false,
    });
  });

  it('o env do agente vale sobre o do daemon', () => {
    const launcher = launcherWith(
      { claude: agent({ CLAUDE_CONFIG_DIR: join(dir, 'do-agente') }) },
      { CLAUDE_CONFIG_DIR: join(dir, 'do-daemon') },
    );

    expect(launcher.principalOf('claude')?.home).toBe(join(dir, 'do-agente'));
  });

  it('CLAUDE_CONFIG_DIR do env do daemon dentro de accounts é ignorado (aviso uma vez) e a principal volta ao padrão', () => {
    const polluted = join(accountsRoot(), 'claude', 'abc');
    const launcher = launcherWith({ claude: agent() }, { CLAUDE_CONFIG_DIR: polluted });

    expect(launcher.principalOf('claude')).toEqual({
      home: join(userHome, '.claude'),
      stateFile: join(userHome, '.claude.json'),
      homeEnv: 'CLAUDE_CONFIG_DIR',
      configured: false,
    });
    launcher.principalOf('claude');
    launcher.env('claude', null);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CLAUDE_CONFIG_DIR');
    expect(warnings[0]).toContain(polluted);
  });

  it('o mesmo vale para o env do agente, e para CODEX_HOME', () => {
    const claudeLauncher = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: join(accountsRoot(), 'claude', 'abc') }) });
    expect(claudeLauncher.principalOf('claude')?.home).toBe(join(userHome, '.claude'));

    const codexLauncher = launcherWith({ codex: agent() }, { CODEX_HOME: join(accountsRoot(), 'codex', 'x', '..', 'y') });
    expect(codexLauncher.principalOf('codex')).toEqual({ home: join(userHome, '.codex'), stateFile: undefined, homeEnv: 'CODEX_HOME', configured: false });
  });

  it('variável suja no env do agente com variável boa no env do daemon: vale a do daemon', () => {
    const launcher = launcherWith(
      { claude: agent({ CLAUDE_CONFIG_DIR: join(accountsRoot(), 'claude', 'abc') }) },
      { CLAUDE_CONFIG_DIR: join(dir, 'boa') },
    );

    expect(launcher.principalOf('claude')).toMatchObject({ home: join(dir, 'boa'), configured: true });
    expect(launcher.env('claude', null)).toEqual({ CLAUDE_CONFIG_DIR: join(dir, 'boa') });
  });

  it('só dentro de accounts é sujo: a própria pasta accounts conta, uma pasta irmã com o mesmo prefixo não', () => {
    const sibling = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: `${accountsRoot()}-outra` }) });
    expect(sibling.principalOf('claude')).toMatchObject({ home: `${accountsRoot()}-outra`, configured: true });
    expect(warnings).toEqual([]);

    const root = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: accountsRoot() }) });
    expect(root.principalOf('claude')?.home).toBe(join(userHome, '.claude'));
  });

  it('env da principal: vazio quando está limpo; a variável some (undefined) quando estava suja', () => {
    const clean = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: join(dir, 'boa') }) });
    expect(Object.keys(clean.env('claude', null))).toEqual([]);

    const dirty = launcherWith({ claude: agent() }, { CLAUDE_CONFIG_DIR: join(accountsRoot(), 'claude', 'abc') });
    const env = dirty.env('claude', null);
    expect(Object.hasOwn(env, 'CLAUDE_CONFIG_DIR')).toBe(true);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it.skipIf(process.platform !== 'win32')('Windows: a grafia da variável não importa (Claude_Config_Dir)', () => {
    const launcher = launcherWith({ claude: agent() }, { Claude_Config_Dir: join(accountsRoot(), 'claude', 'abc') });

    expect(launcher.principalOf('claude')?.home).toBe(join(userHome, '.claude'));
    expect(warnings).toHaveLength(1);

    const good = launcherWith({ claude: agent() }, { claude_config_dir: join(dir, 'boa') });
    expect(good.principalOf('claude')).toMatchObject({ home: join(dir, 'boa'), configured: true });
  });

  it('com a variável suja, o preparo liga o perfil à pasta padrão, nunca a ele mesmo', async () => {
    await mkdir(join(userHome, '.claude', 'projects'), { recursive: true });
    await writeFile(join(userHome, '.claude', 'projects', 'p.jsonl'), 'principal');
    const profile = join(accountsRoot(), 'claude', 'a');
    const launcher = launcherWith({ claude: agent() }, { CLAUDE_CONFIG_DIR: profile });

    await launcher.prepare('claude', 'a');

    expect(await readFile(join(profile, 'projects', 'p.jsonl'), 'utf8')).toBe('principal');
  });
});

describe('AccountLauncher: conta em remoção', () => {
  it('beginRemoval recusa novos preparos até a liberação, e depois volta a preparar', async () => {
    const launcher = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: join(dir, 'principal-claude') }) });
    await mkdir(join(dir, 'principal-claude'), { recursive: true });
    const profile = join(nanachiHome, 'accounts', 'claude', 'a');

    const release = await launcher.beginRemoval('claude', 'a');

    expect(launcher.isRemoving('claude', 'a')).toBe(true);
    expect(launcher.isRemoving('claude', 'b')).toBe(false);
    await expect(launcher.prepare('claude', 'a')).rejects.toBeInstanceOf(AccountRemovingError);
    expect(existsSync(profile)).toBe(false);
    await launcher.prepare('claude', 'b');

    release();

    expect(launcher.isRemoving('claude', 'a')).toBe(false);
    await launcher.prepare('claude', 'a');
    expect(existsSync(profile)).toBe(true);
  });

  it('beginRemoval espera o preparo em andamento; o que estava na fila atrás dele é recusado', async () => {
    const launcher = launcherWith({ claude: agent({ CLAUDE_CONFIG_DIR: join(dir, 'principal-claude') }) });
    await mkdir(join(dir, 'principal-claude'), { recursive: true });
    const order: string[] = [];

    const running = launcher.prepare('claude', 'a').then(() => order.push('running done'));
    // Deixa o primeiro começar de verdade (ele faz E/S) antes de a remoção começar.
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const queued = launcher.prepare('claude', 'a').then(
      () => order.push('queued done'),
      (error: unknown) => order.push(error instanceof AccountRemovingError ? 'queued refused' : 'queued failed'),
    );
    const removal = launcher.beginRemoval('claude', 'a');
    expect(launcher.isRemoving('claude', 'a')).toBe(true);
    const release = await removal;
    order.push('removal ready');
    await Promise.all([running, queued]);

    expect(order).toEqual(['running done', 'queued refused', 'removal ready']);
    release();
  });

  it('a liberação é idempotente e não solta uma remoção mais nova', async () => {
    const launcher = launcherWith({ claude: agent() });
    const first = await launcher.beginRemoval('claude', 'a');
    first();
    first();
    expect(launcher.isRemoving('claude', 'a')).toBe(false);
    const second = await launcher.beginRemoval('claude', 'a');
    first();
    expect(launcher.isRemoving('claude', 'a')).toBe(true);
    second();
  });
});
