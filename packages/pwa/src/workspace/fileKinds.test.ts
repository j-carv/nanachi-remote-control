import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { LANGUAGE_KEYS, fileIconKindFor, languageKeyFor, languageLabelFor } from './fileKinds.js';

describe('languageKeyFor', () => {
  it('escolhe a linguagem pela extensão, sem diferenciar maiúsculas', () => {
    expect(languageKeyFor('App.TSX')).toBe('tsx');
    expect(languageKeyFor('main.ts')).toBe('typescript');
    expect(languageKeyFor('index.jsx')).toBe('jsx');
    expect(languageKeyFor('server.mjs')).toBe('javascript');
    expect(languageKeyFor('server.cjs')).toBe('javascript');
    expect(languageKeyFor('package.json')).toBe('json');
    expect(languageKeyFor('settings.jsonc')).toBe('jsonc');
    expect(languageKeyFor('site.css')).toBe('css');
    expect(languageKeyFor('site.scss')).toBe('scss');
    expect(languageKeyFor('site.less')).toBe('less');
    expect(languageKeyFor('index.htm')).toBe('html');
    expect(languageKeyFor('App.vue')).toBe('vue');
    expect(languageKeyFor('Card.svelte')).toBe('svelte');
    expect(languageKeyFor('README.md')).toBe('markdown');
    expect(languageKeyFor('tool.py')).toBe('python');
    expect(languageKeyFor('lib.rs')).toBe('rust');
  });

  it('cobre as linguagens de uso geral pela extensão', () => {
    expect(languageKeyFor('pyproject.toml')).toBe('toml');
    expect(languageKeyFor('ci.yml')).toBe('yaml');
    expect(languageKeyFor('icon.svg')).toBe('xml');
    expect(languageKeyFor('schema.sql')).toBe('sql');
    expect(languageKeyFor('main.c')).toBe('c');
    expect(languageKeyFor('main.cpp')).toBe('cpp');
    expect(languageKeyFor('util.hpp')).toBe('cpp');
    expect(languageKeyFor('Program.cs')).toBe('csharp');
    expect(languageKeyFor('Main.java')).toBe('java');
    expect(languageKeyFor('Main.kt')).toBe('kotlin');
    expect(languageKeyFor('App.swift')).toBe('swift');
    expect(languageKeyFor('main.dart')).toBe('dart');
    expect(languageKeyFor('main.go')).toBe('go');
    expect(languageKeyFor('index.php')).toBe('php');
    expect(languageKeyFor('init.lua')).toBe('lua');
    expect(languageKeyFor('app.rb')).toBe('ruby');
    expect(languageKeyFor('install.sh')).toBe('shell');
    expect(languageKeyFor('setup.ps1')).toBe('powershell');
    expect(languageKeyFor('build.cmd')).toBe('batch');
    expect(languageKeyFor('config.ini')).toBe('ini');
    expect(languageKeyFor('change.patch')).toBe('diff');
    expect(languageKeyFor('schema.graphql')).toBe('graphql');
    expect(languageKeyFor('message.proto')).toBe('protobuf');
  });

  it('trata *.d.ts como TypeScript', () => {
    expect(languageKeyFor('index.d.ts')).toBe('typescript');
    expect(languageKeyFor('global.d.mts')).toBe('typescript');
  });

  it('reconhece nomes especiais, com ou sem extensão', () => {
    expect(languageKeyFor('Dockerfile')).toBe('dockerfile');
    expect(languageKeyFor('Dockerfile.dev')).toBe('dockerfile');
    expect(languageKeyFor('api.dockerfile')).toBe('dockerfile');
    expect(languageKeyFor('Makefile')).toBe('makefile');
    expect(languageKeyFor('GNUmakefile')).toBe('makefile');
    expect(languageKeyFor('rules.mk')).toBe('makefile');
    expect(languageKeyFor('.gitignore')).toBe('gitignore');
    expect(languageKeyFor('.editorconfig')).toBe('ini');
    expect(languageKeyFor('.env')).toBe('ini');
    expect(languageKeyFor('.env.local')).toBe('ini');
    expect(languageKeyFor('Cargo.lock')).toBe('toml');
    expect(languageKeyFor('.zshrc')).toBe('shell');
  });

  it('extensão desconhecida, sem extensão e arquivo de ponto sem regra são texto puro', () => {
    expect(languageKeyFor('notes.txt')).toBe('plain');
    expect(languageKeyFor('data.bin')).toBe('plain');
    expect(languageKeyFor('LICENSE')).toBe('plain');
    expect(languageKeyFor('.DS_Store')).toBe('plain');
  });
});

describe('languageLabelFor', () => {
  it('dá um rótulo para cada linguagem, texto puro incluso', () => {
    for (const key of LANGUAGE_KEYS) {
      expect(languageLabelFor(key).length).toBeGreaterThan(0);
    }
    expect(languageLabelFor('typescript')).toBe('TypeScript');
    expect(languageLabelFor('plain')).toBe('Texto');
  });
});

describe('fileIconKindFor', () => {
  it('código, dados, texto, imagem, terminal e configuração têm ícones próprios', () => {
    expect(fileIconKindFor('app.ts')).toBe('code');
    expect(fileIconKindFor('lib.rs')).toBe('code');
    expect(fileIconKindFor('package.json')).toBe('data');
    expect(fileIconKindFor('README.md')).toBe('text');
    expect(fileIconKindFor('notes.txt')).toBe('text');
    expect(fileIconKindFor('photo.JPG')).toBe('image');
    expect(fileIconKindFor('icon.svg')).toBe('image');
    expect(fileIconKindFor('setup.ps1')).toBe('terminal');
    expect(fileIconKindFor('install.sh')).toBe('terminal');
    expect(fileIconKindFor('pyproject.toml')).toBe('config');
    expect(fileIconKindFor('Dockerfile')).toBe('config');
    expect(fileIconKindFor('.editorconfig')).toBe('config');
  });

  it('lockfiles e arquivos sem tipo conhecido têm ícones próprios', () => {
    expect(fileIconKindFor('package-lock.json')).toBe('lock');
    expect(fileIconKindFor('pnpm-lock.yaml')).toBe('lock');
    expect(fileIconKindFor('Cargo.lock')).toBe('lock');
    expect(fileIconKindFor('blob.bin')).toBe('generic');
    expect(fileIconKindFor('LICENSE')).toBe('generic');
  });
});

describe('languageLabelFor in English', () => {
  it('translates only plain text: language names are proper names', () => {
    setLanguage('en');
    expect(languageLabelFor('plain')).toBe('Plain text');
    expect(languageLabelFor('typescript')).toBe('TypeScript');
    expect(languageLabelFor('powershell')).toBe('PowerShell');
  });
});
