import { DevicePairedPushPayloadSchema, PushPayloadSchema, type AppLanguage } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import webpush, { type PushSubscription, type RequestOptions } from 'web-push';
import type { NotifyDetails, NotifyKind } from './notify.js';
import type { LiveConnections } from './live-connections.js';
import { pushTextOf, type PushText } from './push-text.js';
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
/** Nome do aparelho no aviso de pareamento (o nome vem do cliente, então é cortado). */
const DEVICE_NAME_MAX_CHARS = 64;
/** Título da permissão: é o comando da ferramenta, que pode ser longo. Passa do limite do Web Push (4 KB) = não entrega. */
const PERMISSION_TITLE_MAX_CHARS = 120;

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
  /**
   * A device with an open WS following the session does not get that session's push (the app already shows it). Other
   * sessions and other screens receive it normally.
   */
  connections: Pick<LiveConnections, 'hasLiveSubscription'>;
  /** Padrão: `sendNotification` do web-push. */
  send?: SendNotification | undefined;
  /** Relógio em ms (janela de arquivos). Padrão: Date.now. Testes passam um fake. */
  now?: (() => number) | undefined;
  /** Prazo de inatividade do device (`inactivityLimitMs`): device parado além dele não recebe push. Padrão: sem prazo. */
  inactivityMs?: number | null | undefined;
  /** Log de falhas. Nunca recebe endpoint nem payload. */
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PushNotifier {
  /**
   * Handler de `onNotify`. Devolve a promise só para quem quer esperar a entrega (testes).
   * Nunca rejeita: qualquer falha vai para `warn`.
   */
  notify(sessionId: string, kind: NotifyKind, details: NotifyDetails): Promise<void>;
  /**
   * Aviso de pareamento por Tailscale (PLAN.md, "Entrar com Tailscale") para os outros devices com inscrição.
   * Não passa pela fila de sessão. Nunca rejeita: falhas vão para `warn`.
   */
  notifyDevicePaired(deviceId: string, deviceName: string): Promise<void>;
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

/** Título da notificação: o nome do workspace, exceto no aviso de loop pausado (que diz o que aconteceu). */
function titleOf(details: NotifyDetails, workspaceName: string, text: PushText): string {
  return details.kind === 'loop_paused' ? text.loopPausedTitle : workspaceName;
}

function bodyOf(details: NotifyDetails, sessionTitle: string, text: PushText): string {
  switch (details.kind) {
    case 'loop_paused':
      return text.loopPaused(sessionTitle, shorten(details.message, ERROR_MESSAGE_MAX_CHARS));
    case 'turn_end':
      return text.turnEnd(sessionTitle);
    case 'terminal_exit':
      return text.terminalExit;
    case 'permission_request': {
      const title = shorten(details.title, PERMISSION_TITLE_MAX_CHARS);
      return title === '' ? text.permissionRequestUntitled : text.permissionRequest(title);
    }
    case 'user_question':
      return text.userQuestion(shorten(details.question, PERMISSION_TITLE_MAX_CHARS));
    case 'file_request':
      return text.fileRequest(shorten(details.prompt, PERMISSION_TITLE_MAX_CHARS));
    case 'preview':
      return text.preview(shorten(details.title, PERMISSION_TITLE_MAX_CHARS));
    case 'error':
      return text.error(shorten(details.message, ERROR_MESSAGE_MAX_CHARS));
    case 'file':
      return text.file(details.name);
  }
}

function optionsFor(urgency: 'high' | 'normal', vapid: VapidConfig): RequestOptions {
  return {
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: PUSH_TTL_SECONDS,
    urgency,
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

  /** Subscriptions que ainda valem: sem prazo, todas; com prazo, só de devices usados dentro dele. */
  function recipients(): PushSubscriptionRow[] {
    const inactivityMs = deps.inactivityMs;
    return listPushSubscriptions(deps.db, inactivityMs === undefined || inactivityMs === null ? undefined : now() - inactivityMs);
  }

  /** Arquivos em rajada: passa só o primeiro da janela de FILE_PUSH_INTERVAL_MS por sessão. */
  function fileThrottled(sessionId: string): boolean {
    const at = now();
    const last = lastFilePushAt.get(sessionId);
    if (last !== undefined && at - last < FILE_PUSH_INTERVAL_MS) return true;
    lastFilePushAt.set(sessionId, at);
    return false;
  }

  async function deliverTo(
    target: PushSubscriptionRow,
    payload: string,
    urgency: 'high' | 'normal',
  ): Promise<void> {
    try {
      await send({ endpoint: target.endpoint, keys: target.keys }, payload, optionsFor(urgency, deps.vapid));
    } catch (error) {
      const statusCode = statusOf(error);
      if (statusCode === 404 || statusCode === 410) {
        deletePushSubscription(deps.db, target.endpoint);
        return;
      }
      deps.warn({ statusCode, deviceId: target.deviceId, reason: messageOf(error) }, 'push não entregue');
    }
  }

  /**
   * Sends one notice to each group of devices sharing a language, with that language's texts. `build` returns the
   * payload JSON for the given texts, or undefined (payload outside the schema, already reported): that group gets nothing.
   */
  async function deliverByLanguage(
    targets: PushSubscriptionRow[],
    urgency: 'high' | 'normal',
    build: (text: PushText) => string | undefined,
  ): Promise<void> {
    const groups = new Map<AppLanguage | null, PushSubscriptionRow[]>();
    for (const target of targets) {
      groups.set(target.language, [...(groups.get(target.language) ?? []), target]);
    }
    await Promise.all(
      [...groups].map(async ([language, group]) => {
        const payload = build(pushTextOf(language));
        if (payload === undefined) return;
        await Promise.all(group.map((target) => deliverTo(target, payload, urgency)));
      }),
    );
  }

  async function deliver(sessionId: string, kind: NotifyKind, details: NotifyDetails): Promise<void> {
    const session = findSessionById(deps.db, sessionId);
    if (session === undefined) return;
    const workspace = findWorkspaceById(deps.db, session.workspaceId);
    if (workspace === undefined || workspace.muted) return;

    // Devices with an open WS on this session already see it in the app: only they are left out.
    const targets = recipients().filter((target) => !deps.connections.hasLiveSubscription(target.deviceId, sessionId));
    const urgency = kind === 'permission_request' || kind === 'user_question' || kind === 'file_request' ? 'high' : 'normal';
    await deliverByLanguage(targets, urgency, (text) => {
      const parsed = PushPayloadSchema.safeParse({
        title: titleOf(details, workspace.name, text),
        body: bodyOf(details, session.title, text),
        machineId: deps.machineId,
        workspaceId: workspace.id,
        sessionId,
        kind,
      });
      if (!parsed.success) {
        deps.warn({ kind, issues: parsed.error.issues.length }, 'payload de push fora do schema');
        return undefined;
      }
      return JSON.stringify(parsed.data);
    });
  }

  /** Só o aviso de pareamento: sem sessão nem workspace, e sem o filtro de WS aberto (ver DevicePairedPushPayloadSchema). */
  async function deliverDevicePaired(deviceId: string, deviceName: string): Promise<void> {
    const targets = recipients().filter((target) => target.deviceId !== deviceId);
    await deliverByLanguage(targets, 'normal', (text) => {
      const parsed = DevicePairedPushPayloadSchema.safeParse({
        title: text.pairedTitle,
        body: text.devicePaired(shorten(deviceName, DEVICE_NAME_MAX_CHARS)),
        machineId: deps.machineId,
        kind: 'device_paired',
      });
      if (!parsed.success) {
        deps.warn({ issues: parsed.error.issues.length }, 'payload de aviso de pareamento fora do schema');
        return undefined;
      }
      return JSON.stringify(parsed.data);
    });
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
    async notifyDevicePaired(deviceId, deviceName) {
      try {
        await deliverDevicePaired(deviceId, deviceName);
      } catch (error) {
        deps.warn({ reason: messageOf(error) }, 'falha ao avisar pareamento por push');
      }
    },
  };
}
