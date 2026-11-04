import { describe, expect, it } from 'vitest';
import { parseUnifiedPatch } from './unifiedPatch.js';

describe('parseUnifiedPatch', () => {
  it('classifica adições, remoções e contexto dentro do hunk, sem o marcador', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', ' d', ''].join('\n');
    expect(parseUnifiedPatch(patch)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
      { kind: 'ctx', text: 'd' },
    ]);
  });

  it('cabeçalho do git (diff, index, ---/+++, modo) é meta, não conteúdo', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      'index 1111..2222 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseUnifiedPatch(patch)).toEqual([
      { kind: 'meta', text: 'diff --git a/x.ts b/x.ts' },
      { kind: 'meta', text: 'index 1111..2222 100644' },
      { kind: 'meta', text: '--- a/x.ts' },
      { kind: 'meta', text: '+++ b/x.ts' },
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
  });

  it('linha de conteúdo que começa com -- ou ++ continua remoção/adição dentro do hunk', () => {
    const patch = ['@@ -1,2 +1,2 @@', '--- velho', '+++ novo'].join('\n');
    expect(parseUnifiedPatch(patch)).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'del', text: '-- velho' },
      { kind: 'add', text: '++ novo' },
    ]);
  });

  it('"\\ No newline at end of file" é meta', () => {
    const patch = ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n');
    expect(parseUnifiedPatch(patch)).toContainEqual({
      kind: 'meta',
      text: '\\ No newline at end of file',
    });
  });

  it('contagem omitida no cabeçalho do hunk vale 1 linha', () => {
    const patch = ['diff --git a/y b/y', '@@ -1 +1 @@', '-a', '+b', 'diff --git a/z b/z'].join('\n');
    expect(parseUnifiedPatch(patch)).toEqual([
      { kind: 'meta', text: 'diff --git a/y b/y' },
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: 'a' },
      { kind: 'add', text: 'b' },
      { kind: 'meta', text: 'diff --git a/z b/z' },
    ]);
  });

  it('vários hunks no mesmo arquivo', () => {
    const patch = ['@@ -1 +1 @@', '-a', '+b', '@@ -10,2 +10,2 @@', ' x', '-y', '+z'].join('\n');
    const kinds = parseUnifiedPatch(patch).map((line) => line.kind);
    expect(kinds).toEqual(['hunk', 'del', 'add', 'hunk', 'ctx', 'del', 'add']);
  });

  it('linha vazia dentro do hunk conta como contexto', () => {
    const patch = ['@@ -1,2 +1,2 @@', '', '-a', '+b'].join('\n');
    expect(parseUnifiedPatch(patch)).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: '' },
      { kind: 'del', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });

  it('patch vazio (ex.: binário) não gera linhas', () => {
    expect(parseUnifiedPatch('')).toEqual([]);
  });

  it('quebra de linha final não vira linha extra', () => {
    expect(parseUnifiedPatch('@@ -1 +1 @@\n+a\n')).toHaveLength(2);
  });
});
