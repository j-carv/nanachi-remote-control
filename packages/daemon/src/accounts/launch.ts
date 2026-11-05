import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentConfig } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { envValue, mergeEnv } from '../agent-env.js';
import { findAgentProfile, getActiveAccountId } from '../repository.js';
import { accountAdapterOf, type AccountAdapter } from './adapters.js';
import { prepareProfile } from './profile-home.js';

/**
 * Conta de uma sessão na hora de subir o agente (PLAN.md, várias contas por agente): qual conta vale, o preparo da pasta
 * do perfil e a variável de ambiente que aponta o agente para ela. A conta principal (id `default`, `account_id` NULL
 * no banco, `null` aqui) nunca recebe variável: o agente usa a pasta dele do jeito de sempre (env do daemon e do config).
 */

/** Id of the principal account: it has no row in `agent_accounts`, it is the agent's normal folder. */
export const PRINCIPAL_ACCOUNT_ID = 'default';
/** Nome da conta principal, o mesmo que o serviço de contas mostra. */
export const PRINCIPAL_ACCOUNT_LABEL = 'Principal';

/** Recusa de uma conta pedida (criar sessão ou trocar a conta dela). O SessionManager converte para SessionError. */
export class AccountSelectionError extends Error {
  readonly code: 'invalid_request' | 'accounts_unsupported';

  constructor(code: 'invalid_request' | 'accounts_unsupported', message: string) {
    super(message);
    this.name = 'AccountSelectionError';
    this.code = code;
  }
}

/** A conta está sendo removida: nenhum preparo novo (e então nenhum processo novo) pode usar a pasta dela. */
export class AccountRemovingError extends Error {
  constructor() {
    super('a conta está sendo removida');
    this.name = 'AccountRemovingError';
  }
}

export interface AccountLauncherOptions {
  db: Database.Database;
  /** `agents` do config: id → configuração. */
  agents: Readonly<Record<string, AgentConfig>>;
  /** `<NANACHI_HOME>`: as contas extras ficam em `<home>\accounts\<agente>\<conta>`. */
  nanachiHome: string;
  /** Pasta do usuário (`~`), onde ficam `.claude`, `.claude.json` e `.codex`. Padrão: `homedir()`. */
  userHome?: string | undefined;
  /** Env do daemon. O env do agente (config) vale por cima dele para achar a conta principal. Padrão: `process.env`. */
  daemonEnv?: NodeJS.ProcessEnv | undefined;
  /** Aviso (conta que sumiu, junção que não pôde ser feita). Padrão: nada. */
  log?: ((message: string) => void) | undefined;
}

/** Where the principal account of an agent lives, after ignoring a home variable that points into the accounts folder. */
export interface PrincipalAccountInfo {
  /** Absolute path of the principal's configuration folder. */
  home: string;
  /** State file outside that folder (Claude `.claude.json`), absolute; undefined when the agent has none. */
  stateFile: string | undefined;
  /** The variable that names the folder for this agent (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). */
  homeEnv: string;
  /** A valid home variable (agent env over daemon env) names the folder. false: it is the agent's default folder. */
  configured: boolean;
}

