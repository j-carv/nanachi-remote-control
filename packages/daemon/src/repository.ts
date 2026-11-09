import { randomUUID } from 'node:crypto';
import {
  AppLanguageSchema,
  AvailableCommandSchema,
  LoopSchema,
  PushSubscriptionRequestSchema,
  SessionConfigOptionSchema,
  SessionEventSchema,
  SessionSchema,
  SessionStatusSchema,
  type AgentKind,
  type AppLanguage,
  type AvailableCommand,
  type Loop,
  type Session,
  type SessionConfigOption,
  type SessionEvent,
  type SessionSearchResult,
  type SessionStatus,
  type Workspace,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { offeredConfigOptions } from './agent-modes.js';

export interface Machine {
  id: string;
  name: string;
}

/** Como o device pareou: código de 6 dígitos (`code`) ou login do Tailscale (`tailscale`, ver PLAN.md). */
export type PairMethod = 'code' | 'tailscale';

export interface DeviceRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  pairMethod: PairMethod;
}

interface DeviceDbRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  pair_method: PairMethod;
}

/** Colunas de `devices` que viram `DeviceRow`. */
const DEVICE_COLUMNS = 'id, name, created_at, last_seen_at, revoked_at, pair_method';

function toDevice(row: DeviceDbRow): DeviceRow {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    pairMethod: row.pair_method,
  };
}

/** Garante a linha única de `machine` (id gerado na 1ª execução) e sincroniza o nome do config. */
export function ensureMachine(db: Database.Database, name: string): Machine {
  const existing = db.prepare<[], Machine>('SELECT id, name FROM machine LIMIT 1').get();
  if (existing === undefined) {
    const machine: Machine = { id: randomUUID(), name };
    db.prepare<[string, string]>('INSERT INTO machine (id, name) VALUES (?, ?)').run(machine.id, machine.name);
    return machine;
  }
  if (existing.name !== name) {
    db.prepare<[string, string]>('UPDATE machine SET name = ? WHERE id = ?').run(name, existing.id);
  }
  return { id: existing.id, name };
}

export function insertDevice(
  db: Database.Database,
  device: { id: string; name: string; tokenHash: string; createdAt: number; pairMethod?: PairMethod },
): void {
  db.prepare<[string, string, string, number, PairMethod]>(
    'INSERT INTO devices (id, name, token_hash, created_at, pair_method) VALUES (?, ?, ?, ?, ?)',
  ).run(device.id, device.name, device.tokenHash, device.createdAt, device.pairMethod ?? 'code');
}

export function findDeviceByTokenHash(db: Database.Database, tokenHash: string): DeviceRow | undefined {
  const row = db
    .prepare<[string], DeviceDbRow>(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE token_hash = ?`,
    )
    .get(tokenHash);
  return row === undefined ? undefined : toDevice(row);
}

export function touchDevice(db: Database.Database, id: string, at: number): void {
  db.prepare<[number, string]>('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id);
}

export function listDevices(db: Database.Database): DeviceRow[] {
  return db
    .prepare<[], DeviceDbRow>(`SELECT ${DEVICE_COLUMNS} FROM devices ORDER BY created_at`)
    .all()
    .map(toDevice);
}

/** Devices não revogados, mais antigos primeiro. */
export function listActiveDevices(db: Database.Database): DeviceRow[] {
  return db
    .prepare<[], DeviceDbRow>(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE revoked_at IS NULL ORDER BY created_at`,
    )
    .all()
    .map(toDevice);
}

/**
 * Revoga um dispositivo ativo e apaga as inscrições de Web Push dele (numa transação).
 * Retorna false se não existe ou já estava revogado.
 */
export function revokeDevice(db: Database.Database, id: string, at: number): boolean {
  return db.transaction((): boolean => {
    const result = db
      .prepare<[number, string]>('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(at, id);
    if (result.changes === 0) return false;
    db.prepare<[string]>('DELETE FROM push_subscriptions WHERE device_id = ?').run(id);
    return true;
  })();
}

interface WorkspaceDbRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
  muted: number;
}

const WORKSPACE_COLUMNS = 'id, name, path, created_at, muted';

function toWorkspace(row: WorkspaceDbRow): Workspace {
  return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at, muted: row.muted === 1 };
}

/** Worktree git de uma sessão (ver `Session.worktree`). */
export type Worktree = NonNullable<Session['worktree']>;

