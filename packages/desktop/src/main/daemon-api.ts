import { messageOf } from '../common/message.js';
import type { AccountInfo, AgentAccountsInfo, DeviceInfo } from '../common/control-api.js';
import type { SeedMachine } from '../common/types.js';
import { PairingError } from './pairing.js';

/**
 * Authenticated calls from the main process to Desktop's own daemon (`http://127.0.0.1:<port>`), with Desktop's device
 * token. The token never leaves this module: the renderer only ever sees the plain data these functions return. Only
 * the routes the control center needs are here, and every answer is checked by a small type guard (the daemon's Zod
 * schemas live in `@nanachi/shared`, which the packaged app does not ship).
 */

export type DaemonApiErrorKind =
  /** Nothing answered: the daemon is down or starting, or the request timed out. */
  | 'unavailable'
  /** Desktop has no usable device token and could not get one. */
  | 'not_paired'
  /** The daemon does not accept the token (the device was revoked and pairing again did not help). */
  | 'unauthorized'
  /** 403: the daemon only accepts calls that come through Tailscale. */
  | 'forbidden'
  | 'not_found'
  /** 400, 409 and the like: the daemon understood and said no; `apiCode` says why. */
  | 'rejected'
  | 'busy'
  | 'server'
  | 'bad_response';

export class DaemonApiError extends Error {
  readonly kind: DaemonApiErrorKind;
  readonly status: number | null;
  /** The daemon's `{ "error": "<code>" }`, when it sent one. */
  readonly apiCode: string | null;

  constructor(kind: DaemonApiErrorKind, message: string, status: number | null = null, apiCode: string | null = null) {
    super(message);
    this.name = 'DaemonApiError';
    this.kind = kind;
    this.status = status;
    this.apiCode = apiCode;
  }
}

export interface DaemonActivity {
  workspaces: number;
  sessions: number;
  /** Running or awaiting permission: what a restart would interrupt. */
  busySessions: number;
}

export interface DaemonApi {
  /** Active (not revoked) devices; `isThisApp` marks the one Desktop itself uses. */
  devices(): Promise<DeviceInfo[]>;
  revokeDevice(id: string): Promise<void>;
  /** `refresh` makes the daemon check every login again (slow); without it the daemon answers from its cache. */
  accounts(refresh?: boolean): Promise<AgentAccountsInfo[]>;
  setActiveAccount(agentId: string, accountId: string): Promise<void>;
  /** The `allowedRoots` the running daemon uses. */
  roots(): Promise<string[]>;
  activity(): Promise<DaemonActivity>;
}

export interface DaemonApiDeps {
  /** `http://127.0.0.1:<port>`, read on every call because the port can change. */
  baseUrl(): string;
  /** Desktop's device token, paired on demand. May throw a `PairingError`. */
  token(): Promise<string>;
  /** After a 401: checks the token with the daemon and pairs again if it was revoked. Returns the token to use now. */
  refreshToken(): Promise<string>;
  fetchImpl: typeof fetch;
  /** Replaces every per-call timeout; tests only. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const ACCOUNTS_TIMEOUT_MS = 15_000;
/** The daemon runs each agent's login check (a CLI) when asked to refresh. */
const ACCOUNTS_REFRESH_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function bad(what: string): DaemonApiError {
  return new DaemonApiError('bad_response', `resposta do daemon inválida (${what})`);
}

function parseDevices(body: unknown): DeviceInfo[] {
  if (!isRecord(body) || !Array.isArray(body.devices)) throw bad('devices');
  return body.devices.map((item): DeviceInfo => {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.id) ||
      !isNonEmptyString(item.name) ||
      typeof item.createdAt !== 'number' ||
      !(item.lastSeenAt === null || typeof item.lastSeenAt === 'number') ||
      typeof item.current !== 'boolean'
    ) {
      throw bad('dispositivo');
    }
    // The daemon lists only devices that were not revoked.
    return { id: item.id, name: item.name, createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, revoked: false, isThisApp: item.current };
  });
}

function statusOf(value: unknown): AccountInfo['status'] {
  return value === 'logged_in' || value === 'logged_out' ? value : 'unknown';
}

function identityOf(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function parseProfile(item: unknown): AccountInfo {
  if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.label) || typeof item.isDefault !== 'boolean' || typeof item.active !== 'boolean') {
    throw bad('conta');
  }
  return {
    id: item.id,
    name: item.label,
    principal: item.isDefault,
    active: item.active,
    status: statusOf(item.status),
    identity: identityOf(item.account),
  };
}

