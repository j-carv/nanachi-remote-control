import { z } from 'zod';

/**
 * Conteúdo da notificação Web Push enviada ao device (JSON no corpo do push).
 * Not sent to a device with an open WS that follows the session itself (the app already shows what happened there).
 */
export const PushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  machineId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum(['turn_end', 'permission_request', 'user_question', 'file_request', 'preview', 'error', 'file', 'loop_paused']),
});

export type PushPayload = z.infer<typeof PushPayloadSchema>;

/**
 * Aviso de pareamento novo (Entrar com Tailscale): não é de sessão, então não tem workspace nem sessão.
 * Vai para os outros devices com inscrição de push, com ou sem WS aberto (o app não mostra pareamento).
 */
export const DevicePairedPushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  machineId: z.string().min(1),
  kind: z.literal('device_paired'),
});

export type DevicePairedPushPayload = z.infer<typeof DevicePairedPushPayloadSchema>;
