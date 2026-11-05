import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AccountLoginState, AgentAccount, AgentConfig, AgentProfile } from '@nanachi/shared';
import {
  createProbeContext,
  withLimit,
  type AccountCheck,
  type AgentAccountsService,
  type PrincipalAccount,
  type ProbeContext,
  type RunCommand,
} from '../agent-accounts.js';
import { mergeEnv, withEnvValue } from '../agent-env.js';
import { agentBinDirs, withPathPrepended } from '../agent-path.js';
import { ApiError } from '../api-error.js';
import { shellEnvironment } from '../shells.js';
import {
  countBusySessionsOnAccount,
  findAgentProfile,
  getActiveAccountId,
  insertAgentProfileIfRoom,
  listAgentProfiles,
  removeAgentProfile,
  renameAgentProfile,
  setActiveAccountId,
  type AgentProfileRow,
} from '../repository.js';
import { accountAdapterOf, type AccountAdapter } from './adapters.js';
import { PRINCIPAL_ACCOUNT_ID, type AccountLauncher } from './launch.js';
import { createLoginManager, type LoginOverrides, type LoginTarget } from './login.js';
import { removeProfileHome } from './profile-home.js';

const PRINCIPAL_LABEL = 'Principal';
/** Contas extras por agente (além da principal). Ver PLAN.md, várias contas por agente. */
export const MAX_EXTRA_ACCOUNTS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TTL_MS = 5 * 60_000;

/** Ajustes do serviço: o padrão é o real; testes trocam pastas, env, `run` e relógio. */
export interface AccountRuntime {
  /** Pasta do usuário (`~`), onde ficam `.claude`, `.claude.json` e `.codex`. Padrão: `homedir()`. */
  userHome?: string | undefined;
  /** Env do daemon. O env do agente (config) vale por cima dele para achar a conta principal. Padrão: `process.env`. */
  daemonEnv?: NodeJS.ProcessEnv | undefined;
  /** Env com o PATH dos verificadores (agent-path.ts). Padrão: `process.env`. */
  probeEnv?: NodeJS.ProcessEnv | undefined;
  resolve?: ((command: string) => string | undefined) | undefined;
  run?: RunCommand | undefined;
  now?: (() => number) | undefined;
  /** Teto de cada verificação de conta extra. Padrão: 15 s. */
  timeoutMs?: number | undefined;
  /** Validade do cache de identidade das contas extras. Padrão: 5 min. */
  ttlMs?: number | undefined;
  /** Aviso de preparo (junção que não pôde ser feita etc.). Padrão: nada. */
  log?: ((message: string) => void) | undefined;
  /** Account login: command, PTY and clock. Tests replace them; the default runs the adapter's real command. */
  login?: LoginOverrides | undefined;
}

export interface AccountsServiceOptions extends AccountRuntime {
  db: Database.Database;
  /** `agents` do config: id → configuração. */
  agents: Readonly<Record<string, AgentConfig>>;
  /** `<NANACHI_HOME>`: as contas extras ficam em `<home>\accounts\<agente>\<conta>`. */
  nanachiHome: string;
  /** Verificação da conta principal (`agent-accounts.ts`), com o cache dela. */
  principal: AgentAccountsService;
  /**
   * Account launcher: where the principal lives, and the one place that prepares profile folders (every prepare of the
   * same profile goes through its queue) and that knows an account is being removed.
   */
  launcher: AccountLauncher;
  /**
   * Is something in memory still using the account (a live process, a resume, an account switch, a reserved start, a
   * usage read)? The sessions table is checked by the service itself. Default: nothing.
   */
  isAccountInUse?: ((agentId: string, accountId: string) => boolean) | undefined;
  /**
   * Chamado ao remover uma conta, antes de a pasta dela ser apagada: quem tem processo ou cache dessa conta (o processo
   * de uso, os resets) os solta. Padrão: nada.
   */
  releaseAccount?: ((agentId: string, accountId: string) => Promise<void>) | undefined;
}