function parseAccounts(body: unknown): AgentAccountsInfo[] {
  if (!isRecord(body) || !Array.isArray(body.accounts)) throw bad('contas');
  return body.accounts.map((item): AgentAccountsInfo => {
    if (!isRecord(item) || !isNonEmptyString(item.agentId) || !isNonEmptyString(item.label)) throw bad('agente');
    const multiAccount = item.supportsAccounts === true;
    if (!multiAccount) {
      // Only the principal login exists: the agent's own top-level fields describe it.
      const principal: AccountInfo = {
        id: 'default',
        name: 'Conta principal',
        principal: true,
        active: true,
        status: statusOf(item.status),
        identity: identityOf(item.account),
      };
      return { agentId: item.agentId, agentName: item.label, multiAccount, accounts: [principal] };
    }
    const profiles: unknown[] = Array.isArray(item.profiles) ? item.profiles : [];
    return { agentId: item.agentId, agentName: item.label, multiAccount, accounts: profiles.map(parseProfile) };
  });
}

function parseRoots(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.roots)) throw bad('pastas');
  return body.roots.map((item) => {
    if (!isRecord(item) || !isNonEmptyString(item.path)) throw bad('pasta');
    return item.path;
  });
}

function parseWorkspaceIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.workspaces)) throw bad('workspaces');
  return body.workspaces.map((item) => {
    if (!isRecord(item) || !isNonEmptyString(item.id)) throw bad('workspace');
    return item.id;
  });
}

/** Statuses of the sessions of one workspace; a value this version does not know is simply not busy. */
function parseSessionStatuses(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.sessions)) throw bad('sessões');
  return body.sessions.map((item) => {
    if (!isRecord(item) || typeof item.status !== 'string') throw bad('sessão');
    return item.status;
  });
}

function kindOfStatus(status: number): DaemonApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'busy';
  if (status >= 500) return 'server';
  return 'rejected';
}

function apiCodeOf(body: unknown): string | null {
  return isRecord(body) && typeof body.error === 'string' ? body.error : null;
}

export function createDaemonApi(deps: DaemonApiDeps): DaemonApi {
  /** One attempt. Returns the parsed JSON body (null for 204) or throws a `DaemonApiError`. */
  async function attempt(method: string, path: string, token: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(deps.timeoutMs ?? timeoutMs) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await deps.fetchImpl(`${deps.baseUrl()}${path}`, init);
    } catch (error) {
      throw new DaemonApiError('unavailable', `o daemon não respondeu: ${messageOf(error)}`);
    }

    if (response.status === 204) return null;
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      throw new DaemonApiError(kindOfStatus(response.status), `o daemon respondeu HTTP ${response.status}`, response.status, apiCodeOf(parsed));
    }
    if (parsed === undefined || parsed === null) throw bad('corpo ausente ou ilegível');
    return parsed;
  }

  async function tokenFor(getToken: () => Promise<string>): Promise<string> {
    try {
      return await getToken();
    } catch (error) {
      if (error instanceof PairingError) {
        throw new DaemonApiError(error.kind === 'network' ? 'unavailable' : 'not_paired', error.message);
      }
      throw error;
    }
  }

  async function request(method: string, path: string, options: { body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const token = await tokenFor(deps.token);
    try {
      return await attempt(method, path, token, options.body, timeoutMs);
    } catch (error) {
      if (!(error instanceof DaemonApiError) || error.kind !== 'unauthorized') throw error;
      // The device may have been revoked: check, pair again if so, and retry once with whatever token is valid now.
      const fresh = await tokenFor(deps.refreshToken);
      if (fresh === token) throw error;
      return attempt(method, path, fresh, options.body, timeoutMs);
    }
  }

  return {
    async devices() {
      return parseDevices(await request('GET', '/api/devices'));
    },
    async revokeDevice(id) {
      await request('DELETE', `/api/devices/${encodeURIComponent(id)}`);
    },
    async accounts(refresh = false) {
      const body = await request('GET', `/api/agents/accounts${refresh ? '?refresh=1' : ''}`, {
        timeoutMs: refresh ? ACCOUNTS_REFRESH_TIMEOUT_MS : ACCOUNTS_TIMEOUT_MS,
      });
      return parseAccounts(body);
    },
    async setActiveAccount(agentId, accountId) {
      const body = await request('PUT', `/api/agents/${encodeURIComponent(agentId)}/accounts/active`, { body: { accountId } });
      if (!isRecord(body) || body.accountId !== accountId) throw bad('conta ativa');
    },
    async roots() {
      return parseRoots(await request('GET', '/api/roots'));
    },
    async activity() {
      const ids = parseWorkspaceIds(await request('GET', '/api/workspaces'));
      const perWorkspace = await Promise.all(
        ids.map(async (id) => {
          try {
            return parseSessionStatuses(await request('GET', `/api/workspaces/${encodeURIComponent(id)}/sessions`));
          } catch (error) {
            // The workspace was removed between the two calls: it has no sessions anymore.
            if (error instanceof DaemonApiError && error.kind === 'not_found') return [];
            throw error;
          }
        }),
      );
      const statuses = perWorkspace.flat();
      return {
        workspaces: ids.length,
        sessions: statuses.length,
        busySessions: statuses.filter((status) => status === 'running' || status === 'awaiting_permission').length,
      };
    },
  };
}

