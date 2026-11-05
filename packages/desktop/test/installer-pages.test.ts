import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { dictionaries, LANGUAGES, type Language } from '../src/common/i18n/index.js';

const UI = fileURLToPath(new URL('../installer/ui/', import.meta.url));
const PAGES = ['installer.html', 'uninstall.html'] as const;

/** Every leaf of a dictionary as `path -> text`. */
function flatten(node: unknown, prefix = ''): Map<string, string> {
  const leaves = new Map<string, string>();
  if (typeof node === 'string') {
    leaves.set(prefix, node);
    return leaves;
  }
  if (typeof node !== 'object' || node === null) return leaves;
  for (const [key, value] of Object.entries(node)) {
    for (const [path, text] of flatten(value, prefix === '' ? key : `${prefix}.${key}`)) leaves.set(path, text);
  }
  return leaves;
}

const TEXTS: Record<Language, Map<string, string>> = {
  'pt-BR': flatten(dictionaries['pt-BR']),
  en: flatten(dictionaries.en),
  es: flatten(dictionaries.es),
};

// ---- a small reader for the two pages: elements, their attributes and the text under them ----

interface Element {
  tag: string;
  attrs: Record<string, string>;
  /** The element and its ancestors, nearest first. */
  chain: Element[];
  text: string[];
}

const VOID = new Set(['meta', 'link', 'img', 'input', 'br', 'hr']);
const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'title', 'alt', 'placeholder'] as const;

