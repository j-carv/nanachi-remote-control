import { z } from 'zod';
import {
  AvailableCommandSchema,
  ConfigValueSchema,
  SessionConfigOptionSchema,
  SessionEventSchema,
  SessionSchema,
} from './session.js';

const IdSchema = z.string().min(1);

/** Mensagens enviadas pelo cliente (PWA) em `/ws`. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('subscribe'),
    sessionId: IdSchema,
    afterSeq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('unsubscribe'), sessionId: IdSchema }),
  z
    .object({
      type: z.literal('prompt'),
      sessionId: IdSchema,
      text: z.string().max(100_000),
      /** fileIds da mesma sessão (anexos enviados antes via POST /api/sessions/:id/attachments). */
      attachments: z.array(IdSchema).max(10).optional(),
    })
    .refine((msg) => msg.text.length > 0 || (msg.attachments?.length ?? 0) > 0, {
      message: 'text é obrigatório quando não há anexos',
      path: ['text'],
    }),
  z.object({
    type: z.literal('permission_response'),
    sessionId: IdSchema,
    requestId: IdSchema,
    optionId: IdSchema.nullable(),
  }),
  z.object({ type: z.literal('cancel'), sessionId: IdSchema }),
  z.object({
    type: z.literal('set_config'),
    sessionId: IdSchema,
    configId: IdSchema,
    value: ConfigValueSchema,
  }),
  /** Bytes digitados no terminal da sessão PTY (texto ou sequências de controle). */
  z.object({
    type: z.literal('terminal_input'),
    sessionId: IdSchema,
    data: z.string().min(1).max(65_536),
  }),
  z.object({
    type: z.literal('terminal_resize'),
    sessionId: IdSchema,
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(5).max(200),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Mensagens enviadas pelo servidor (daemon) em `/ws`. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    machineId: z.string().min(1),
    machineName: z.string().min(1),
  }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('event'), event: SessionEventSchema }),
  z.object({ type: z.literal('session'), session: SessionSchema }),
  /**
   * Lista de comandos da sessão, só para quem está inscrito nela: no subscribe (depois do replay, se houver lista)
   * e cada vez que o agente manda uma lista diferente. Lista vazia = o agente zerou os comandos.
   */
  z.object({
    type: z.literal('commands'),
    sessionId: IdSchema,
    commands: z.array(AvailableCommandSchema),
  }),
  /**
   * Opções de configuração da sessão, só para quem está inscrito nela: no subscribe (se houver) e cada vez que mudam
   * (resposta de set_config, config_option_update, current_mode_update, resume/load). Lista vazia = sem opções.
   */
  z.object({
    type: z.literal('config_options'),
    sessionId: IdSchema,
    configOptions: z.array(SessionConfigOptionSchema),
  }),
  /** A sessão saiu do app (`DELETE /api/sessions/:id?forget=1`). O histórico no agente continua lá. */
  z.object({ type: z.literal('session_removed'), sessionId: IdSchema }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    sessionId: IdSchema.optional(),
  }),
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