interface SessionDbRow {
  id: string;
  workspace_id: string;
  agent: string;
  kind: string;
  title: string;
  status: string;
  worktree: string | null;
  account_id: string | null;
  automation_run_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Valida a linha inteira com o schema do shared (kind, status e worktree viram tipos confiáveis). */
function toSession(row: SessionDbRow): Session {
  const worktree: unknown = row.worktree === null ? null : JSON.parse(row.worktree);
  return SessionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    agent: row.agent,
    kind: row.kind,
    title: row.title,
    status: row.status,
    accountId: row.account_id,
    ...(row.automation_run_id === null ? {} : { automationRunId: row.automation_run_id }),
    worktree,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Sessões com processo vivo ou subindo (tudo que não é `stopped` nem `error`). */
export function countLiveSessions(db: Database.Database): number {
  return db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE status NOT IN ('stopped', 'error')")
    .get()?.n ?? 0;
}

/**
 * Sessões que estão trabalhando agora (subindo, rodando ou esperando permissão). `idle` não conta: fica parada até o
 * usuário retomar. Terminal de workspace (`agent = 'shell'`) não conta: ele fica `running` enquanto aberto, e o reload o
 * encerra com aviso (ver SessionManager.closeShellsForReload).
 */
export function countBusySessions(db: Database.Database): number {
  return db
    .prepare<[], { n: number }>(
      `SELECT
        (SELECT COUNT(*) FROM sessions WHERE status IN ('starting', 'running', 'awaiting_permission') AND agent <> 'shell') +
        (SELECT COUNT(*) FROM schedule_runs AS run WHERE execution_active = 1 AND NOT EXISTS (
          SELECT 1 FROM sessions WHERE automation_run_id = run.id AND status IN ('starting', 'running', 'awaiting_permission')
        )) AS n`,
    )
    .get()?.n ?? 0;
}

/** Some session of the workspace (worktree sessions included) is starting, running, or awaiting permission. */
export function hasBusySessionsInWorkspace(db: Database.Database, workspaceId: string): boolean {
  return (
    db
      .prepare<[string], { found: number }>(
        `SELECT 1 AS found FROM (
           SELECT workspace_id FROM sessions WHERE status IN ('starting', 'running', 'awaiting_permission')
           UNION ALL
           SELECT workspace_id FROM schedule_runs WHERE execution_active = 1
         ) WHERE workspace_id = ? LIMIT 1`,
      )
      .get(workspaceId) !== undefined
  );
}

/** Sessões ociosas de agente (ACP) com processo vivo: as que um reload precisa retomar. Terminal (pty) não entra. */
export function listIdleAcpSessionIds(db: Database.Database): string[] {
  return db
    .prepare<[], { id: string }>("SELECT id FROM sessions WHERE status = 'idle' AND kind = 'acp' ORDER BY created_at, rowid")
    .all()
    .map((row) => row.id);
}

export function insertWorkspace(db: Database.Database, workspace: Workspace): void {
  db.prepare<[string, string, string, number, number]>(
    'INSERT INTO workspaces (id, name, path, created_at, muted) VALUES (?, ?, ?, ?, ?)',
  ).run(workspace.id, workspace.name, workspace.path, workspace.createdAt, workspace.muted ? 1 : 0);
}

export function findWorkspaceById(db: Database.Database, id: string): Workspace | undefined {
  const row = db
    .prepare<[string], WorkspaceDbRow>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?`)
    .get(id);
  return row === undefined ? undefined : toWorkspace(row);
}

export function findWorkspaceByPath(db: Database.Database, path: string): Workspace | undefined {
  const row = db
    .prepare<[string], WorkspaceDbRow>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE path = ?`)
    .get(path);
  return row === undefined ? undefined : toWorkspace(row);
}

export function listWorkspaces(db: Database.Database): Workspace[] {
  return db
    .prepare<[], WorkspaceDbRow>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces ORDER BY created_at, rowid`)
    .all()
    .map(toWorkspace);
}

/** Liga/desliga o silêncio do workspace. Devolve o workspace atualizado ou undefined se não existe. */
export function setWorkspaceMuted(db: Database.Database, id: string, muted: boolean): Workspace | undefined {
  db.prepare<[number, string]>('UPDATE workspaces SET muted = ? WHERE id = ?').run(muted ? 1 : 0, id);
  return findWorkspaceById(db, id);
}

/**
 * Apaga o workspace e marca as sessões dele que não estão `stopped` como `stopped` (tudo numa transação).
 * Devolve os ids dessas sessões, ou undefined se o workspace não existe.
 */
export function deleteWorkspace(
  db: Database.Database,
  id: string,
  at: number,
): { sessionIds: string[] } | undefined {
  return db.transaction((): { sessionIds: string[] } | undefined => {
    if (findWorkspaceById(db, id) === undefined) return undefined;

    const sessionIds = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM sessions WHERE workspace_id = ? AND status <> 'stopped' ORDER BY created_at",
      )
      .all(id)
      .map((row) => row.id);
    db.prepare<[number, string]>(
      "UPDATE sessions SET status = 'stopped', updated_at = ? WHERE workspace_id = ? AND status <> 'stopped'",
    ).run(at, id);
    db.prepare<[string]>('DELETE FROM workspaces WHERE id = ?').run(id);
    return { sessionIds };
  })();
}

/**
 * Apaga a sessão do app: linha, eventos e registros de arquivos, numa transação. Não toca no agente nem na pasta
 * de arquivos (quem chama remove). Quem chama também garante que o processo já parou.
 */
export function deleteSessionRows(db: Database.Database, sessionId: string): void {
  db.transaction((): void => {
    db.prepare<[string]>('DELETE FROM events WHERE session_id = ?').run(sessionId);
    db.prepare<[string]>('DELETE FROM files WHERE session_id = ?').run(sessionId);
    db.prepare<[string]>('DELETE FROM loops WHERE session_id = ?').run(sessionId);
    db.prepare<[string]>('DELETE FROM sessions WHERE id = ?').run(sessionId);
  })();
}

/** Sessões do workspace, mais recente primeiro. */
export function listSessionsByWorkspace(db: Database.Database, workspaceId: string): Session[] {
  return db
    .prepare<[string], SessionDbRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace_id = ? AND automation_run_id IS NULL ORDER BY created_at DESC, rowid DESC`)
    .all(workspaceId)
    .map(toSession);
}