function unescape(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function readPage(html: string): Element[] {
  // Scripts, styles and drawings hold no text of the page.
  const source = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '');
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  const elements: Element[] = [];
  const open: Element[] = [];
  for (const match of source.matchAll(token)) {
    const [, closing, tag, rawAttrs, text] = match;
    if (text !== undefined) {
      const top = open.at(-1);
      if (top !== undefined && text.trim() !== '') top.text.push(unescape(text.trim()));
      continue;
    }
    if (tag === undefined) continue;
    const name = tag.toLowerCase();
    if (closing === '/') {
      const index = open.map((element) => element.tag).lastIndexOf(name);
      if (index !== -1) open.length = index;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attribute of (rawAttrs ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[(attribute[1] ?? '').toLowerCase()] = unescape(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    const element: Element = { tag: name, attrs, chain: [], text: [] };
    element.chain = [element, ...open.slice().reverse()];
    elements.push(element);
    if (!VOID.has(name)) open.push(element);
  }
  return elements;
}

const hasLetters = (text: string): boolean => /\p{L}/u.test(text);

const pages = PAGES.map((name) => ({ name, elements: readPage(readFileSync(join(UI, name), 'utf8')) }));

describe.each(pages)('$name', ({ elements }) => {
  const keysOf = (element: Element): Array<{ attribute: string; key: string }> =>
    Object.entries(element.attrs)
      .filter(([attribute]) => attribute.startsWith('data-i18n'))
      .map(([attribute, key]) => ({ attribute, key }));

  it('is read as a page with elements and texts (a guard for the reader above)', () => {
    expect(elements.length).toBeGreaterThan(20);
    expect(elements.some((element) => element.text.length > 0)).toBe(true);
    expect(elements.filter((element) => keysOf(element).length > 0).length).toBeGreaterThan(8);
  });

  it('names only keys that exist in every dictionary', () => {
    for (const element of elements) {
      for (const { attribute, key } of keysOf(element)) {
        expect(['data-i18n', 'data-i18n-aria-label', 'data-i18n-title', 'data-i18n-alt'], `${element.tag} ${attribute}`).toContain(attribute);
        for (const language of LANGUAGES) expect(TEXTS[language.code].has(key), `${language.code} ${key}`).toBe(true);
      }
    }
  });

  it('keeps the pt-BR text of the dictionary as the fallback content', () => {
    for (const element of elements) {
      const key = element.attrs['data-i18n'];
      if (key !== undefined) expect(element.text.join(' '), key).toBe(TEXTS['pt-BR'].get(key));
      for (const attribute of TRANSLATABLE_ATTRIBUTES) {
        const attributeKey = element.attrs[`data-i18n-${attribute}`];
        if (attributeKey !== undefined) expect(element.attrs[attribute], attributeKey).toBe(TEXTS['pt-BR'].get(attributeKey));
      }
    }
  });

  it('leaves no visible text and no label without a key (a name that is not translated says so with translate="no")', () => {
    for (const element of elements) {
      const translated = element.chain.some((candidate) => candidate.attrs['data-i18n'] !== undefined || candidate.attrs.translate === 'no');
      for (const text of element.text) {
        if (hasLetters(text)) expect(translated, `<${element.tag}> "${text}" has no data-i18n`).toBe(true);
      }
      for (const attribute of TRANSLATABLE_ATTRIBUTES) {
        const value = element.attrs[attribute];
        if (value !== undefined && hasLetters(value)) expect(element.attrs[`data-i18n-${attribute}`], `<${element.tag}> ${attribute}="${value}"`).toBeDefined();
      }
    }
  });

  it('the whole card sits under an element that the page script shows only when it is ready', () => {
    expect(readFileSync(join(UI, 'shell.css'), 'utf8')).toMatch(/html:not\(\[data-ready\]\)\s+\.stage\s*\{\s*visibility:\s*hidden/);
    expect(elements.some((element) => element.attrs.class === 'stage')).toBe(true);
  });

  it('is plain HTML that loads nothing from the network', () => {
    const source = readFileSync(join(UI, pages.find((page) => page.elements === elements)?.name ?? ''), 'utf8');
    expect(source).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    expect(source).toContain("script-src 'self'");
    expect(source).not.toContain('innerHTML');
  });
});

describe('the two pages together', () => {
  it('every window button and the shared words use the shared keys', () => {
    for (const { elements } of pages) {
      const labelled = elements.filter((element) => element.attrs['data-slot'] === 'minimize' || element.attrs['data-slot'] === 'close');
      expect(labelled.map((element) => element.attrs['data-i18n-aria-label']).sort()).toEqual(['installer.window.close', 'installer.window.minimize']);
    }
  });

  it('both name the title of their own window in <title>', () => {
    const titles = pages.map(({ elements }) => elements.find((element) => element.tag === 'title')?.attrs['data-i18n']);
    expect(titles).toEqual(['installer.setup.title', 'installer.uninstall.title']);
  });
});

// ---- the scripts of the pages ----

/** The code of a TypeScript file without its comments (a `//` inside a string or a template is not a comment). */
function withoutComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
      out += source.slice(index, end + 1);
      index = end + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

const PORTUGUESE_WORDS = /\b(?:Instalar|Instalando|Fechar|Cancelar|Remover|Removendo|Preparando|Voltar|Tentar|Abrir|Opções|Pasta|Versão|Tudo pronto|modo de teste|desinstalador|instalador)\b/i;

describe('the scripts of the pages hold no Portuguese of their own', () => {
  const scripts = readdirSync(UI).filter((name) => name.endsWith('.ts'));

  it('finds the scripts it is meant to read', () => {
    expect(scripts.sort()).toEqual(['common.ts', 'installer.ts', 'uninstall.ts']);
  });

  it('the comment stripper keeps strings and drops comments', () => {
    const code = withoutComments("const a = 'x // y'; // note: ação\n/* bloco: ação */ const b = `https://a/b`;");
    expect(code).toContain("'x // y'");
    expect(code).toContain('`https://a/b`');
    expect(code).not.toContain('ação');
  });

  it.each(scripts)('%s has no accented Portuguese and none of the old words in its code', (name) => {
    const code = withoutComments(readFileSync(join(UI, name), 'utf8'));
    expect(code.match(/[áàâãéêíóôõúç]/gi) ?? [], `accented letters in ${name}`).toEqual([]);
    expect(code.match(PORTUGUESE_WORDS) ?? [], `Portuguese words in ${name}`).toEqual([]);
  });

  it('reads every text it shows from the dictionary', () => {
    const used = new Set<string>();
    for (const name of scripts) {
      for (const match of readFileSync(join(UI, name), 'utf8').matchAll(/(?:\bt|translate)\((?:[a-z]+, )?'([a-zA-Z.]+)'/g)) used.add(match[1] ?? '');
      for (const match of readFileSync(join(UI, name), 'utf8').matchAll(/show[A-Za-z]*\('(installer\.[a-zA-Z.]+)'/g)) used.add(match[1] ?? '');
    }
    expect(used.size).toBeGreaterThan(8);
    for (const key of used) for (const language of LANGUAGES) expect(TEXTS[language.code].has(key), `${language.code} ${key}`).toBe(true);
  });
});

// ---- the shared script of the pages, bundled as the build does and run against a document that knows what it needs ----

interface FakeElement {
  dataset: Record<string, string>;
  attributes: Map<string, string>;
  textContent: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function fakeElement(options: { i18n?: string; attributes?: Record<string, string>; text?: string }): FakeElement {
  const attributes = new Map(Object.entries(options.attributes ?? {}));
  return {
    dataset: options.i18n === undefined ? {} : { i18n: options.i18n },
    attributes,
    textContent: options.text ?? '',
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => void attributes.set(name, value),
  };
}

interface FakeDocument {
  documentElement: { lang: string; dataset: Record<string, string> };
  body: { textContent: string };
  querySelectorAll(selector: string): FakeElement[];
}

function fakeDocument(elements: FakeElement[]): FakeDocument {
  return {
    documentElement: { lang: 'pt-BR', dataset: {} },
    body: { textContent: '' },
    querySelectorAll: (selector) => {
      if (selector === '[data-i18n]') return elements.filter((element) => element.dataset.i18n !== undefined);
      const attribute = /^\[(data-i18n-[a-z-]+)\]$/.exec(selector)?.[1];
      return attribute === undefined ? [] : elements.filter((element) => element.attributes.has(attribute));
    },
  };
}

/** `installer/ui/common.ts` as the page gets it (an esbuild bundle), loaded in a context that has the given document. */
async function loadCommon(document: FakeDocument, navigatorLanguage = 'en-US') {
  const result = await build({
    entryPoints: [join(UI, 'common.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'common',
    platform: 'browser',
    target: 'chrome130',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles?.[0]?.text ?? '';
  const context = createContext({ document, navigator: { language: navigatorLanguage }, window: {} });
  runInContext(code, context);
  const exported: unknown = context.common;
  const read = (name: string): ((...args: unknown[]) => unknown) => {
    const member: unknown = typeof exported === 'object' && exported !== null ? Reflect.get(exported, name) : undefined;
    if (typeof member !== 'function') throw new Error(`common.${name} is not exported`);
    return (...args) => Reflect.apply(member, undefined, args);
  };
  return { applyLanguage: read('applyLanguage'), showBridgeMissing: read('showBridgeMissing') };
}

describe('the shared script of the pages', () => {
  const makePage = () => {
    const title = fakeElement({ i18n: 'installer.setup.install', text: 'Instalar' });
    const unknown = fakeElement({ i18n: 'installer.setup.nothing', text: 'fallback' });
    const button = fakeElement({ attributes: { 'aria-label': 'Fechar', 'data-i18n-aria-label': 'installer.window.close' } });
    const track = fakeElement({ attributes: { 'aria-label': 'Progresso da instalação', 'data-i18n-aria-label': 'installer.setup.progressLabel' } });
    return { title, unknown, button, track, document: fakeDocument([title, unknown, button, track]) };
  };

  it.each([
    ['en', 'Install', 'Close', 'Installation progress'],
    ['es', 'Instalar', 'Cerrar', 'Progreso de la instalación'],
    ['pt-BR', 'Instalar', 'Fechar', 'Progresso da instalação'],
  ] as const)('applyLanguage writes the page in %s: texts, labels, <html lang>, and shows the page', async (language, install, close, progress) => {
    const page = makePage();
    const common = await loadCommon(page.document);
    common.applyLanguage(language);
    expect(page.title.textContent).toBe(install);
    expect(page.button.attributes.get('aria-label')).toBe(close);
    expect(page.track.attributes.get('aria-label')).toBe(progress);
    expect(page.document.documentElement.lang).toBe(language);
    expect(page.document.documentElement.dataset.ready).toBe('true');
  });

  it('applyLanguage keeps the fallback of a key it does not know', async () => {
    const page = makePage();
    const common = await loadCommon(page.document);
    common.applyLanguage('en');
    expect(page.unknown.textContent).toBe('fallback');
  });

  it('a missing bridge says so in the language of the browser', async () => {
    const spanish = makePage();
    (await loadCommon(spanish.document, 'es-MX')).showBridgeMissing('installer.setup.bridgeMissing');
    expect(spanish.document.body.textContent).toBe('El instalador no pudo iniciar (sin conexión con la aplicación).');
    expect(spanish.document.documentElement.lang).toBe('es');
    expect(spanish.document.documentElement.dataset.ready).toBe('true');

    const other = makePage();
    (await loadCommon(other.document, 'fr-FR')).showBridgeMissing('installer.uninstall.bridgeMissing');
    expect(other.document.body.textContent).toBe('The uninstaller could not start (no bridge to the application).');
  });

  it('the page scripts bundle for the browser, as the build does', async () => {
    for (const entry of ['installer.ts', 'uninstall.ts']) {
      const result = await build({
        entryPoints: [join(UI, entry)],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'chrome130',
        write: false,
        logLevel: 'silent',
      });
      expect(result.outputFiles?.[0]?.text.length ?? 0, entry).toBeGreaterThan(1000);
    }
  });
});
