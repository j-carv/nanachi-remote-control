import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { LanguageKey } from '../workspace/fileKinds.js';

/*
 * Parser do CodeMirror para cada linguagem. Cada carregador é um import dinâmico: o Vite gera um pedaço (chunk)
 * por pacote, então o editor baixa só o parser do arquivo aberto. Pacotes oficiais `@codemirror/lang-*` quando
 * existem; o resto vem de `@codemirror/legacy-modes` (via StreamLanguage) ou de `./simpleLanguages`.
 */

type Loader = () => Promise<Extension>;

const LOADERS: Readonly<Record<LanguageKey, Loader>> = {
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  // O parser oficial de JSON rejeita comentários; o modo JSON do JavaScript legado os aceita.
  jsonc: () => import('@codemirror/legacy-modes/mode/javascript').then((m) => StreamLanguage.define(m.json)),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => import('@codemirror/lang-sass').then((m) => m.sass({ indented: false })),
  less: () => import('@codemirror/legacy-modes/mode/css').then((m) => StreamLanguage.define(m.less)),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  // Vue e Svelte: o parser de HTML cobre a marcação; o script e o estilo entram como texto HTML.
  vue: () => import('@codemirror/lang-html').then((m) => m.html()),
  svelte: () => import('@codemirror/lang-html').then((m) => m.html()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  toml: () => import('@codemirror/legacy-modes/mode/toml').then((m) => StreamLanguage.define(m.toml)),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  c: () => import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.c)),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  csharp: () => import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.csharp)),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  kotlin: () => import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.kotlin)),
  swift: () => import('@codemirror/legacy-modes/mode/swift').then((m) => StreamLanguage.define(m.swift)),
  dart: () => import('@codemirror/legacy-modes/mode/clike').then((m) => StreamLanguage.define(m.dart)),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  ruby: () => import('@codemirror/legacy-modes/mode/ruby').then((m) => StreamLanguage.define(m.ruby)),
  lua: () => import('@codemirror/legacy-modes/mode/lua').then((m) => StreamLanguage.define(m.lua)),
  shell: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  powershell: () =>
    import('@codemirror/legacy-modes/mode/powershell').then((m) => StreamLanguage.define(m.powerShell)),
  batch: () => import('./simpleLanguages.js').then((m) => StreamLanguage.define(m.batch)),
  ini: () => import('./simpleLanguages.js').then((m) => StreamLanguage.define(m.ini)),
  dockerfile: () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => StreamLanguage.define(m.dockerFile)),
  makefile: () => import('./simpleLanguages.js').then((m) => StreamLanguage.define(m.makefile)),
  gitignore: () => import('./simpleLanguages.js').then((m) => StreamLanguage.define(m.gitignore)),
  graphql: () => import('./simpleLanguages.js').then((m) => StreamLanguage.define(m.graphql)),
  protobuf: () => import('@codemirror/legacy-modes/mode/protobuf').then((m) => StreamLanguage.define(m.protobuf)),
  diff: () => import('@codemirror/legacy-modes/mode/diff').then((m) => StreamLanguage.define(m.diff)),
  plain: () => Promise.resolve([]),
};

/**
 * Extensão de linguagem (parser e realce) para a chave. Texto puro é `[]`. Se o pedaço não carregar (offline, ou
 * um deploy trocou os arquivos), o arquivo abre como texto puro: o editor continua útil, sem bloquear a leitura.
 */
export async function loadLanguage(key: LanguageKey): Promise<Extension> {
  try {
    return await LOADERS[key]();
  } catch {
    return [];
  }
}
