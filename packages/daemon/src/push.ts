import { PushPayloadSchema } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import webpush, { type PushSubscription, type RequestOptions } from 'web-push';
import type { NotifyDetails, NotifyKind } from './notify.js';
import type { LiveConnections } from './live-connections.js';
import {
  deletePushSubscription,
  findSessionById,
  findWorkspaceById,
  listPushSubscriptions,
  type PushSubscriptionRow,
} from './repository.js';
import type { VapidConfig } from './vapid.js';

/** Validade da notificação no serviço de push: 1 h. Passou disso, não adianta entregar. */
export const PUSH_TTL_SECONDS = 3600;
/** Teto de espera por resposta do serviço: sem ele, um serviço travado prende o socket para sempre. */
const PUSH_TIMEOUT_MS = 10_000;
/** Push de arquivo: no máximo um por sessão nesse intervalo. Os demais arquivos só geram o evento. */
export const FILE_PUSH_INTERVAL_MS = 60_000;
/** Mensagem de erro no corpo da notificação. */
const ERROR_MESSAGE_MAX_CHARS = 120;

/** Assinatura de `sendNotification` do web-push. Testes injetam um fake. */
export type SendNotification = (
  subscription: PushSubscription,
  payload: string,
  options: RequestOptions,
) => Promise<unknown>;

export interface PushNotifierDeps {
  db: Database.Database;
  machineId: string;
  vapid: VapidConfig;
  /** Devices com WS aberto não recebem push (o app já mostra a mensagem). */
  connections: Pick<LiveConnections, 'hasLiveConnection'>;
  /** Padrão: `sendNotification` do web-push. */
  send?: SendNotification | undefined;
  /** Relógio em ms (janela de arquivos). Padrão: Date.now. Testes passam um fake. */
  now?: (() => number) | undefined;
  /** Log de falhas. Nunca recebe endpoint nem payload. */
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PushNotifier {
  /**
   * Handler de `onNotify`. Devolve a promise só para quem quer esperar a entrega (testes).
   * Nunca rejeita: qualquer falha vai para `warn`.
   */
  notify(sessionId: string, kind: NotifyKind, details: NotifyDetails): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Status HTTP do serviço de push (WebPushError tem `statusCode`); undefined para erro de rede. */
function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return undefined;
}

/** Colapsa espaços e corta em `max` caracteres (com reticências quando corta). */
function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

function bodyOf(details: NotifyDetails, sessionTitle: string): string {
  switch (details.kind) {
    case 'turn_end':
      return `Terminou: ${sessionTitle}`;
    case 'terminal_exit':
      return 'Terminal encerrado';
    case 'permission_request':
      return `Pede aprovação: ${details.title}`;
    case 'error':
      return `Erro: ${shorten(details.message, ERROR_MESSAGE_MAX_CHARS)}`;
    case 'file':
      return `Arquivo: ${details.name}`;
  }
}

function optionsFor(kind: NotifyKind, vapid: VapidConfig): RequestOptions {
  return {
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: PUSH_TTL_SECONDS,
    urgency: kind === 'permission_request' ? 'high' : 'normal',
    contentEncoding: 'aes128gcm',
    timeout: PUSH_TIMEOUT_MS,
  };
}

/**
 * Notificador de Web Push: monta o aviso, pula workspace mudo e devices com WS aberto, envia a cada inscrição.
 * 404/410 do serviço apagam a inscrição; outros erros viram warn e não afetam a sessão nem as outras entregas.
 */
export function createPushNotifier(deps: PushNotifierDeps): PushNotifier {
  const send: SendNotification = deps.send ?? webpush.sendNotification;
  const now = deps.now ?? Date.now;
  /** Último instante em que uma sessão mandou push de arquivo. */
  const lastFilePushAt = new Map<string, number>();

  /** Arquivos em rajada: passa só o primeiro da janela de FILE_PUSH_INTERVAL_MS por sessão. */
  function fileThrottled(sessionId: string): boolean {
    const at = now();
    const last = lastFilePushAt.get(sessionId);
    if (last !== undefined && at - last < FILE_PUSH_INTERVAL_MS) return true;
    lastFilePushAt.set(sessionId, at);
    return false;
  }

  async function deliverTo(target: PushSubscriptionRow, payload: string, kind: NotifyKind): Promise<void> {
    try {
      await send({ endpoint: target.endpoint, keys: target.keys }, payload, optionsFor(kind, deps.vapid));
    } catch (error) {
      const statusCode = statusOf(error);
      if (statusCode === 404 || statusCode === 410) {
        deletePushSubscription(deps.db, target.endpoint);
        return;
      }
      deps.warn({ statusCode, deviceId: target.deviceId, reason: messageOf(error) }, 'push não entregue');
    }
  }

  async function deliver(sessionId: string, kind: NotifyKind, details: NotifyDetails): Promise<void> {
    const session = findSessionById(deps.db, sessionId);
    if (session === undefined) return;
    const workspace = findWorkspaceById(deps.db, session.workspaceId);
    if (workspace === undefined || workspace.muted) return;

    const parsed = PushPayloadSchema.safeParse({
      title: workspace.name,
      body: bodyOf(details, session.title),
      machineId: deps.machineId,
      workspaceId: workspace.id,
      sessionId,
      kind,
    });
    if (!parsed.success) {
      deps.warn({ kind, issues: parsed.error.issues.length }, 'payload de push fora do schema');
      return;
    }

    const payload = JSON.stringify(parsed.data);
    const targets = listPushSubscriptions(deps.db).filter((target) => !deps.connections.hasLiveConnection(target.deviceId));
    await Promise.all(targets.map((target) => deliverTo(target, payload, kind)));
  }

  return {
    async notify(sessionId, kind, details) {
      if (kind === 'file' && fileThrottled(sessionId)) return;
      try {
        await deliver(sessionId, kind, details);
      } catch (error) {
        deps.warn({ kind, reason: messageOf(error) }, 'falha ao montar ou enviar push');
      }
    },
  };
}
