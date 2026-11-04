import type { z } from 'zod';
import { ClientMessageSchema, ServerMessageSchema } from './ws.js';
import type { ClientMessage, ServerMessage } from './ws.js';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }

  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };

  const error = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, error };
}

/** Valida uma mensagem recebida do cliente. Nunca lança. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseWith(ClientMessageSchema, raw);
}

/** Valida uma mensagem recebida do servidor. Nunca lança. */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseWith(ServerMessageSchema, raw);
}
