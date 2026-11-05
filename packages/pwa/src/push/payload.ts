import { DevicePairedPushPayloadSchema, PushPayloadSchema } from '@nanachi/shared';

// The daemon writes push texts in Portuguese, and the service worker cannot read the app language (it must not bundle
// i18next), so the fallback shown for an unreadable payload stays Portuguese too. See the i18n README.
export const FALLBACK_TITLE = 'Nanachi Remote';
export const FALLBACK_BODY = 'Nova atividade no seu PC';

/** Dados que voltam ao service worker no clique: uma sessão, ou a tela de Dispositivos de uma máquina. */
export type NotificationData =
  | { machineId: string; workspaceId: string; sessionId: string }
  | { machineId: string; screen: 'devices' };

export interface PushNotification {
  title: string;
  options: {
    body: string;
    tag: string;
    data?: NotificationData;
  };
}

/**
 * Notificação para um push recebido. O navegador exige que todo push mostre algo, então payload
 * inválido vira notificação genérica, sem dados de navegação.
 */
export function notificationFromPush(data: unknown): PushNotification {
  const parsed = PushPayloadSchema.safeParse(data);
  if (parsed.success) {
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

  const paired = DevicePairedPushPayloadSchema.safeParse(data);
  if (paired.success) {
    const payload = paired.data;
    return {
      title: payload.title,
      options: {
        body: payload.body,
        tag: 'device-paired',
        data: { machineId: payload.machineId, screen: 'devices' },
      },
    };
  }

  return { title: FALLBACK_TITLE, options: { body: FALLBACK_BODY, tag: 'nanachi' } };
}