export interface AccountLauncher {
  /**
   * Conta de uma sessão nova (ou da troca de conta): `requested` ausente = a conta ativa do agente; `default` = a
   * principal. Devolve o id da conta extra, ou `null` para a principal. Conta desconhecida → `invalid_request`; agente
   * sem contas extras com uma conta que não é a principal → `accounts_unsupported`.
   */
  choose(agentId: string, requested: string | undefined): string | null;
  /**
   * A conta que a sessão usa de verdade ao subir o agente: o `account_id` gravado, se a conta ainda existe e o agente
   * tem contas extras. Conta removida ou desconhecida cai na principal, com aviso no log.
   */
  effective(agentId: string, stored: string | null): string | null;
  /** Nome da conta para o evento `account_changed` e para o PWA. */
  labelOf(agentId: string, accountId: string | null): string;
  /**
   * Variáveis de ambiente a mais do processo do agente: a pasta do perfil (conta extra). A principal não recebe nada,
   * exceto quando o daemon (ou o config) herdou uma variável de pasta que aponta para dentro de `<NANACHI_HOME>\accounts`
   * (por exemplo, o daemon foi iniciado de dentro de uma sessão de conta extra): aí a variável vem com o valor real da
   * principal, ou `undefined` (= sai do env) quando a principal é a pasta padrão. Mesclar com `mergeEnv`.
   */
  env(agentId: string, accountId: string | null): NodeJS.ProcessEnv;
  /**
   * Where the principal account of the agent lives: absolute folder, state file and whether it was configured. A home
   * variable that resolves inside `<NANACHI_HOME>\accounts` (from the daemon env or the agent env) is ignored, with one
   * warning. undefined for an agent without extra accounts.
   */
  principalOf(agentId: string): PrincipalAccountInfo | undefined;
  /**
   * `prepareProfile` da conta extra, antes de qualquer processo dela (sessão, uso, resets, login, criação). Nada para a
   * principal. Todos os preparos do mesmo perfil passam por aqui e não rodam ao mesmo tempo. Falha lança: o processo não
   * deve subir numa pasta pela metade. Conta em remoção: lança `AccountRemovingError`.
   */
  prepare(agentId: string, accountId: string | null): Promise<void>;
  /**
   * The account is about to be deleted. Marks it at once (new prepares are refused from here on), then waits for the
   * prepare that is running. Returns the function that lifts the mark (call it when the removal is over, failed or not).
   * Already being removed → rejects with `AccountRemovingError`.
   */
  beginRemoval(agentId: string, accountId: string): Promise<() => void>;
  isRemoving(agentId: string, accountId: string): boolean;
}