/** Includes automation history for workspace lifecycle operations, never ordinary conversation lists. */
export function listAllSessionsByWorkspace(db: Database.Database, workspaceId: string): Session[] {
  return db
    .prepare<[string], SessionDbRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(workspaceId)
    .map(toSession);
}

/**
 * Na subida do daemon, sessões ativas de uma execução anterior viram `stopped` (podem ser retomadas depois).
 * Devolve quantas mudaram.
 */
export function stopInterruptedSessions(db: Database.Database, at: number): number {
  return db
    .prepare<[number]>(
      "UPDATE sessions SET status = 'stopped', updated_at = ? WHERE status NOT IN ('stopped', 'error')",
    )
    .run(at).changes;
}

const SESSION_COLUMNS =
  'id, workspace_id, agent, kind, title, status, worktree, account_id, automation_run_id, created_at, updated_at';

export interface NewSession {
  id: string;
  workspaceId: string;
  agent: string;
  /** Fixado na criação: mudar o config depois não troca o tipo de uma sessão existente. Padrão `acp`. */
  kind?: AgentKind;
  title: string;
  status: SessionStatus;
  createdAt: number;
  /** Worktree separado (null/ausente = roda no cwd do workspace). Gravado como JSON. */
  worktree?: Worktree | null;
  /** Conta do agente (null/ausente = principal). */
  accountId?: string | null;
  /** Workspace automation owns this session before any startup event is published. */
  automationRunId?: string;
}

