import { describe, expect, it } from 'vitest';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { LANGUAGE_KEYS, type LanguageKey } from '../workspace/fileKinds.js';
import { loadLanguage } from './languages.js';

/** Um trecho válido de cada linguagem. Erro de parse no trecho falha o teste. */
const SAMPLES: Record<Exclude<LanguageKey, 'plain'>, string> = {
  javascript: 'const a = 1;\n',
  jsx: 'const el = <div className="a">oi</div>;\n',
  typescript: 'export const n: number = 1;\n',
  tsx: 'const el = <p>{"x"}</p>;\n',
  json: '{"a": [1, true, null]}\n',
  jsonc: '// comentário\n{\n  /* bloco */\n  "a": 1\n}\n',
  css: 'a { color: red; }\n',
  scss: '$c: red;\n.a { color: $c; .b { margin: 0; } }\n',
  less: '@c: red;\n.a { color: @c; }\n',
  html: '<p class="a">oi</p>\n',
  vue: '<template><p>{{ msg }}</p></template>\n',
  svelte: '<script>let n = 1;</script>\n<p>{n}</p>\n',
  markdown: '# Título\n\n- item `code`\n',
  python: 'def f(x: int) -> int:\n    return x + 1\n',
  rust: 'fn main() {\n    let x: i32 = 1;\n}\n',
  toml: '[package]\nname = "app"\n',
  yaml: 'a:\n  - 1\n  - two\n',
  xml: '<?xml version="1.0"?>\n<a b="c"/>\n',
  sql: 'SELECT id FROM users WHERE id = 1;\n',
  c: '#include <stdio.h>\nint main(void) { return 0; }\n',
  cpp: 'class A { public: int x; };\n',
  csharp: 'class A { int x = 1; }\n',
  java: 'class A { int x = 1; }\n',
  kotlin: 'fun main() { val x = 1 }\n',
  swift: 'let x = 1\nprint(x)\n',
  dart: 'void main() { var x = 1; }\n',
  go: 'package main\n\nfunc main() {}\n',
  php: '<?php\necho "oi";\n',
  ruby: 'def f(x)\n  x + 1\nend\n',
  lua: 'local x = 1\nprint(x)\n',
  shell: 'echo "oi" | grep o\n',
  powershell: 'Get-ChildItem -Path $HOME\n',
  batch: '@echo off\nREM comentario\nset X=1\n',
  ini: '[core]\nname = app\n',
  dockerfile: 'FROM node:22\nRUN npm ci\n',
  makefile: 'build:\n\tcc main.c\n',
  gitignore: '# logs\n*.log\n!keep.log\n',
  graphql: 'query Q($id: ID!) { user(id: $id) { name } }\n',
  protobuf: 'message A { int32 x = 1; }\n',
  diff: '@@ -1 +1 @@\n-a\n+b\n',
};

/** Conta os nós de erro do parse completo do trecho. */
async function parseErrorsOf(key: Exclude<LanguageKey, 'plain'>, extension: Extension): Promise<number> {
  const state = EditorState.create({ doc: SAMPLES[key], extensions: [extension] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5_000);
  if (tree === null) throw new Error(`parse de ${key} não terminou`);
  let errors = 0;
  tree.iterate({
    enter(node) {
      if (node.type.isError) errors += 1;
    },
  });
  return errors;
}

describe('loadLanguage', () => {
  it('texto puro não tem parser: a extensão é vazia', async () => {
    expect(await loadLanguage('plain')).toEqual([]);
  });

  it('cada linguagem carrega o próprio parser e faz parse do trecho sem erro', async () => {
    for (const key of LANGUAGE_KEYS) {
      if (key === 'plain') continue;
      const extension = await loadLanguage(key);
      expect(await parseErrorsOf(key, extension), key).toBe(0);
    }
  });

  it('TypeScript faz parse como TypeScript: tipo anotado não vira erro', async () => {
    expect(await parseErrorsOf('typescript', await loadLanguage('typescript'))).toBe(0);
    expect(await parseErrorsOf('tsx', await loadLanguage('tsx'))).toBe(0);
  });
});