/** Is `candidate` the folder `root` itself or something below it? Compares resolved paths (case-insensitive on Windows). */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function createAccountLauncher(options: AccountLauncherOptions): AccountLauncher {
  const { db } = options;
  const userHome = options.userHome ?? homedir();
  const daemonEnv = options.daemonEnv ?? process.env;
  const warn = options.log ?? (() => undefined);
  const accountsRoot = resolve(options.nanachiHome, 'accounts');
  /** Último preparo de cada perfil: o próximo espera por ele (junção e cópia de arquivo não toleram dois ao mesmo tempo). */
  const preparing = new Map<string, Promise<void>>();
  /** Contas em remoção, com um token por remoção (soltar uma remoção antiga não solta a mais nova). */
  const removing = new Map<string, object>();
  const warned = new Set<string>();

  function keyOf(agentId: string, accountId: string): string {
    return `${agentId}\u0000${accountId}`;
  }

  function configOf(agentId: string): AgentConfig | undefined {
    return Object.hasOwn(options.agents, agentId) ? options.agents[agentId] : undefined;
  }

  /** Adaptador do agente, ou undefined quando ele não tem contas extras (sem adaptador, ou terminal). */
  function adapterOf(agentId: string): AccountAdapter | undefined {
    if (configOf(agentId)?.kind === 'pty') return undefined;
    return accountAdapterOf(agentId);
  }

  function profileHomeOf(agentId: string, accountId: string): string {
    return join(options.nanachiHome, 'accounts', agentId, accountId);
  }

  function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    warn(message);
  }

  /**
   * The home variable of the principal: the agent env first, then the daemon env, each one only if it does not point
   * into the accounts folder (such a value is a leftover of a daemon started from an extra account, and would make the
   * principal use that account). `polluted`: some source was ignored for that reason.
   */
  function homeVariableOf(agentId: string, adapter: AccountAdapter): { value: string | undefined; polluted: boolean } {
    const sources = [
      { origin: 'do env do agente', value: envValue(configOf(agentId)?.env ?? {}, adapter.homeEnv) },
      { origin: 'do env do daemon', value: envValue(daemonEnv, adapter.homeEnv) },
    ];
    let value: string | undefined;
    let polluted = false;
    for (const source of sources) {
      if (source.value === undefined) continue;
      if (isInside(accountsRoot, source.value)) {
        polluted = true;
        warnOnce(
          `${agentId}\u0000${source.origin}`,
          `${adapter.homeEnv} ${source.origin} aponta para dentro de accounts (${source.value}): ignorada; a conta principal de ${agentId} não usa esse valor`,
        );
        continue;
      }
      value ??= source.value;
    }
    return { value, polluted };
  }

  function principalOf(agentId: string): PrincipalAccountInfo | undefined {
    const adapter = adapterOf(agentId);
    if (adapter === undefined) return undefined;
    const { value } = homeVariableOf(agentId, adapter);
    // Layers: the home variable is set (canonical spelling) or removed, so the adapter reads exactly what we decided.
    const env = mergeEnv([daemonEnv, configOf(agentId)?.env ?? {}, { [adapter.homeEnv]: value }]);
    const location = adapter.principal(env, userHome);
    return {
      home: resolve(location.home),
      stateFile: location.stateFile === undefined ? undefined : resolve(location.stateFile),
      homeEnv: adapter.homeEnv,
      configured: value !== undefined,
    };
  }

  async function prepareNow(agentId: string, adapter: AccountAdapter, accountId: string): Promise<void> {
    // A removal can begin while this prepare waits in the queue: it must not bring the folder back.
    if (removing.has(keyOf(agentId, accountId))) throw new AccountRemovingError();
    const principal = principalOf(agentId);
    if (principal === undefined) return;
    await prepareProfile(adapter, principal.home, profileHomeOf(agentId, accountId), {
      principalStateFile: principal.stateFile,
      warn,
    });
  }

  function effective(agentId: string, stored: string | null): string | null {
    if (stored === null) return null;
    if (adapterOf(agentId) === undefined) {
      warn(`conta ${stored} gravada numa sessão de ${agentId}, que não tem contas extras: usando a principal`);
      return null;
    }
    if (findAgentProfile(db, agentId, stored) === undefined) {
      warn(`conta ${stored} de ${agentId} não existe mais: sessão usa a principal`);
      return null;
    }
    return stored;
  }

  return {
    choose(agentId, requested) {
      if (adapterOf(agentId) === undefined) {
        if (requested === undefined || requested === PRINCIPAL_ACCOUNT_ID) return null;
        throw new AccountSelectionError('accounts_unsupported', `${agentId} não tem contas extras`);
      }
      if (requested === PRINCIPAL_ACCOUNT_ID) return null;
      if (requested === undefined) return effective(agentId, getActiveAccountId(db, agentId) ?? null);
      if (findAgentProfile(db, agentId, requested) === undefined) {
        throw new AccountSelectionError('invalid_request', 'conta desconhecida');
      }
      return requested;
    },

    effective,

    labelOf(agentId, accountId) {
      if (accountId === null) return PRINCIPAL_ACCOUNT_LABEL;
      return findAgentProfile(db, agentId, accountId)?.label ?? PRINCIPAL_ACCOUNT_LABEL;
    },

    env(agentId, accountId) {
      const adapter = adapterOf(agentId);
      if (adapter === undefined) return {};
      if (accountId === null) {
        const { value, polluted } = homeVariableOf(agentId, adapter);
        return polluted ? { [adapter.homeEnv]: value } : {};
      }
      return { [adapter.homeEnv]: profileHomeOf(agentId, accountId) };
    },

    principalOf,

    prepare(agentId, accountId) {
      if (accountId === null) return Promise.resolve();
      const adapter = adapterOf(agentId);
      if (adapter === undefined) return Promise.resolve();
      const key = keyOf(agentId, accountId);
      if (removing.has(key)) return Promise.reject(new AccountRemovingError());
      const run = (preparing.get(key) ?? Promise.resolve()).then(
        () => prepareNow(agentId, adapter, accountId),
        () => prepareNow(agentId, adapter, accountId),
      );
      // O fim da fila nunca rejeita: a falha vai só para quem pediu este preparo.
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      preparing.set(key, tail);
      void tail.then(() => {
        if (preparing.get(key) === tail) preparing.delete(key);
      });
      return run;
    },

    async beginRemoval(agentId, accountId) {
      const key = keyOf(agentId, accountId);
      if (removing.has(key)) throw new AccountRemovingError();
      // Marked before the first await: no prepare that starts from here on can pass.
      const token = {};
      removing.set(key, token);
      await preparing.get(key);
      return () => {
        if (removing.get(key) === token) removing.delete(key);
      };
    },

    isRemoving(agentId, accountId) {
      return removing.has(keyOf(agentId, accountId));
    },
  };
}