export function insertSession(db: Database.Database, session: NewSession): void {
  db.prepare<[string, string, string, string, string, string, string | null, string | null, string | null, number, number]>(
    `INSERT INTO sessions (id, workspace_id, agent, kind, title, status, config_options, worktree, account_id, automation_run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.workspaceId,
    session.agent,
    session.kind ?? 'acp',
    session.title,
    session.status,
    session.worktree ? JSON.stringify(session.worktree) : null,
    session.accountId ?? null,
    session.automationRunId ?? null,
    session.createdAt,
    session.createdAt,
  );
}

export function findSessionById(db: Database.Database, id: string): Session | undefined {
  const row = db.prepare<[string], SessionDbRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id);
  return row === undefined ? undefined : toSession(row);
}

/** Comandos que o agente anunciou por último (coluna `commands`). Undefined se a sessão não existe. */
export function findSessionCommands(db: Database.Database, id: string): AvailableCommand[] | undefined {
  const row = db.prepare<[string], { commands: string }>('SELECT commands FROM sessions WHERE id = ?').get(id);
  return row === undefined ? undefined : AvailableCommandSchema.array().parse(JSON.parse(row.commands));
}

/**
 * Config options the session offers now (column `config_options`), filtered by agent-modes.ts; rows written before that
 * rule are filtered too. Undefined when the session does not exist.
 */
export function findSessionConfigOptions(db: Database.Database, id: string): SessionConfigOption[] | undefined {
  const row = db
    .prepare<[string], { config_options: string; agent: string }>('SELECT config_options, agent FROM sessions WHERE id = ?')
    .get(id);
  if (row === undefined) return undefined;
  return offeredConfigOptions(row.agent, SessionConfigOptionSchema.array().parse(JSON.parse(row.config_options)));
}

/** Id da sessão no agente (session/new). Undefined se a sessão não existe ou nunca abriu no agente. */
export function findAcpSessionId(db: Database.Database, id: string): string | undefined {
  const row = db
    .prepare<[string], { acp_session_id: string | null }>('SELECT acp_session_id FROM sessions WHERE id = ?')
    .get(id);
  return row?.acp_session_id ?? undefined;
}

/** Sessão do app ligada a um id de sessão do agente (aberta ou parada). */
export interface AcpLink {
  sessionId: string;
  status: SessionStatus;
}

/** Ligações `acp_session_id` → sessão do app, para um agente. Se houver mais de uma, vale a mais nova. */
export function findAcpLinks(db: Database.Database, agent: string): Map<string, AcpLink> {
  const rows = db
    .prepare<[string], { id: string; acp_session_id: string; status: string }>(
      `SELECT id, acp_session_id, status FROM sessions
       WHERE agent = ? AND acp_session_id IS NOT NULL ORDER BY created_at DESC, rowid DESC`,
    )
    .all(agent);
  const links = new Map<string, AcpLink>();
  for (const row of rows) {
    if (links.has(row.acp_session_id)) continue;
    links.set(row.acp_session_id, { sessionId: row.id, status: SessionStatusSchema.parse(row.status) });
  }
  return links;
}

export interface SessionChanges {
  status?: SessionStatus;
  title?: string;
  configOptions?: SessionConfigOption[];
  /** Lista inteira mais recente que o agente anunciou (substitui a anterior). */
  commands?: AvailableCommand[];
  acpSessionId?: string;
  /** Conta do agente (`null` = principal). */
  accountId?: string | null;
}

/** Atualiza só os campos informados e `updated_at`. Os nomes de coluna são fixos (nada vem do usuário). */
export function updateSession(db: Database.Database, id: string, changes: SessionChanges, at: number): void {
  const assignments = ['updated_at = ?'];
  const values: Array<string | number | null> = [at];
  if (changes.status !== undefined) {
    assignments.push('status = ?');
    values.push(changes.status);
  }
  if (changes.title !== undefined) {
    assignments.push('title = ?');
    values.push(changes.title);
  }
  if (changes.configOptions !== undefined) {
    assignments.push('config_options = ?');
    values.push(JSON.stringify(changes.configOptions));
  }
  if (changes.commands !== undefined) {
    assignments.push('commands = ?');
    values.push(JSON.stringify(changes.commands));
  }
  if (changes.acpSessionId !== undefined) {
    assignments.push('acp_session_id = ?');
    values.push(changes.acpSessionId);
  }
  if (changes.accountId !== undefined) {
    assignments.push('account_id = ?');
    values.push(changes.accountId);
  }
  db.prepare<Array<string | number | null>>(`UPDATE sessions SET ${assignments.join(', ')} WHERE id = ?`).run(
    ...values,
    id,
  );
}

/** Grava um evento já serializado (`payload` = campos sem kind/seq/sessionId/ts). Devolve o seq atribuído. */
export function insertEvent(
  db: Database.Database,
  event: { sessionId: string; ts: number; kind: string; payload: string },
): number {
  const result = db
    .prepare<[string, number, string, string]>('INSERT INTO events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)')
    .run(event.sessionId, event.ts, event.kind, event.payload);
  return Number(result.lastInsertRowid);
}

/** A request id cannot be reused, even after it has been resolved or the daemon has restarted. */
export function hasUserQuestion(db: Database.Database, sessionId: string, requestId: string): boolean {
  return db.prepare<[string, string], { present: number }>(
    "SELECT 1 AS present FROM events WHERE session_id = ? AND kind = 'user_question' AND json_extract(payload, '$.requestId') = ? LIMIT 1",
  ).get(sessionId, requestId) !== undefined;
}

/** Persisted questions without a resolution belong to a dead HTTP waiter after daemon restart. */
export function orphanedUserQuestions(db: Database.Database): Array<{ sessionId: string; requestId: string }> {
  return db.prepare<[], { sessionId: string; requestId: string }>(`
    SELECT session_id AS sessionId, json_extract(payload, '$.requestId') AS requestId
    FROM events
    WHERE kind IN ('user_question', 'user_question_resolved')
    GROUP BY session_id, json_extract(payload, '$.requestId')
    HAVING SUM(CASE WHEN kind = 'user_question' THEN 1 ELSE 0 END) > 0
       AND SUM(CASE WHEN kind = 'user_question_resolved' THEN 1 ELSE 0 END) = 0
    ORDER BY MIN(seq)
  `).all();
}

/** A file request's transport identity cannot be reused after completion or restart. */
export function hasFileRequest(db: Database.Database, sessionId: string, requestId: string): boolean {
  return db.prepare<[string, string], { present: number }>(
    "SELECT 1 AS present FROM events WHERE session_id = ? AND kind = 'file_request' AND json_extract(payload, '$.requestId') = ? LIMIT 1",
  ).get(sessionId, requestId) !== undefined;
}

/** A persisted request cannot restore a lost agent HTTP connection after restart. */
export function orphanedFileRequests(db: Database.Database): Array<{ sessionId: string; requestId: string }> {
  return db.prepare<[], { sessionId: string; requestId: string }>(`
    SELECT session_id AS sessionId, json_extract(payload, '$.requestId') AS requestId
    FROM events
    WHERE kind IN ('file_request', 'file_request_resolved')
    GROUP BY session_id, json_extract(payload, '$.requestId')
    HAVING SUM(CASE WHEN kind = 'file_request' THEN 1 ELSE 0 END) > 0
       AND SUM(CASE WHEN kind = 'file_request_resolved' THEN 1 ELSE 0 END) = 0
    ORDER BY MIN(seq)
  `).all();
}

/**
 * Apaga os `terminal_output` mais antigos de uma sessão (por seq) até liberar pelo menos `bytes` bytes de `data`.
 * Só toca nessa sessão e nesse tipo de evento. Devolve quantos bytes saíram.
 */
export function dropOldestTerminalOutput(db: Database.Database, sessionId: string, bytes: number): number {
  return db.transaction((): number => {
    const oldest = db.prepare<[string], { seq: number; size: number }>(
      "SELECT seq, LENGTH(CAST(json_extract(payload, '$.data') AS BLOB)) AS size FROM events WHERE session_id = ? AND kind = 'terminal_output' ORDER BY seq",
    );
    let freed = 0;
    let last: number | undefined;
    for (const row of oldest.iterate(sessionId)) {
      if (freed >= bytes) break;
      freed += row.size;
      last = row.seq;
    }
    if (last === undefined) return 0;
    db.prepare<[string, number]>(
      "DELETE FROM events WHERE session_id = ? AND kind = 'terminal_output' AND seq <= ?",
    ).run(sessionId, last);
    return freed;
  })();
}

interface EventDbRow {
  seq: number;
  session_id: string;
  ts: number;
  kind: string;
  payload: string;
}

/** Eventos de uma sessão com seq > afterSeq, em ordem, até `limit`. Valida cada um com o schema do shared. */
export function listEvents(
  db: Database.Database,
  sessionId: string,
  afterSeq: number,
  limit: number,
): SessionEvent[] {
  return db
    .prepare<[string, number, number], EventDbRow>(
      'SELECT seq, session_id, ts, kind, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    )
    .all(sessionId, afterSeq, limit)
    .map((row) => {
      const fields: unknown = JSON.parse(row.payload);
      return SessionEventSchema.parse({
        ...(typeof fields === 'object' && fields !== null ? fields : {}),
        seq: row.seq,
        sessionId: row.session_id,
        ts: row.ts,
        kind: row.kind,
      });
    });
}

/**
 * Each word of the query becomes a quoted prefix term (`"word"*`). Only letters, marks and digits pass, so typed text
 * never turns into an FTS5 operator. A query with no word has nothing to search for.
 */
function matchExpressionOf(query: string): string | undefined {
  const words = query.match(/[\p{L}\p{M}\p{N}]+/gu);
  return words === null ? undefined : words.map((word) => `"${word}"*`).join(' ');
}

/**
 * Searches the user and agent messages (the `message_search` FTS5 index, migration 10). Every word must be in the same
 * message; accents and case do not count. One row per session: its newest matching message, with that message's
 * snippet. Sessions of a deleted workspace are left out, since the screens cannot open them. `workspaceId` narrows the
 * search to one workspace. Values go in as bound parameters.
 */
export function searchSessionMessages(
  db: Database.Database,
  options: { query: string; limit: number; workspaceId?: string | null },
): SessionSearchResult[] {
  const match = matchExpressionOf(options.query);
  if (match === undefined) return [];
  const workspace = options.workspaceId ?? null;
  return db
    .prepare<[string, string | null, string | null, number], SessionSearchResult>(
      `WITH hits AS (
         SELECT session_id, ts, rowid AS row_id,
                snippet(message_search, 0, '', '', '…', 16) AS snippet
         FROM message_search
         WHERE message_search MATCH ?
       ),
       newest AS (
         SELECT session_id, ts, row_id, snippet,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, row_id DESC) AS rank_in_session
         FROM hits
       )
       SELECT newest.session_id AS sessionId, sessions.workspace_id AS workspaceId, sessions.title AS title,
              newest.snippet AS snippet, newest.ts AS matchedAt
       FROM newest
       JOIN sessions ON sessions.id = newest.session_id
       JOIN workspaces ON workspaces.id = sessions.workspace_id
       WHERE newest.rank_in_session = 1 AND sessions.automation_run_id IS NULL AND (? IS NULL OR sessions.workspace_id = ?)
       ORDER BY newest.ts DESC, newest.session_id
       LIMIT ?`,
    )
    .all(match, workspace, workspace, options.limit);
}

interface LoopDbRow {
  session_id: string;
  prompt: string;
  mode: string;
  interval_ms: number | null;
  max_iterations: number | null;
  iterations: number;
  state: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
}

const LOOP_COLUMNS =
  'session_id, prompt, mode, interval_ms, max_iterations, iterations, state, next_run_at, last_run_at, last_error, created_at';

/** Valida a linha com o schema do shared (modo e estado viram tipos confiáveis). */
function toLoop(row: LoopDbRow): StoredLoop {
  return StoredLoopSchema.parse({
    sessionId: row.session_id,
    prompt: row.prompt,
    mode: row.mode,
    intervalMs: row.interval_ms,
    maxIterations: row.max_iterations,
    iterations: row.iterations,
    state: row.state,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  });
}

/**
 * Loop como fica na tabela: o `Loop` sem `revision`. A revisão é do processo (ordem dos snapshots), não do banco;
 * quem publica acrescenta (LoopRunner).
 */
export type StoredLoop = Omit<Loop, 'revision'>;

const StoredLoopSchema = LoopSchema.omit({ revision: true });

/** Loop da sessão (uma por sessão), ou undefined se ela não tem. */
export function findLoop(db: Database.Database, sessionId: string): StoredLoop | undefined {
  const row = db.prepare<[string], LoopDbRow>(`SELECT ${LOOP_COLUMNS} FROM loops WHERE session_id = ?`).get(sessionId);
  return row === undefined ? undefined : toLoop(row);
}

/** Loops ativos (state `active`) de todas as sessões: os que um start precisa reagendar. */
export function listActiveLoops(db: Database.Database): StoredLoop[] {
  return db
    .prepare<[], LoopDbRow>(`SELECT ${LOOP_COLUMNS} FROM loops WHERE state = 'active' ORDER BY created_at, rowid`)
    .all()
    .map(toLoop);
}

/** Grava o loop da sessão, trocando o que houver (PUT). */
export function replaceLoop(db: Database.Database, loop: StoredLoop): void {
  db.prepare<[string, string, string, number | null, number | null, number, string, number | null, number | null, string | null, number]>(
    `INSERT OR REPLACE INTO loops (${LOOP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    loop.sessionId,
    loop.prompt,
    loop.mode,
    loop.intervalMs,
    loop.maxIterations,
    loop.iterations,
    loop.state,
    loop.nextRunAt,
    loop.lastRunAt,
    loop.lastError,
    loop.createdAt,
  );
}

/** Campos de um loop que mudam depois de criado. Os nomes de coluna são fixos (nada vem do usuário). */
export interface LoopChanges {
  state?: Loop['state'];
  iterations?: number;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastError?: string | null;
}

/** Atualiza só os campos informados. Loop inexistente não faz nada. */
export function updateLoop(db: Database.Database, sessionId: string, changes: LoopChanges): void {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  if (changes.state !== undefined) {
    assignments.push('state = ?');
    values.push(changes.state);
  }
  if (changes.iterations !== undefined) {
    assignments.push('iterations = ?');
    values.push(changes.iterations);
  }
  if (changes.nextRunAt !== undefined) {
    assignments.push('next_run_at = ?');
    values.push(changes.nextRunAt);
  }
  if (changes.lastRunAt !== undefined) {
    assignments.push('last_run_at = ?');
    values.push(changes.lastRunAt);
  }
  if (changes.lastError !== undefined) {
    assignments.push('last_error = ?');
    values.push(changes.lastError);
  }
  if (assignments.length === 0) return;
  db.prepare<Array<string | number | null>>(`UPDATE loops SET ${assignments.join(', ')} WHERE session_id = ?`).run(
    ...values,
    sessionId,
  );
}

/** Apaga o loop da sessão, se houver. */
export function deleteLoop(db: Database.Database, sessionId: string): void {
  db.prepare<[string]>('DELETE FROM loops WHERE session_id = ?').run(sessionId);
}

export type FileDirection = 'to_phone' | 'from_phone';

/** Arquivo gravado em `<NANACHI_HOME>/files/<sessionId>/`. `path` é absoluto. */
export interface FileRecord {
  id: string;
  sessionId: string;
  name: string;
  mime: string;
  size: number;
  direction: FileDirection;
  path: string;
  createdAt: number;
}

interface FileDbRow {
  id: string;
  session_id: string;
  name: string;
  mime: string;
  size: number;
  direction: FileDirection;
  path: string;
  created_at: number;
}

function toFileRecord(row: FileDbRow): FileRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    direction: row.direction,
    path: row.path,
    createdAt: row.created_at,
  };
}

