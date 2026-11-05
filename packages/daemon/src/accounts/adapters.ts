import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNT_VERIFIERS, type AccountCheck, type ProbeContext } from '../agent-accounts.js';
import { withEnvValue } from '../agent-env.js';

/**
 * Adaptadores de contas: como cada harness guarda a conta logada e o que um perfil compartilha com a conta principal.
 * Um harness novo com várias contas = uma entrada em `ACCOUNT_ADAPTERS` + testes (PLAN.md, várias contas por agente).
 */

/** Conta principal de um agente: a pasta de configuração e, quando o agente tem, o arquivo de estado fora dela. */
export interface PrincipalLocation {
  home: string;
  stateFile?: string | undefined;
}

/** Estado do agente que vive fora da pasta de configuração e é mesclado a cada preparo de perfil. */
export interface StateFileSpec {
  /** Nome do arquivo dentro da pasta de configuração do perfil (ex.: `.claude.json`). */
  name: string;
  /** Chaves copiadas da principal. As demais chaves do arquivo de cada perfil ficam com o perfil. */
  sharedKeys: readonly string[];
}

/**
 * Login da conta extra, como dado para o fluxo de login (ainda não implementado). `launcher: "bundled-codex"` quer
 * dizer que o programa é o codex empacotado (`codex-cli.ts`), não o `command` no PATH.
 */
export interface LoginDescription {
  command: string;
  args: readonly string[];
  launcher: 'path' | 'bundled-codex';
  /** true: o CLI mostra uma URL e pede o código colado de volta. false: mostra um código para digitar no navegador. */
  needsCode: boolean;
  /** Padrão do código que o CLI mostra (procurado depois da URL). null quando não há código. */
  codePattern: RegExp | null;
}

export interface AccountAdapter {
  readonly agentId: string;
  /** Variável de ambiente que aponta o agente para a pasta de configuração do perfil. */
  readonly homeEnv: string;
  /** Conta principal, a partir do env do agente (sobre o do daemon) e da pasta do usuário. */
  principal(env: NodeJS.ProcessEnv, userHome: string): PrincipalLocation;
  /** Pastas que o perfil linka (junção) para a pasta da principal. */
  readonly sharedDirs: readonly string[];
  /**
   * Subset of `sharedDirs` that the agent creates itself (the Codex Windows sandbox): linked only when the principal home
   * already has them, never created empty in the principal. Every other shared folder is created when missing.
   */
  readonly linkOnlyIfPresent?: readonly string[] | undefined;
  /** Arquivos que o perfil copia da principal a cada preparo. Pode depender do que existe na principal. */
  sharedFiles(principalHome: string): Promise<readonly string[]>;
  /** Estado fora da pasta de configuração (só Claude: `.claude.json`). */
  readonly stateFile?: StateFileSpec | undefined;
  readonly login: LoginDescription;
  /** Identidade da conta de um perfil: a mesma verificação da principal, com `homeEnv` apontando para o perfil. */
  identity(profileHome: string, context: ProbeContext): Promise<AccountCheck>;
}

/** Contexto com o env do agente apontando para a pasta do perfil (nunca altera o contexto de quem chamou). */
function withProfileHome(context: ProbeContext, homeEnv: string, profileHome: string): ProbeContext {
  return { ...context, env: withEnvValue(context.env, homeEnv, profileHome), accountHome: profileHome };
}

/** Valor de variável de ambiente, ou undefined quando ausente ou vazio. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Como o Claude Code aponta a pasta de configuração: `CLAUDE_CONFIG_DIR` quando existe, senão `~\.claude`. */
const claudeAdapter: AccountAdapter = {
  agentId: 'claude',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  principal(env, userHome) {
    const configured = nonEmpty(env.CLAUDE_CONFIG_DIR);
    if (configured !== undefined) return { home: configured, stateFile: join(configured, '.claude.json') };
    return { home: join(userHome, '.claude'), stateFile: join(userHome, '.claude.json') };
  },
  sharedDirs: [
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
  ],
  async sharedFiles(principalHome) {
    // Principal ausente: sem entradas extras, só os arquivos fixos (o preparo cria o que faltar quando puder).
    const entries = await readdir(principalHome, { withFileTypes: true }).catch(() => []);
    const markdown = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name);
    return ['settings.json', 'keybindings.json', ...markdown];
  },
  stateFile: {
    name: '.claude.json',
    sharedKeys: ['mcpServers', 'projects', 'hasCompletedOnboarding', 'lastOnboardingVersion', 'theme'],
  },
  login: {
    command: 'claude',
    args: ['auth', 'login'],
    launcher: 'path',
    needsCode: true,
    codePattern: null,
  },
  identity: (profileHome, context) =>
    ACCOUNT_VERIFIERS.claude?.(withProfileHome(context, 'CLAUDE_CONFIG_DIR', profileHome)) ??
    Promise.resolve({ status: 'unknown', account: null, detail: 'Sem verificação' }),
};

/** Como o Codex aponta a pasta de configuração: `CODEX_HOME` quando existe, senão `~\.codex`. */
const codexAdapter: AccountAdapter = {
  agentId: 'codex',
  homeEnv: 'CODEX_HOME',
  principal(env, userHome) {
    return { home: nonEmpty(env.CODEX_HOME) ?? join(userHome, '.codex') };
  },
  sharedDirs: [
    'sessions',
    'archived_sessions',
    'skills',
    'prompts',
    'rules',
    'memories',
    '.sandbox',
    '.sandbox-bin',
    '.sandbox-secrets',
  ],
  linkOnlyIfPresent: ['.sandbox', '.sandbox-bin', '.sandbox-secrets'],
  async sharedFiles() {
    return ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'hooks.json', 'cap_sid'];
  },
  login: {
    command: 'codex',
    args: ['login', '--device-auth'],
    launcher: 'bundled-codex',
    needsCode: false,
    codePattern: /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/,
  },
  identity: (profileHome, context) =>
    ACCOUNT_VERIFIERS.codex?.(withProfileHome(context, 'CODEX_HOME', profileHome)) ??
    Promise.resolve({ status: 'unknown', account: null, detail: 'Sem verificação' }),
};

/** Adaptadores por id de agente. omp, agy e shell não estão aqui: não há contas extras para eles (ver PLAN.md). */
export const ACCOUNT_ADAPTERS: Readonly<Record<string, AccountAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/** Adaptador do agente, ou undefined quando o agente não tem contas extras. */
export function accountAdapterOf(agentId: string): AccountAdapter | undefined {
  return Object.hasOwn(ACCOUNT_ADAPTERS, agentId) ? ACCOUNT_ADAPTERS[agentId] : undefined;
}
