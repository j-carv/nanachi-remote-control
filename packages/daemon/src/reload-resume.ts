import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { SessionStatus } from '@nanachi/shared';
import { listIdleAcpSessionIds } from './repository.js';

/** `<NANACHI_HOME>/resume-after-reload.json`: sessões ociosas que o reload deixou para trás. */
export const RESUME_FILE_NAME = 'resume-after-reload.json';
/** Arquivo mais velho que isto é de outra história (o daemon foi reiniciado à mão depois): é ignorado. */
export const RESUME_MAX_AGE_MS = 10 * 60_000;
/** Retomadas simultâneas na subida: cada uma sobe um processo de agente. */
export const RESUME_CONCURRENCY = 2;

export interface ResumeLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/**
 * Chamado no shutdown por reload, antes de matar os agentes: grava as sessões ACP `idle` (vivas para o usuário).
 * Não muda o banco; quem sobe depois marca tudo como `stopped` e retoma esta lista. Devolve os ids gravados.
 */
export function saveIdleSessionsForReload(db: Database.Database, home: string, at: number): string[] {
  const sessionIds = listIdleAcpSessionIds(db);
  writeFileSync(join(home, RESUME_FILE_NAME), `${JSON.stringify({ savedAt: at, sessionIds })}\n`, 'utf8');
  return sessionIds;
}

/**
 * Lê e apaga o arquivo na subida. Sem arquivo, velho ou ilegível, devolve lista vazia (o arquivo é apagado
 * de qualquer jeito, para não ser lido de novo numa subida futura).
 */
export function takeResumeAfterReload(home: string, now: number): string[] {
  const file = join(home, RESUME_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  rmSync(file, { force: true });
  const parsed = parseResumeFile(raw);
  if (parsed === undefined || now - parsed.savedAt > RESUME_MAX_AGE_MS) return [];
  return parsed.sessionIds;
}

function parseResumeFile(raw: string): { savedAt: number; sessionIds: string[] } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || !('savedAt' in value) || !('sessionIds' in value)) {
    return undefined;
  }
  const { savedAt, sessionIds } = value;
  if (typeof savedAt !== 'number' || !Array.isArray(sessionIds)) return undefined;
  if (!sessionIds.every((id): id is string => typeof id === 'string')) return undefined;
  return { savedAt, sessionIds };
}

export interface ResumeAfterReloadDeps {
  /** Retoma uma sessão (o mesmo caminho do POST /api/sessions/:id/resume). Lança se não dá. */
  resume(sessionId: string): Promise<{ status: SessionStatus }>;
  log: ResumeLog;
  /** Padrão: `RESUME_CONCURRENCY`. */
  concurrency?: number;
}

/**
 * Retoma as sessões em fila, no máximo `concurrency` por vez. Falha de uma sessão vira aviso no log e não
 * impede as outras: a sessão continua como estava (stopped, ou error se o agente falhou ao carregar).
 */
export async function resumeAfterReload(sessionIds: readonly string[], deps: ResumeAfterReloadDeps): Promise<void> {
  if (sessionIds.length === 0) return;
  const { resume, log } = deps;
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? RESUME_CONCURRENCY, sessionIds.length));
  log.info({ count: sessionIds.length }, `retomando ${sessionIds.length} sessão(ões) depois do reload`);

  const queue = [...sessionIds];
  const worker = async (): Promise<void> => {
    for (let sessionId = queue.shift(); sessionId !== undefined; sessionId = queue.shift()) {
      try {
        const session = await resume(sessionId);
        if (session.status === 'idle') {
          log.info({ sessionId }, 'sessão retomada depois do reload');
        } else {
          log.warn({ sessionId, status: session.status }, 'não retomou sessão após reload: ela ficou como está');
        }
      } catch (error) {
        log.warn({ sessionId, err: messageOf(error) }, 'não retomou sessão após reload: ela ficou parada');
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
