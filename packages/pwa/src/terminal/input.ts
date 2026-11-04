import type { ClientMessage } from '@nanachi/shared';

/** Limite do `terminal_input` no daemon (64 KiB). Medido em bytes UTF-8. */
export const MAX_INPUT_BYTES = 64 * 1024;

/** Linha digitada no celular: o texto mais CR (Enter). Vazio vira só CR. */
export function lineInput(text: string): string {
  return `${text}\r`;
}

/** Bytes UTF-8 de um code point. Surrogate solto vira U+FFFD (3 bytes), como o TextEncoder faz. */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Divide a entrada em pedaços de no máximo `maxBytes` (UTF-8). Nunca corta um caractere.
 * Entrada vazia não gera pedaço nenhum.
 */
export function splitInput(data: string, maxBytes: number = MAX_INPUT_BYTES): string[] {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;

  for (const char of data) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (current !== '' && bytes + size > maxBytes) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }

  if (current !== '') parts.push(current);
  return parts;
}

/**
 * Envia a entrada como `terminal_input` (um por pedaço, na ordem). Para no primeiro envio
 * recusado (sem conexão) e devolve `false`.
 */
export function sendTerminalInput(
  send: (message: ClientMessage) => boolean,
  sessionId: string,
  data: string,
): boolean {
  for (const chunk of splitInput(data)) {
    if (!send({ type: 'terminal_input', sessionId, data: chunk })) return false;
  }
  return true;
}
