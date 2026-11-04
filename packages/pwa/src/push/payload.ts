import { PushPayloadSchema } from '@nanachi/shared';

export const FALLBACK_TITLE = 'Nanachi Remote';
export const FALLBACK_BODY = 'Nova atividade no seu PC';

export interface PushNotification {
  title: string;
  options: {
    body: string;
    tag: string;
    data?: { machineId: string; workspaceId: string; sessionId: string };
  };
}

/**
 * Notificação para um push recebido. O navegador exige que todo push mostre algo, então payload
 * inválido vira notificação genérica, sem dados de navegação.
 */
export function notificationFromPush(data: unknown): PushNotification {
  const parsed = PushPayloadSchema.safeParse(data);
  if (!parsed.success) {
    return { title: FALLBACK_TITLE, options: { body: FALLBACK_BODY, tag: 'nanachi' } };
  }
  const payload = parsed.data;
  return {
    title: payload.title,
    options: {
      body: payload.body,
      tag: payload.sessionId,
      data: {
        machineId: payload.machineId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
      },
    },
  };
}