/** What the token source needs from `DesktopPairing`. */
export interface PairingLike {
  current(): SeedMachine | null;
  ensureMachine(): Promise<SeedMachine>;
}

export interface TokenAccessOptions {
  /** `http://127.0.0.1:<port>`, read on every call because the port can change. */
  baseUrl(): string;
  /**
   * Who runs the daemon behind that address. `owned`: Desktop spawned it, so its own home holds the device it pairs.
   * `generation` changes whenever another daemon is behind the address (another mode, port or process).
   */
  daemon(): { owned: boolean; generation: string };
  now?: () => number;
  /** Time between two pairing attempts after a failure, and between two re-pairings after a 401. Default 30 s. */
  repairCooldownMs?: number;
}

const REPAIR_COOLDOWN_MS = 30_000;

/**
 * Where the daemon API gets its token. `token()` uses the machine Desktop already holds when it belongs to the address in
 * use (no network call), and pairs otherwise; `refresh()` goes through the pairing, which asks the daemon about the held
 * token and makes a new device only when the daemon says it was revoked.
 *
 * Every pairing makes a device row (`device add`), so none of this may be a loop. A daemon Desktop did not start has its
 * own devices: Desktop never pairs with it from here (a device made in Desktop's home would not be accepted there, and
 * the control center polls), and a 401 from it is remembered for that daemon instead of retried. For its own daemon a
 * failed pairing is not repeated, and a 401 triggers a re-pairing at most once per cooldown.
 */
export function createTokenAccess(pairing: PairingLike, options: TokenAccessOptions): { token(): Promise<string>; refresh(): Promise<string> } {
  const now = options.now ?? Date.now;
  const cooldown = options.repairCooldownMs ?? REPAIR_COOLDOWN_MS;
  /**
   * A foreign daemon (by generation) that refused the token Desktop holds (`token`), or has none to offer (`token` null).
   * The refusal is about that token: a different one, paired later by the sessions window, gets its own try.
   */
  let refused: { generation: string; token: string | null } | null = null;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let lastFailure: { at: number; error: PairingError } | null = null;

  /** The token Desktop holds for the address in use, if any. */
  function usableToken(): string | null {
    const held = pairing.current();
    return held !== null && held.baseUrl === options.baseUrl() ? held.token : null;
  }

  const foreign = (generation: string): PairingError => {
    refused = { generation, token: usableToken() };
    return new PairingError('rejected', 'o Nanachi Desktop só se pareia com o daemon que ele mesmo iniciou');
  };

  function failedRecently(): PairingError | null {
    return lastFailure !== null && now() - lastFailure.at < cooldown ? lastFailure.error : null;
  }

  async function pair(): Promise<string> {
    try {
      return (await pairing.ensureMachine()).token;
    } catch (error) {
      if (error instanceof PairingError) lastFailure = { at: now(), error };
      throw error;
    }
  }

  return {
    async token() {
      const { owned, generation } = options.daemon();
      const token = usableToken();
      if (!owned && refused !== null && refused.generation === generation && refused.token === token) throw foreign(generation);
      if (token !== null) return token;
      if (!owned) throw foreign(generation);
      const recent = failedRecently();
      if (recent !== null) throw recent;
      return pair();
    },
    async refresh() {
      const { owned, generation } = options.daemon();
      if (!owned) throw foreign(generation);
      const held = usableToken();
      const recent = failedRecently();
      if (now() - lastRefreshAt < cooldown || recent !== null) {
        if (held !== null) return held;
        throw recent ?? new PairingError('rejected', 'o pareamento do Nanachi Desktop foi tentado há pouco; aguarde um instante');
      }
      lastRefreshAt = now();
      return pair();
    },
  };
}