/** Operações de contas. Os erros saem como `ApiError` com o código do contrato (PLAN.md). */
export interface AccountsService {
  /** Uma entrada por agente do config, com a conta principal e (quando há) os perfis. */
  list(options?: { refresh?: boolean }): Promise<AgentAccount[]>;
  create(agentId: string, label: string): Promise<AgentProfile>;
  rename(agentId: string, accountId: string, label: string): Promise<AgentProfile>;
  remove(agentId: string, accountId: string): Promise<void>;
  /** Torna a conta ativa (para sessões novas). Devolve o id gravado. */
  setActive(agentId: string, accountId: string): Promise<string>;
  /** Starts the login of the account (the principal included). Already running for it: the current state. Another account of the agent logging in: 409. */
  startLogin(agentId: string, accountId: string): Promise<AccountLoginState>;
  /** State of the last login of the account that is still in memory. 404 `not_found` when there is none. */
  loginState(agentId: string, accountId: string): AccountLoginState;
  /** Types the code into the login. 409 `invalid_state` when it is not waiting for one. The code is never returned or logged. */
  sendLoginCode(agentId: string, accountId: string, code: string): AccountLoginState;
  /** Cancels the running login of the account. 404 when it never had one; a finished login is left as it is. */
  cancelLogin(agentId: string, accountId: string): Promise<void>;
  /** Kills the running logins (the daemon is closing). */
  shutdown(): Promise<void>;
}

interface Identity {
  status: AccountCheck['status'];
  account: string | null;
  detail: string | null;
  checkedAt: number;
}

interface IdentityEntry {
  at: number;
  check: AccountCheck;
}

