import { z } from 'zod';

/**
 * Conteúdo da notificação Web Push enviada ao device (JSON no corpo do push).
 * Só vai para devices sem nenhuma conexão WS aberta.
 */
export const PushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  machineId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum(['turn_end', 'permission_request', 'error', 'file']),
});

export type PushPayload = z.infer<typeof PushPayloadSchema>;
