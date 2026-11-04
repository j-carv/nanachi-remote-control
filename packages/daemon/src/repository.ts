import { randomUUID } from 'node:crypto';
import {
  AvailableCommandSchema,
  PushSubscriptionRequestSchema,
  SessionConfigOptionSchema,
  SessionEventSchema,
  SessionSchema,
  SessionStatusSchema,
  type AgentKind,
  type AvailableCommand,
  type Session,
  type SessionConfigOption,
  type SessionEvent,
  type SessionStatus,
  type Workspace,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';

export interface Machine {
  id: string;
  name: string;
}

export interface DeviceRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface DeviceDbRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

function toDevice(row: DeviceDbRow): DeviceRow {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
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
  device: { id: string; name: string; tokenHash: string; createdAt: number },
): void {
  db.prepare<[string, string, string, number]>(
    'INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(device.id, device.name, device.tokenHash, device.createdAt);
}

export function findDeviceByTokenHash(db: Database.Database, tokenHash: string): DeviceRow | undefined {
  const row = db
    .prepare<[string], DeviceDbRow>(
      'SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = ?',
    )
    .get(tokenHash);
  return row === undefined ? undefined : toDevice(row);
}

export function touchDevice(db: Database.Database, id: string, at: number): void {
  db.prepare<[number, string]>('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id);
}

export function listDevices(db: Database.Database): DeviceRow[] {
  return db
    .prepare<[], DeviceDbRow>('SELECT id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at')
    .all()
    .map(toDevice);
}

/** Devices não revogados, mais antigos primeiro. */
export function listActiveDevices(db: Database.Database): DeviceRow[] {
  return db
    .prepare<[], DeviceDbRow>(
      'SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at',
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

/** Sessões que estão trabalhando agora (subindo, rodando ou esperando permissão). `idle` não conta: fica parada até o usuário retomar. */
export function countBusySessions(db: Database.Database): number {
  return db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM sessions WHERE status IN ('starting', 'running', 'awaiting_permission')",
    )
    .get()?.n ?? 0;
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
    db.prepare<[string]>('DELETE FROM sessions WHERE id = ?').run(sessionId);
  })();
}

/** Sessões do workspace, mais recente primeiro. */
export function listSessionsByWorkspace(db: Database.Database, workspaceId: string): Session[] {
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
  'id, workspace_id, agent, kind, title, status, worktree, created_at, updated_at';

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
}

export function insertSession(db: Database.Database, session: NewSession): void {
  db.prepare<[string, string, string, string, string, string, string | null, number, number]>(
    `INSERT INTO sessions (id, workspace_id, agent, kind, title, status, config_options, worktree, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
  ).run(
    session.id,
    session.workspaceId,
    session.agent,
    session.kind ?? 'acp',
    session.title,
    session.status,
    session.worktree ? JSON.stringify(session.worktree) : null,
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

/** Opções de configuração que valem agora (coluna `config_options`). Undefined se a sessão não existe. */
export function findSessionConfigOptions(db: Database.Database, id: string): SessionConfigOption[] | undefined {
  const row = db.prepare<[string], { config_options: string }>('SELECT config_options FROM sessions WHERE id = ?').get(id);
  return row === undefined ? undefined : SessionConfigOptionSchema.array().parse(JSON.parse(row.config_options));
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
}

/** Atualiza só os campos informados e `updated_at`. Os nomes de coluna são fixos (nada vem do usuário). */
export function updateSession(db: Database.Database, id: string, changes: SessionChanges, at: number): void {
  const assignments = ['updated_at = ?'];
  const values: Array<string | number> = [at];
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
  db.prepare<Array<string | number>>(`UPDATE sessions SET ${assignments.join(', ')} WHERE id = ?`).run(
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

/** Inscrição de Web Push: `keys` já validado (p256dh + auth). */
export interface PushSubscriptionRow {
  endpoint: string;
  deviceId: string;
  keys: { p256dh: string; auth: string };
}

interface PushSubscriptionDbRow {
  endpoint: string;
  device_id: string;
  keys: string;
}

/** Device dono de uma inscrição, ou undefined se o endpoint não está cadastrado. */
export function findPushSubscriptionOwner(db: Database.Database, endpoint: string): string | undefined {
  return db
    .prepare<[string], { device_id: string }>('SELECT device_id FROM push_subscriptions WHERE endpoint = ?')
    .get(endpoint)?.device_id;
}

/** Insere ou, se o endpoint já existe, troca o dono e as chaves (o endpoint identifica a inscrição). */
export function upsertPushSubscription(
  db: Database.Database,
  subscription: { endpoint: string; deviceId: string; keys: { p256dh: string; auth: string }; createdAt: number },
): void {
  db.prepare<[string, string, string, number]>(
    `INSERT INTO push_subscriptions (endpoint, device_id, keys, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET device_id = excluded.device_id, keys = excluded.keys`,
  ).run(subscription.endpoint, subscription.deviceId, JSON.stringify(subscription.keys), subscription.createdAt);
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

/** Todas as inscrições, com as chaves validadas pelo schema do shared. */
export function listPushSubscriptions(db: Database.Database): PushSubscriptionRow[] {
  return db
    .prepare<[], PushSubscriptionDbRow>('SELECT endpoint, device_id, keys FROM push_subscriptions ORDER BY created_at, rowid')
    .all()
    .map((row) => ({
      endpoint: row.endpoint,
      deviceId: row.device_id,
      keys: PushSubscriptionRequestSchema.shape.keys.parse(JSON.parse(row.keys)),
    }));
}
