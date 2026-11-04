import { describe, expect, it } from 'vitest';
import { diffRows } from './diffRows.js';

describe('diffRows', () => {
  it('marca linhas iguais como contexto, removidas e adicionadas', () => {
    expect(diffRows('a\nb\n', 'a\nc\n')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
  });

  it('arquivo novo (oldText null tratado como vazio) vira só adições', () => {
    expect(diffRows('', 'x\ny\n')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
  });

  it('texto sem quebra de linha final ainda gera a linha', () => {
    expect(diffRows('um', 'dois')).toEqual([
      { kind: 'del', text: 'um' },
      { kind: 'add', text: 'dois' },
    ]);
  });

  it('textos iguais não geram linhas de alteração', () => {
    expect(diffRows('a\n', 'a\n')).toEqual([{ kind: 'ctx', text: 'a' }]);
  });
});
