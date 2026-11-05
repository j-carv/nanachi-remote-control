import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi.js';

// Real output of omp 18.13 `/usage` (probe over ACP, 04/11): SGR colors inside a code block.
const OMP_USAGE_SAMPLE = '\u001b[38;2;156;163;176m██\u001b[39m\u001b[38;2;52;211;153m██████\u001b[39m 62%';

describe('stripAnsi', () => {
  it('remove as cores SGR do sample real do omp e mantém o texto', () => {
    expect(stripAnsi(OMP_USAGE_SAMPLE)).toBe('████████ 62%');
  });

  it('remove SGR simples (negrito, reset) e sequências CSI de cursor', () => {
    expect(stripAnsi('\u001b[1mtotal\u001b[22m 1.2M')).toBe('total 1.2M');
    expect(stripAnsi('linha\u001b[2K\u001b[1Gnova')).toBe('linhanova');
  });

  it('remove OSC terminado em BEL e em ST (hyperlink, título)', () => {
    expect(stripAnsi('\u001b]8;;https://exemplo.com\u0007site\u001b]8;;\u0007')).toBe('site');
    expect(stripAnsi('\u001b]0;título\u001b\\ok')).toBe('ok');
  });

  it('remove a forma C1 (CSI de 8 bits, \\u009b)', () => {
    expect(stripAnsi('\u009b31mvermelho\u009b0m')).toBe('vermelho');
  });

  it('remove um escape incompleto no fim (chunk de streaming que corta a sequência)', () => {
    expect(stripAnsi('contagem \u001b[38;2;15')).toBe('contagem ');
    expect(stripAnsi('fim\u001b')).toBe('fim');
    expect(stripAnsi('fim\u001b[')).toBe('fim');
  });

  it('não mexe em texto sem escape, em colchetes comuns nem em ESC que não inicia sequência', () => {
    expect(stripAnsi('')).toBe('');
    expect(stripAnsi('array[0] e [x] e (y)')).toBe('array[0] e [x] e (y)');
    expect(stripAnsi('Markdown **negrito** e `código`')).toBe('Markdown **negrito** e `código`');
    expect(stripAnsi('café — ação ✓')).toBe('café — ação ✓');
  });

  it('funciona em várias sequências no mesmo texto e em bloco de código', () => {
    const block = '```\n' + OMP_USAGE_SAMPLE + '\n```';
    expect(stripAnsi(block)).toBe('```\n████████ 62%\n```');
  });
});
