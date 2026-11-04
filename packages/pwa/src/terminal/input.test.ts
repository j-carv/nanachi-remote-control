import type { ClientMessage } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { MAX_INPUT_BYTES, lineInput, sendTerminalInput, splitInput } from './input.js';

const utf8 = (text: string) => new TextEncoder().encode(text).length;

describe('lineInput', () => {
  it('envia o texto seguido de CR (Enter)', () => {
    expect(lineInput('ls -la')).toBe('ls -la\r');
  });

  it('linha vazia vira só CR', () => {
    expect(lineInput('')).toBe('\r');
  });
});

describe('splitInput', () => {
  it('entrada curta vai inteira num pedaço só', () => {
    expect(splitInput('oi\r')).toEqual(['oi\r']);
  });

  it('entrada vazia não gera pedaços', () => {
    expect(splitInput('')).toEqual([]);
  });

  it('entrada exatamente no limite não é dividida', () => {
    const data = 'a'.repeat(MAX_INPUT_BYTES);
    expect(splitInput(data)).toEqual([data]);
  });

  it('entrada acima de 64 KiB vira pedaços de no máximo 64 KiB, sem perder nada', () => {
    const data = 'x'.repeat(MAX_INPUT_BYTES * 2 + 10);
    const parts = splitInput(data);
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(utf8(part)).toBeLessThanOrEqual(MAX_INPUT_BYTES);
    expect(parts.join('')).toBe(data);
  });

  it('mede em bytes UTF-8: acentos e emoji contam mais de um byte', () => {
    const data = 'é'.repeat(MAX_INPUT_BYTES); // 2 bytes cada → 128 KiB
    const parts = splitInput(data);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(utf8(part)).toBeLessThanOrEqual(MAX_INPUT_BYTES);
    expect(parts.join('')).toBe(data);
  });

  it('nunca corta um caractere no meio (emoji de 4 bytes na divisa)', () => {
    const data = `${'a'.repeat(MAX_INPUT_BYTES - 2)}😀😀`;
    const parts = splitInput(data);
    expect(parts.join('')).toBe(data);
    for (const part of parts) expect(utf8(part)).toBeLessThanOrEqual(MAX_INPUT_BYTES);
  });

  it('limite configurável (usado para testar a divisão com pouco texto)', () => {
    expect(splitInput('abcdef', 4)).toEqual(['abcd', 'ef']);
  });
});

describe('sendTerminalInput', () => {
  it('manda um terminal_input por pedaço, na ordem', () => {
    const sent: ClientMessage[] = [];
    const ok = sendTerminalInput(
      (message) => {
        sent.push(message);
        return true;
      },
      's-1',
      'a'.repeat(MAX_INPUT_BYTES + 1),
    );
    expect(ok).toBe(true);
    expect(sent).toEqual([
      { type: 'terminal_input', sessionId: 's-1', data: 'a'.repeat(MAX_INPUT_BYTES) },
      { type: 'terminal_input', sessionId: 's-1', data: 'a' },
    ]);
  });

  it('para no primeiro envio recusado e devolve false', () => {
    let calls = 0;
    const ok = sendTerminalInput(
      () => {
        calls += 1;
        return false;
      },
      's-1',
      'a'.repeat(MAX_INPUT_BYTES + 1),
    );
    expect(ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('entrada vazia não envia nada e conta como enviada', () => {
    let calls = 0;
    expect(
      sendTerminalInput(
        () => {
          calls += 1;
          return true;
        },
        's-1',
        '',
      ),
    ).toBe(true);
    expect(calls).toBe(0);
  });
});