/** Serviço de contas: junta a principal (já verificada) com os perfis do banco e a identidade de cada um. */
export function createAccountsService(options: AccountsServiceOptions): AccountsService {
  const { db } = options;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const userHome = options.userHome ?? homedir();
  const daemonEnv = options.daemonEnv ?? process.env;
  const log = options.log ?? (() => undefined);
  const context: ProbeContext = createProbeContext({
    home: userHome,
    env: options.probeEnv ?? process.env,
    timeoutMs,
    resolve: options.resolve,
    run: options.run,
  });

  /** Identidade das contas extras por `agente\0conta`. Chamadas simultâneas esperam a mesma verificação. */
  const identities = new Map<string, IdentityEntry>();
  const inFlight = new Map<string, Promise<IdentityEntry>>();

  function keyOf(agentId: string, accountId: string): string {
    return `${agentId}\u0000${accountId}`;
  }

  function profileHomeOf(agentId: string, accountId: string): string {
    return join(options.nanachiHome, 'accounts', agentId, accountId);
  }

  /** Agente com contas extras: id no config e adaptador. Senão 404 (desconhecido) ou 400 (sem contas extras). */
  function requireAdapter(agentId: string): AccountAdapter {
    const agent = Object.hasOwn(options.agents, agentId) ? options.agents[agentId] : undefined;
    if (agent === undefined) throw new ApiError(404, 'not_found', `agente desconhecido: ${agentId}`);
    const adapter = accountAdapterOf(agentId);
    if (adapter === undefined) throw new ApiError(400, 'accounts_unsupported', `${agentId} não tem contas extras`);
    return adapter;
  }

  async function identityOf(agentId: string, adapter: AccountAdapter, accountId: string, refresh: boolean): Promise<Identity> {
    const key = keyOf(agentId, accountId);
    const cached = identities.get(key);
    if (!refresh && cached !== undefined && now() - cached.at < ttlMs) {
      return { ...cached.check, checkedAt: cached.at };
    }
    let running = inFlight.get(key);
    if (running === undefined) {
      const started: Promise<IdentityEntry> = withLimit(adapter.identity(profileHomeOf(agentId, accountId), context), timeoutMs).then(
        (check) => {
          const entry: IdentityEntry = { at: now(), check };
          // A check that was dropped meanwhile (account removed, or a fresh check after a login) must not overwrite.
          if (inFlight.get(key) === started) identities.set(key, entry);
          return entry;
        },
      );
      running = started;
      inFlight.set(key, running);
      const settle = (): void => {
        if (inFlight.get(key) === started) inFlight.delete(key);
      };
      running.then(settle, settle);
    }
    const entry = await running;
    return { ...entry.check, checkedAt: entry.at };
  }

  function principalProfile(principal: PrincipalAccount, activeId: string | undefined): AgentProfile {
    return {
      id: PRINCIPAL_ACCOUNT_ID,
      label: PRINCIPAL_LABEL,
      isDefault: true,
      active: activeId === undefined,
      status: principal.status,
      account: principal.account,
      detail: principal.detail,
      checkedAt: principal.checkedAt,
    };
  }

  async function storedProfile(
    agentId: string,
    adapter: AccountAdapter,
    row: AgentProfileRow,
    activeId: string | undefined,
    refresh: boolean,
  ): Promise<AgentProfile> {
    const identity = await identityOf(agentId, adapter, row.id, refresh);
    return {
      id: row.id,
      label: row.label,
      isDefault: false,
      active: activeId === row.id,
      status: identity.status,
      account: identity.account,
      detail: identity.detail,
      checkedAt: identity.checkedAt,
    };
  }

  /** The account exists: the principal, or a profile of the agent. Otherwise 404. Returns the agent's adapter. */
  function requireAccount(agentId: string, accountId: string): AccountAdapter {
    const adapter = requireAdapter(agentId);
    if (accountId !== PRINCIPAL_ACCOUNT_ID && findAgentProfile(db, agentId, accountId) === undefined) {
      throw new ApiError(404, 'not_found', 'conta desconhecida');
    }
    return adapter;
  }

  /**
   * Where and with what environment the login runs. Env: the daemon's with the agent's on top, without NANACHI_* (the
   * daemon's token and address do not go to the login CLI), with the agent PATH. Extra account: `<homeEnv>` points to
   * the profile home; the principal gets no override (the login writes to the agent's normal home again) and loses a home
   * variable inherited from an extra account's environment (the launcher knows which).
   */
  function loginTargetOf(agentId: string, adapter: AccountAdapter, accountId: string): LoginTarget {
    const base = shellEnvironment(
      withPathPrepended(mergeEnv([daemonEnv, options.agents[agentId]?.env ?? {}]), agentBinDirs()),
    );
    if (accountId === PRINCIPAL_ACCOUNT_ID) {
      const home = options.launcher.principalOf(agentId)?.home;
      // Nanachi never creates the principal home: without it, the login runs in the user folder.
      const cwd = home !== undefined && existsSync(home) ? home : userHome;
      return { agentId, accountId, adapter, principal: true, cwd, env: mergeEnv([base, options.launcher.env(agentId, null)]) };
    }
    const home = profileHomeOf(agentId, accountId);
    return { agentId, accountId, adapter, principal: false, cwd: home, env: withEnvValue(base, adapter.homeEnv, home) };
  }

  /** Identity of the account after a login: checked again without the cache (a check from before the login is stale). */
  async function verifyAfterLogin(target: LoginTarget): Promise<AccountCheck> {
    const { agentId, accountId, adapter } = target;
    if (accountId !== PRINCIPAL_ACCOUNT_ID) {
      identities.delete(keyOf(agentId, accountId));
      inFlight.delete(keyOf(agentId, accountId));
      const identity = await identityOf(agentId, adapter, accountId, true);
      return { status: identity.status, account: identity.account, detail: identity.detail };
    }
    // The principal check is cached and joins simultaneous calls: one already running before the login may return the
    // old state. If the first answer is not "logged in", a second one decides.
    let check: AccountCheck = { status: 'unknown', account: null, detail: null };
    for (let attempt = 0; attempt < 2 && check.status !== 'logged_in'; attempt++) {
      const entry = (await options.principal.list({ refresh: true })).find((account) => account.agentId === agentId);
      if (entry !== undefined) check = { status: entry.status, account: entry.account, detail: entry.detail };
    }
    return check;
  }

  const logins = createLoginManager({
    prepare: (target) => options.launcher.prepare(target.agentId, target.accountId),
    verify: verifyAfterLogin,
    log,
    ...options.login,
  });

  return {
    async list({ refresh = false } = {}) {
      const principals = await options.principal.list({ refresh });
      return Promise.all(
        principals.map(async (principal): Promise<AgentAccount> => {
          const adapter = accountAdapterOf(principal.agentId);
          if (adapter === undefined) return { ...principal, supportsAccounts: false, profiles: [] };
          const activeId = getActiveAccountId(db, principal.agentId);
          const extra = await Promise.all(
            listAgentProfiles(db, principal.agentId).map((row) =>
              storedProfile(principal.agentId, adapter, row, activeId, refresh),
            ),
          );
          return {
            ...principal,
            supportsAccounts: true,
            profiles: [principalProfile(principal, activeId), ...extra],
          };
        }),
      );
    },

    async create(agentId, label) {
      requireAdapter(agentId);
      const accountId = randomUUID();
      const createdAt = now();
      // The limit check and the insert are one transaction with no await between them: concurrent creates cannot all
      // pass the check. The folder is prepared after the row exists; if that fails the row goes away again.
      if (!insertAgentProfileIfRoom(db, { id: accountId, agent: agentId, label, createdAt }, MAX_EXTRA_ACCOUNTS)) {
        throw new ApiError(409, 'too_many_accounts', `limite de ${MAX_EXTRA_ACCOUNTS} contas extras por agente`);
      }
      try {
        await options.launcher.prepare(agentId, accountId);
      } catch (error) {
        // Sem a linha no banco a pasta seria órfã: desfaz a linha, tenta apagar o que foi criado e repassa o erro original.
        removeAgentProfile(db, agentId, accountId);
        await removeProfileHome(options.nanachiHome, agentId, profileHomeOf(agentId, accountId)).catch(() => undefined);
        throw error;
      }
      // A listing that ran while the folder was being prepared may have cached "unknown" for this account.
      identities.delete(keyOf(agentId, accountId));
      return {
        id: accountId,
        label,
        isDefault: false,
        active: false,
        status: 'logged_out',
        account: null,
        detail: null,
        checkedAt: createdAt,
      };
    },

    async rename(agentId, accountId, label) {
      const adapter = requireAdapter(agentId);
      if (accountId === PRINCIPAL_ACCOUNT_ID) {
        throw new ApiError(400, 'invalid_request', 'a conta principal não tem nome editável aqui');
      }
      const row = renameAgentProfile(db, agentId, accountId, label);
      if (row === undefined) throw new ApiError(404, 'not_found', 'conta desconhecida');
      return storedProfile(agentId, adapter, row, getActiveAccountId(db, agentId), false);
    },

    async remove(agentId, accountId) {
      requireAdapter(agentId);
      if (accountId === PRINCIPAL_ACCOUNT_ID) {
        throw new ApiError(400, 'invalid_request', 'a conta principal não pode ser removida');
      }
      if (findAgentProfile(db, agentId, accountId) === undefined) throw new ApiError(404, 'not_found', 'conta desconhecida');
      // Sessions in the table, and whatever lives only in memory (a process, a resume, a switch, a reserved start, a
      // usage read): a session whose row says "stopped" can still be resuming into this folder.
      if (countBusySessionsOnAccount(db, agentId, accountId) > 0 || options.isAccountInUse?.(agentId, accountId) === true) {
        throw new ApiError(409, 'account_in_use', 'há sessão em uso nesta conta');
      }
      // From here on no prepare (so no new process) can use the folder. Marked with no await since the check above.
      const marking = options.launcher.beginRemoval(agentId, accountId);
      let lift: () => void;
      try {
        lift = await marking;
      } catch {
        throw new ApiError(409, 'account_in_use', 'a conta já está sendo removida');
      }
      try {
        // The login process has the profile home as its cwd: it must be gone before the folder can be deleted.
        await logins.discard(agentId, accountId);
        await options.releaseAccount?.(agentId, accountId);
        await removeProfileHome(options.nanachiHome, agentId, profileHomeOf(agentId, accountId));
        removeAgentProfile(db, agentId, accountId);
        identities.delete(keyOf(agentId, accountId));
        inFlight.delete(keyOf(agentId, accountId));
      } finally {
        lift();
      }
    },

    async setActive(agentId, accountId) {
      requireAdapter(agentId);
      if (accountId === PRINCIPAL_ACCOUNT_ID) {
        setActiveAccountId(db, agentId, null);
        return PRINCIPAL_ACCOUNT_ID;
      }
      if (findAgentProfile(db, agentId, accountId) === undefined) throw new ApiError(404, 'not_found', 'conta desconhecida');
      setActiveAccountId(db, agentId, accountId);
      return accountId;
    },

    async startLogin(agentId, accountId) {
      const adapter = requireAccount(agentId, accountId);
      return logins.start(loginTargetOf(agentId, adapter, accountId));
    },

    loginState(agentId, accountId) {
      requireAccount(agentId, accountId);
      const state = logins.get(agentId, accountId);
      if (state === undefined) throw new ApiError(404, 'not_found', 'no login for this account');
      return state;
    },

    sendLoginCode(agentId, accountId, code) {
      requireAccount(agentId, accountId);
      return logins.submitCode(agentId, accountId, code);
    },

    async cancelLogin(agentId, accountId) {
      requireAccount(agentId, accountId);
      const state = await logins.cancel(agentId, accountId);
      if (state === undefined) throw new ApiError(404, 'not_found', 'no login for this account');
    },

    shutdown: () => logins.shutdown(),
  };
}
