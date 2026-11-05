import { t } from '../i18n/index.js';

/**
 * Linguagem do editor. `plain`: texto sem realce. Cada chave tem um carregador em `editor/languages.ts`.
 * `LANGUAGE_KEYS` mantém a lista para testes e para quem precisa percorrê-la.
 */
export const LANGUAGE_KEYS = [
  'javascript',
  'jsx',
  'typescript',
  'tsx',
  'json',
  'jsonc',
  'css',
  'scss',
  'less',
  'html',
  'vue',
  'svelte',
  'markdown',
  'python',
  'rust',
  'toml',
  'yaml',
  'xml',
  'sql',
  'c',
  'cpp',
  'csharp',
  'java',
  'kotlin',
  'swift',
  'dart',
  'go',
  'php',
  'ruby',
  'lua',
  'shell',
  'powershell',
  'batch',
  'ini',
  'dockerfile',
  'makefile',
  'gitignore',
  'graphql',
  'protobuf',
  'diff',
  'plain',
] as const;

export type LanguageKey = (typeof LANGUAGE_KEYS)[number];

/** Proper names of the languages. `plain` (text without highlighting) is not a proper name: it comes from the translation. */
const LABELS: Readonly<Record<Exclude<LanguageKey, 'plain'>, string>> = {
  javascript: 'JavaScript',
  jsx: 'JSX',
  typescript: 'TypeScript',
  tsx: 'TSX',
  json: 'JSON',
  jsonc: 'JSONC',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  vue: 'Vue',
  svelte: 'Svelte',
  markdown: 'Markdown',
  python: 'Python',
  rust: 'Rust',
  toml: 'TOML',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  dart: 'Dart',
  go: 'Go',
  php: 'PHP',
  ruby: 'Ruby',
  lua: 'Lua',
  shell: 'Shell',
  powershell: 'PowerShell',
  batch: 'Batch',
  ini: 'INI',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  gitignore: 'Gitignore',
  graphql: 'GraphQL',
  protobuf: 'Protobuf',
  diff: 'Diff',
};

/** Language name for the editor label. Language names are proper names and are not translated; only plain text is ("Texto" / "Plain text"). */
export function languageLabelFor(key: LanguageKey): string {
  return key === 'plain' ? t('workspace:editor.plainText') : LABELS[key];
}

/** Extensão (sem ponto, minúscula) → linguagem. */
const BY_EXTENSION: Readonly<Record<string, LanguageKey>> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'jsonc',
  'code-workspace': 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rs: 'rust',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  xsl: 'xml',
  xsd: 'xml',
  plist: 'xml',
  csproj: 'xml',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  'h++': 'cpp',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  go: 'go',
  php: 'php',
  phtml: 'php',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  lua: 'lua',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'ini',
  dockerfile: 'dockerfile',
  mk: 'makefile',
  make: 'makefile',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
};

/** Nome inteiro (minúsculo) → linguagem: arquivos sem extensão ou com ponto no começo. */
const BY_NAME: Readonly<Record<string, LanguageKey>> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cargo.lock': 'toml',
  '.gitignore': 'gitignore',
  '.dockerignore': 'gitignore',
  '.npmignore': 'gitignore',
  '.gitattributes': 'gitignore',
  '.prettierignore': 'gitignore',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.gitconfig': 'ini',
  '.env': 'ini',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
  '.zprofile': 'shell',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
};

/** Prefixos de nome: `Dockerfile.dev`, `.env.local`. */
const BY_NAME_PREFIX: ReadonlyArray<readonly [string, LanguageKey]> = [
  ['dockerfile.', 'dockerfile'],
  ['containerfile.', 'dockerfile'],
  ['.env.', 'ini'],
];

function languageByName(lower: string): LanguageKey | undefined {
  const exact = BY_NAME[lower];
  if (exact !== undefined) return exact;
  return BY_NAME_PREFIX.find(([prefix]) => lower.startsWith(prefix))?.[1];
}

/**
 * Linguagem pelo nome do arquivo, sem diferenciar maiúsculas. Nome especial vence a extensão (`Dockerfile`,
 * `.gitignore`); depois vem a extensão (`*.d.ts` é `ts`). Sem regra: `plain`.
 */
export function languageKeyFor(name: string): LanguageKey {
  const lower = name.toLowerCase();
  const special = languageByName(lower);
  if (special !== undefined) return special;
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return 'plain';
  return BY_EXTENSION[lower.slice(dot + 1)] ?? 'plain';
}

/** Família de ícone do explorador. Cada uma vira um ícone do lucide na tela de arquivos. */
export type FileIconKind = 'code' | 'data' | 'text' | 'image' | 'terminal' | 'config' | 'lock' | 'generic';

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'heic',
  'tif',
  'tiff',
  'svg',
]);

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['txt', 'text', 'log']);

/** Lockfiles: não são código, mas aparecem muito no explorador. */
const LOCK_NAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'cargo.lock',
]);

/** Ícone do explorador para um arquivo: pelo nome, depois pela imagem, depois pela linguagem. */
export function fileIconKindFor(name: string): FileIconKind {
  const lower = name.toLowerCase();
  if (LOCK_NAMES.has(lower)) return 'lock';
  const dot = lower.lastIndexOf('.');
  const extension = dot > 0 ? lower.slice(dot + 1) : '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  switch (languageKeyFor(name)) {
    case 'shell':
    case 'powershell':
    case 'batch':
      return 'terminal';
    case 'toml':
    case 'yaml':
    case 'ini':
    case 'dockerfile':
    case 'makefile':
    case 'gitignore':
      return 'config';
    case 'json':
    case 'jsonc':
      return 'data';
    case 'markdown':
      return 'text';
    case 'plain':
      return TEXT_EXTENSIONS.has(extension) ? 'text' : 'generic';
    default:
      return 'code';
  }
}
