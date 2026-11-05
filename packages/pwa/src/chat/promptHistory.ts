import type { ChatItem } from './reducer.js';

/**
 * Histórico de prompts do composer, como as setas do terminal. Sem React: o ChatScreen guarda o cursor e aplica o
 * texto devolvido. O histórico são as mensagens do usuário desta sessão, inclusive as carregadas do servidor.
 */

/** Textos das mensagens do usuário, da mais antiga para a mais nova. Repetidas seguidas contam uma vez; vazias saem. */
export function promptHistoryOf(items: readonly ChatItem[]): string[] {
  const history: string[] = [];
  for (const item of items) {
    if (item.kind !== 'user_message' || item.text.trim() === '') continue;
    if (history.at(-1) === item.text) continue;
    history.push(item.text);
  }
  return history;
}

export interface PromptCursor {
  /** Entrada mostrada no composer (índice em `history`); null enquanto o composer tem o rascunho do usuário. */
  readonly index: number | null;
  /** Texto do composer antes da primeira recuperação: volta quando a navegação passa da entrada mais nova. */
  readonly draft: string;
}

export const IDLE_PROMPT_CURSOR: PromptCursor = { index: null, draft: '' };

export interface PromptStep {
  cursor: PromptCursor;
  text: string;
}

function entryAt(history: readonly string[], index: number): string | undefined {
  return history[index];
}

/**
 * Seta para cima: a entrada anterior (mais antiga). A primeira vez guarda `current` como rascunho.
 * Null quando não há nada mais antigo, para o chamador não mexer no texto.
 */
export function recallOlder(history: readonly string[], cursor: PromptCursor, current: string): PromptStep | null {
  if (history.length === 0) return null;
  if (cursor.index === null) {
    const text = entryAt(history, history.length - 1);
    if (text === undefined) return null;
    return { cursor: { index: history.length - 1, draft: current }, text };
  }
  if (cursor.index === 0) return null;
  const index = cursor.index - 1;
  const text = entryAt(history, index);
  if (text === undefined) return null;
  return { cursor: { index, draft: cursor.draft }, text };
}

/**
 * Seta para baixo: a entrada seguinte (mais nova). Passando da mais nova, volta ao rascunho guardado.
 * Null quando o composer já mostra o rascunho.
 */
export function recallNewer(history: readonly string[], cursor: PromptCursor): PromptStep | null {
  if (cursor.index === null) return null;
  if (cursor.index >= history.length - 1) return { cursor: IDLE_PROMPT_CURSOR, text: cursor.draft };
  const index = cursor.index + 1;
  const text = entryAt(history, index);
  if (text === undefined) return null;
  return { cursor: { index, draft: cursor.draft }, text };
}
