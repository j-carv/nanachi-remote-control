import { z } from 'zod';

/** Menor intervalo do modo interval (30 s). Abaixo disso o agente seria chamado sem pausa útil. */
export const LOOP_INTERVAL_MIN_MS = 30_000;
/** Maior intervalo, nos dois modos (24 h). */
export const LOOP_INTERVAL_MAX_MS = 86_400_000;
/** Próxima execução do modo dynamic quando o agente não manda marcador (10 min). */
export const LOOP_DYNAMIC_DEFAULT_MS = 600_000;
/** Tamanho máximo do prompt de um loop, em caracteres. */
export const LOOP_PROMPT_MAX = 10_000;

export const LoopModeSchema = z.enum(['interval', 'dynamic']);

export type LoopMode = z.infer<typeof LoopModeSchema>;

export const LoopStateSchema = z.enum(['active', 'paused', 'stopped']);

export type LoopState = z.infer<typeof LoopStateSchema>;

const LoopIntervalSchema = z.number().int().min(LOOP_INTERVAL_MIN_MS).max(LOOP_INTERVAL_MAX_MS);

/**
 * Loop de uma sessão (uma por sessão). Campos nulos aparecem sempre: `intervalMs` é null no modo dynamic,
 * `nextRunAt` é null enquanto um turno do loop roda ou quando está pausado/parado, `lastError` só tem texto
 * depois de uma pausa por falha.
 * `revision` ordena os snapshots: cresce a cada publicação e a cada leitura do daemon, então o PWA fica com o de
 * maior revisão, mesmo quando a resposta HTTP de uma ação chega depois de um aviso WS mais novo.
 */
export const LoopSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1).max(LOOP_PROMPT_MAX),
  mode: LoopModeSchema,
  intervalMs: LoopIntervalSchema.nullable(),
  maxIterations: z.number().int().positive().nullable(),
  iterations: z.number().int().nonnegative(),
  state: LoopStateSchema,
  nextRunAt: z.number().int().nonnegative().nullable(),
  lastRunAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().min(1).nullable(),
  createdAt: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

export type Loop = z.infer<typeof LoopSchema>;

/**
 * PUT /api/sessions/:id/loop (Bearer token): cria ou troca o loop da sessão. `interval` exige `intervalMs`;
 * `dynamic` não aceita `intervalMs` (o agente escolhe o tempo a cada turno). `runNow` padrão: true.
 */
export const LoopRequestSchema = z
  .object({
    prompt: z.string().min(1).max(LOOP_PROMPT_MAX),
    mode: LoopModeSchema,
    intervalMs: LoopIntervalSchema.optional(),
    maxIterations: z.number().int().positive().optional(),
    runNow: z.boolean().optional(),
  })
  .superRefine((request, context) => {
    if (request.mode === 'interval' && request.intervalMs === undefined) {
      context.addIssue({ code: 'custom', message: 'intervalMs é obrigatório no modo interval', path: ['intervalMs'] });
    }
    if (request.mode === 'dynamic' && request.intervalMs !== undefined) {
      context.addIssue({ code: 'custom', message: 'modo dynamic não usa intervalMs', path: ['intervalMs'] });
    }
  });

export type LoopRequest = z.infer<typeof LoopRequestSchema>;

/** GET/PUT/POST de loop (Bearer token): `loop` é null quando a sessão não tem loop. */
export const LoopResponseSchema = z.object({
  loop: LoopSchema.nullable(),
});

export type LoopResponse = z.infer<typeof LoopResponseSchema>;

const DURATION_PATTERN = /^(?=.)(?:(\d{1,9})h)?(?:(\d{1,9})m)?(?:(\d{1,9})s)?$/i;

/**
 * Duração em `1h30m`, `10m`, `90s` (partes opcionais, sem espaços) → milissegundos. Não confere faixa: quem usa
 * decide (o loop limita a 30 s–24 h). Texto vazio ou sem unidade → undefined.
 */
export function parseLoopDuration(text: string): number | undefined {
  const match = DURATION_PATTERN.exec(text);
  if (match === null) return undefined;
  const [, hours = '0', minutes = '0', seconds = '0'] = match;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** Resultado de `parseLoopArgs`: `intervalMs` undefined = modo dynamic. */
export interface ParsedLoopArgs {
  intervalMs: number | undefined;
  prompt: string;
}

/**
 * Argumentos do `/loop` digitado no chat: `5m /foo bar` → intervalo de 5 min e prompt `/foo bar`; sem intervalo
 * (`/foo bar`) → dynamic. Undefined quando o prompt está vazio, quando o primeiro token é um intervalo sem prompt
 * depois, ou quando o intervalo fica fora de 30 s–24 h. Um token que não é duração (`1d`) faz parte do prompt.
 */
export function parseLoopArgs(input: string): ParsedLoopArgs | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? '' : trimmed.slice(space).trim();

  const ms = parseLoopDuration(head);
  if (ms === undefined) return { intervalMs: undefined, prompt: trimmed };
  if (ms < LOOP_INTERVAL_MIN_MS || ms > LOOP_INTERVAL_MAX_MS) return undefined;
  if (rest === '') return undefined;
  return { intervalMs: ms, prompt: rest };
}
