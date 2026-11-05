import { LOOP_PROMPT_MAX, parseLoopArgs, type LoopRequest } from '@nanachi/shared';
import { splitCommand } from './commands.js';

/**
 * What the composer does with a typed `/loop` (no React). Only `/loop` as the command counts: `/loops`, or text that
 * merely contains `/loop`, goes through as an ordinary message.
 */
export type LoopCommandDecision =
  /** Not a `/loop` command: the message takes the normal send path. */
  | { kind: 'none' }
  /** `/loop` with no arguments: opens the Loop sheet. */
  | { kind: 'sheet' }
  /** `/loop [interval] prompt`: creates the loop directly (PUT), the first round runs now. */
  | { kind: 'start'; request: LoopRequest }
  /** `/loop` with arguments that do not work: nothing is sent; the message says what to fix. */
  | { kind: 'invalid'; message: string };

const INTERVAL_HELP = 'Intervalo entre 30 s e 24 h, seguido do prompt. Ex.: /loop 5m revise os testes.';

/** Decides what sending `text` from the composer does. `hasAttachments`: the draft has attachments. */
export function loopCommandFor(text: string, hasAttachments: boolean): LoopCommandDecision {
  const parts = splitCommand(text.trim());
  if (parts === undefined || parts.command !== '/loop') return { kind: 'none' };

  const args = parts.rest.trim();
  if (args === '') return { kind: 'sheet' };
  if (hasAttachments) return { kind: 'invalid', message: 'Loop não aceita anexos. Mande o arquivo numa mensagem comum.' };

  const parsed = parseLoopArgs(args);
  if (parsed === undefined) return { kind: 'invalid', message: INTERVAL_HELP };
  if (parsed.prompt.length > LOOP_PROMPT_MAX) {
    return { kind: 'invalid', message: `O prompt do loop passa de ${LOOP_PROMPT_MAX} caracteres.` };
  }

  if (parsed.intervalMs === undefined) {
    return { kind: 'start', request: { prompt: parsed.prompt, mode: 'dynamic', runNow: true } };
  }
  return {
    kind: 'start',
    request: { prompt: parsed.prompt, mode: 'interval', intervalMs: parsed.intervalMs, runNow: true },
  };
}