/** Quantidade e soma de bytes dos arquivos de uma sessão, nos dois sentidos. */
export function sessionFileUsage(db: Database.Database, sessionId: string): { count: number; bytes: number } {
  const row = db
    .prepare<[string], { count: number; bytes: number }>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files WHERE session_id = ?',
    )
    .get(sessionId);
  return row ?? { count: 0, bytes: 0 };
}

export function insertFile(db: Database.Database, file: FileRecord): void {
  db.prepare<[string, string, string, string, number, string, string, number]>(
    'INSERT INTO files (id, session_id, name, mime, size, direction, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(file.id, file.sessionId, file.name, file.mime, file.size, file.direction, file.path, file.createdAt);
}

export function findFileById(db: Database.Database, id: string): FileRecord | undefined {
  const row = db
    .prepare<[string], FileDbRow>(
      'SELECT id, session_id, name, mime, size, direction, path, created_at FROM files WHERE id = ?',
    )
    .get(id);
  return row === undefined ? undefined : toFileRecord(row);
}

/**
 * Web Push subscription: `keys` already validated (p256dh + auth). `language` is the device's language when it sent one
 * (null = unknown: the texts go out in pt-BR).
 */
export interface PushSubscriptionRow {
  endpoint: string;
  deviceId: string;
  keys: { p256dh: string; auth: string };
  language: AppLanguage | null;
}

interface PushSubscriptionDbRow {
  endpoint: string;
  device_id: string;
  keys: string;
  language: string | null;
}

/** Device dono de uma inscrição, ou undefined se o endpoint não está cadastrado. */
export function findPushSubscriptionOwner(db: Database.Database, endpoint: string): string | undefined {
  return db
    .prepare<[string], { device_id: string }>('SELECT device_id FROM push_subscriptions WHERE endpoint = ?')
    .get(endpoint)?.device_id;
}

/**
 * Inserts, or if the endpoint already exists, replaces the owner and the keys (the endpoint identifies the subscription).
 * A language sent replaces the stored one; without one (older client) the stored one is kept.
 */
export function upsertPushSubscription(
  db: Database.Database,
  subscription: {
    endpoint: string;
    deviceId: string;
    keys: { p256dh: string; auth: string };
    language?: AppLanguage | undefined;
    createdAt: number;
  },
): void {
  db.prepare<[string, string, string, string | null, number]>(
    `INSERT INTO push_subscriptions (endpoint, device_id, keys, language, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET
       device_id = excluded.device_id,
       keys = excluded.keys,
       language = COALESCE(excluded.language, push_subscriptions.language)`,
  ).run(
    subscription.endpoint,
    subscription.deviceId,
    JSON.stringify(subscription.keys),
    subscription.language ?? null,
    subscription.createdAt,
  );
}

/** Apaga a inscrição; com `deviceId`, só se ela for desse dispositivo. Devolve false se nada foi apagado. */
export function deletePushSubscription(db: Database.Database, endpoint: string, deviceId?: string): boolean {
  const result =
    deviceId === undefined
      ? db.prepare<[string]>('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
      : db
          .prepare<[string, string]>('DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id = ?')
          .run(endpoint, deviceId);
  return result.changes > 0;
}

/**
 * Todas as inscrições, com as chaves validadas pelo schema do shared. Com `activeSince`, só as de devices não revogados
 * que usaram a API desde esse instante: device parado além do prazo não recebe push.
 */
export function listPushSubscriptions(db: Database.Database, activeSince?: number): PushSubscriptionRow[] {
  const rows =
    activeSince === undefined
      ? db
          .prepare<[], PushSubscriptionDbRow>(
            'SELECT endpoint, device_id, keys, language FROM push_subscriptions ORDER BY created_at, rowid',
          )
          .all()
      : db
          .prepare<[number], PushSubscriptionDbRow>(
            `SELECT s.endpoint, s.device_id, s.keys, s.language FROM push_subscriptions s
             JOIN devices d ON d.id = s.device_id
             WHERE d.revoked_at IS NULL AND COALESCE(d.last_seen_at, d.created_at) >= ?
             ORDER BY s.created_at, s.rowid`,
          )
          .all(activeSince);
  return rows.map((row) => ({
    endpoint: row.endpoint,
    deviceId: row.device_id,
    keys: PushSubscriptionRequestSchema.shape.keys.parse(JSON.parse(row.keys)),
    // A value outside the list (never written by the daemon) falls back to the default, like an old subscription.
    language: AppLanguageSchema.safeParse(row.language).data ?? null,
  }));
}

/** Conta extra de um agente (`agent_accounts`). A principal não tem linha: ela é o diretório normal do agente. */
export interface AgentProfileRow {
  id: string;
  agent: string;
  label: string;
  createdAt: number;
}

interface AgentProfileDbRow {
  id: string;
  agent: string;
  label: string;
  created_at: number;
}

const AGENT_PROFILE_COLUMNS = 'id, agent, label, created_at';

function toAgentProfileRow(row: AgentProfileDbRow): AgentProfileRow {
  return { id: row.id, agent: row.agent, label: row.label, createdAt: row.created_at };
}

/** Contas extras de um agente, na ordem de criação. */
export function listAgentProfiles(db: Database.Database, agent: string): AgentProfileRow[] {
  return db
    .prepare<[string], AgentProfileDbRow>(
      `SELECT ${AGENT_PROFILE_COLUMNS} FROM agent_accounts WHERE agent = ? ORDER BY created_at, rowid`,
    )
    .all(agent)
    .map(toAgentProfileRow);
}

export function countAgentProfiles(db: Database.Database, agent: string): number {
  return db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM agent_accounts WHERE agent = ?').get(agent)?.n ?? 0;
}

export function findAgentProfile(db: Database.Database, agent: string, id: string): AgentProfileRow | undefined {
  const row = db
    .prepare<[string, string], AgentProfileDbRow>(
      `SELECT ${AGENT_PROFILE_COLUMNS} FROM agent_accounts WHERE agent = ? AND id = ?`,
    )
    .get(agent, id);
  return row === undefined ? undefined : toAgentProfileRow(row);
}

export function insertAgentProfile(db: Database.Database, profile: AgentProfileRow): void {
  db.prepare<[string, string, string, number]>(
    'INSERT INTO agent_accounts (id, agent, label, created_at) VALUES (?, ?, ?, ?)',
  ).run(profile.id, profile.agent, profile.label, profile.createdAt);
}

/**
 * Inserts the account only if the agent has fewer than `limit` of them. The count and the insert are one transaction, so
 * concurrent callers cannot both pass the check. Returns false (nothing inserted) when the agent is at the limit.
 */
export function insertAgentProfileIfRoom(db: Database.Database, profile: AgentProfileRow, limit: number): boolean {
  return db.transaction((): boolean => {
    if (countAgentProfiles(db, profile.agent) >= limit) return false;
    insertAgentProfile(db, profile);
    return true;
  })();
}

/** Troca o nome da conta. Devolve a conta atualizada, ou undefined se o agente não tem essa conta. */
export function renameAgentProfile(
  db: Database.Database,
  agent: string,
  id: string,
  label: string,
): AgentProfileRow | undefined {
  db.prepare<[string, string, string]>('UPDATE agent_accounts SET label = ? WHERE agent = ? AND id = ?').run(
    label,
    agent,
    id,
  );
  return findAgentProfile(db, agent, id);
}

/** Conta ativa do agente (a que sessões novas usam), ou undefined = principal. */
export function getActiveAccountId(db: Database.Database, agent: string): string | undefined {
  return db
    .prepare<[string], { account_id: string }>('SELECT account_id FROM agent_active_account WHERE agent = ?')
    .get(agent)?.account_id;
}

/** Grava a conta ativa; `null` apaga o ponteiro (volta à principal). */
export function setActiveAccountId(db: Database.Database, agent: string, accountId: string | null): void {
  if (accountId === null) {
    db.prepare<[string]>('DELETE FROM agent_active_account WHERE agent = ?').run(agent);
    return;
  }
  db.prepare<[string, string]>(
    `INSERT INTO agent_active_account (agent, account_id) VALUES (?, ?)
     ON CONFLICT (agent) DO UPDATE SET account_id = excluded.account_id`,
  ).run(agent, accountId);
}

/**
 * Sessões de uma conta com processo vivo ou subindo (`starting`, `running`, `awaiting_permission`, `idle`). Bloqueiam
 * apagar a conta: o processo ainda usa a pasta dela.
 */
export function countBusySessionsOnAccount(db: Database.Database, agent: string, accountId: string): number {
  return (
    db
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM sessions WHERE agent = ? AND account_id = ? AND status IN ('starting', 'running', 'awaiting_permission', 'idle')",
      )
      .get(agent, accountId)?.n ?? 0
  );
}

/**
 * Apaga a conta extra (numa transação): a linha, o ponteiro de conta ativa se apontava para ela (volta à principal)
 * e `account_id` das sessões dela (viram principal). Não mexe na pasta da conta nem confere sessões vivas.
 */
export function removeAgentProfile(db: Database.Database, agent: string, id: string): void {
  db.transaction((): void => {
    db.prepare<[string, string]>('DELETE FROM agent_accounts WHERE agent = ? AND id = ?').run(agent, id);
    db.prepare<[string, string]>('DELETE FROM agent_active_account WHERE agent = ? AND account_id = ?').run(agent, id);
    db.prepare<[string, string]>('UPDATE sessions SET account_id = NULL WHERE agent = ? AND account_id = ?').run(agent, id);
  })();
}
