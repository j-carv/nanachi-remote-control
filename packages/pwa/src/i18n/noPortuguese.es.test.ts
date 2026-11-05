// A sweep for Portuguese left in the Spanish interface, in two parts.
//
// 1. Every screen, panel and card that can be server-rendered is rendered in `es` with fake data written in English
//    (`screenSweep.ts`, the same pieces as the English sweep). The text nodes and the attributes a person reads
//    (aria-label, title, placeholder, alt) are checked against a list of Portuguese UI words and for letters that
//    Spanish never uses (ã, õ, ç, â, ê, ô, à). The two languages share many words, so the list holds only Portuguese
//    words that are not Spanish ones; a Portuguese text that happens to be valid Spanish is caught by part 2.
// 2. The translation files: no value may contain Portuguese, and no `es` value may be identical to its `pt-BR` value
//    unless it is on an explicit list of texts that are the same in both languages (a copy that was never translated
//    looks exactly like that). The list is checked both ways, so it cannot go stale.
//
// Sheets (drawers) mount in a portal that a static render skips, so their text is checked through the files and in the
// browser by e2e/run-i18n.mjs. Effects do not run in a static render: the data screens show their first state (loading).
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { describeError } from '../errorMessages.js';
import { FilesScreen } from '../screens/FilesScreen.js';
import { PairScreen } from '../screens/PairScreen.js';
import { flattenLeaves } from './localeCheck.js';
import { NAMESPACES, setLanguage } from './index.js';
import { resources } from './resources.js';
import { api, describeScreenSweep, entries, html, nav, noop, visibleText, workspace } from './screenSweep.js';

// --- the detector -------------------------------------------------------------------------------------------------

/**
 * Portuguese UI words that are not Spanish words. Words that both languages spell the same (cancelar, enviar, abrir,
 * uso, ajustes, copiar, buscar, para, mas...) stay out, and so do short words that appear in URLs or names.
 */
const PORTUGUESE_WORDS = new Set(
  (
    'novo nova novos novas fechar feche conta contas carregando nenhum nenhuma voltar arquivo arquivos erro erros ' +
    'tentar tente atualizar atualizado atualizando pareamento hoje ontem agora mensagem mensagens pronta ' +
    'trabalhando falhou falha sucesso projeto nome nomear renomear caractere dias seu sua seus suas uma foi ainda ' +
    'também quando onde deste desta neste nesta executar sair usuário senha aparelho indisponível disponível ' +
    'possível desligado ativo ativa inativo rodada rodadas entendi isso isto esse essa pode podem já ou ao aos'
  ).split(' '),
);

/** Texts that are Portuguese on purpose: each language shows its own name, and the row title is bilingual. */
const KEPT_PORTUGUESE = ['Português (Brasil)', 'Idioma / Language'];

/** Letters Portuguese uses and Spanish does not (á é í ó ú are Spanish too, so they say nothing). */
const PORTUGUESE_ONLY_LETTER = /[àâãêôõçÀÂÃÊÔÕÇ]/;

/** The Portuguese words in a text, in order of appearance (empty when it is all Spanish). */
function portugueseIn(raw: string): string[] {
  let text = raw;
  for (const kept of KEPT_PORTUGUESE) text = text.split(kept).join(' ');
  const found: string[] = [];
  for (const word of text.match(/\p{L}+/gu) ?? []) {
    if (PORTUGUESE_WORDS.has(word.toLowerCase()) || PORTUGUESE_ONLY_LETTER.test(word)) found.push(word);
  }
  return found;
}

/** Fails with the offending words, and the piece they came from, when a rendered piece still has Portuguese. */
function expectSpanish(name: string, markup: string): void {
  expect(markup.length, `${name} rendered nothing`).toBeGreaterThan(0);
  expect(portugueseIn(visibleText(markup)), `Portuguese left in ${name}`).toEqual([]);
}

describe('the detector', () => {
  it('finds Portuguese words and letters, in text and in the attributes a person reads', () => {
    expect(portugueseIn(visibleText('<button aria-label="Fechar">Guardar alterações</button>'))).toEqual(['alterações', 'Fechar']);
    expect(portugueseIn(visibleText('<input placeholder="Nome do arquivo"/>'))).toEqual(['Nome', 'arquivo']);
    expect(portugueseIn('Não é possível')).toEqual(['Não', 'possível']);
  });

  it('leaves Spanish, words the two languages share, markup noise and the kept names alone', () => {
    expect(portugueseIn('¿Quitar "Cuenta"? Se detendrán las sesiones. Abrir, cancelar y enviar para ajustes.')).toEqual([]);
    expect(portugueseIn(visibleText('<div class="flex uso" data-x="Sessão">Cargando sesiones…</div>'))).toEqual([]);
    expect(portugueseIn('Português (Brasil) Idioma / Language English Español')).toEqual([]);
    expect(portugueseIn('https://login.example.com/auth')).toEqual([]);
  });
});

describe('the sweep is not vacuous', () => {
  it('trips on the same screens and texts in Portuguese', () => {
    setLanguage('pt-BR');
    const pair = { initialBaseUrl: 'http://127.0.0.1:7777', canCancel: true, onCancel: noop, onPaired: noop };
    expect(portugueseIn(visibleText(html(createElement(PairScreen, pair)))).length).toBeGreaterThan(1);
    expect(portugueseIn(visibleText(html(createElement(FilesScreen, { workspace, path: '', api, nav, onRepair: noop })))).length).toBeGreaterThan(3);
    expect(portugueseIn(describeError(new ApiError('unauthorized', 401))).length).toBeGreaterThan(0);
    expect(entries(resources['pt-BR'].chat).filter(([, text]) => portugueseIn(text).length > 0).length).toBeGreaterThan(30);
  });
});

describeScreenSweep({ language: 'es', label: 'Spanish', expectClean: expectSpanish, leftover: portugueseIn });

// --- the translation files (covers the sheets, toasts and every text built outside React) ----------------------------

/**
 * Texts that are the same in `pt-BR` and `es` because they are names, technical words or keycaps that no language
 * translates. `namespace:key`.
 */
const PRODUCT_OR_TECHNICAL = [
  'chat:header.loop', // Modo Loop: the product's feature name
  'chat:loop.sheet.title',
  'chat:item.loopRound',
  'chat:loop.chip.countdownShort',
  'chat:background.jobs',
  'chat:agentConfig.thought_level', // the agent's own name for it
  'chat:loop.sheet.prompt',
  'usage:session.tokens',
  'desktop:title',
  'desktop:group',
  'desktop:daemon.label',
  'desktop:tailscale.tailnet',
  'machines:main.workspaces', // workspace is the app's own word in every language
  'machines:card.workspaces_one',
  'machines:card.workspaces_other',
  'workspace:workspaces.title',
  'workspace:terminalBadge',
  'workspace:sessions.terminal',
  'terminal:shellSheet.title',
  'common:sessionTitle.terminal',
  'terminal:dismiss', // OK
  'terminal:keys.ariaLabel.esc', // keycaps, as printed on the keyboard
  'terminal:keys.ariaLabel.tab',
  'terminal:keys.ariaLabel.pgup',
  'terminal:keys.ariaLabel.pgdn',
  'terminal:keys.ariaLabel.enter',
];

/** Texts that Spanish and Portuguese happen to spell the same. `namespace:key`. */
const SAME_WORD_IN_BOTH = [
  'accounts:login.copyCode',
  'accounts:login.send',
  'accounts:login.sending',
  'accounts:login.cancelling',
  'accounts:login.step.starting',
  'accounts:copy.copied',
  'chat:composer.send',
  'chat:composer.sending',
  'chat:composer.uploading',
  'chat:composer.useCrop',
  'chat:commandSheet.choicesLabel',
  'chat:slash.search',
  'chat:attachments.crop',
  'chat:tool.innerWithLast',
  'chat:background.title',
  'chat:background.subagents',
  'chat:background.commands',
  'chat:item.thoughtSize_other',
  'chat:agentConfig.model',
  'chat:loop.started',
  'chat:loop.sheet.automatic',
  'chat:loop.sheet.pause',
  'chat:loop.sheet.interval',
  'chat:loop.sheet.start',
  'chat:loop.modes.dynamic.title',
  'common:actions.cancel',
  'common:sessionStatus.starting',
  'desktop:daemon.starting',
  'desktop:pairing.codeLabel',
  'desktop:tailscale.starting',
  'desktop:tailscale.connected',
  'devices:list',
  'files:viewer.crop',
  'files:viewer.viewCrop',
  'files:cropper.title',
  'files:cropper.cancel',
  'files:cropper.cropping',
  'files:crop.suffix',
  'files:thumb.open',
  'machines:status.connecting.label',
  'machines:main.machines',
  'pairing:fields.code',
  'pairing:tailscale.connectedAs',
  'settings:devices.heading',
  'settings:language.label',
  'terminal:copy.copied',
  'terminal:send',
  'terminal:keys.ariaLabel.pipe',
  'usage:windows.usageOf',
  'usage:windows.fiveHours',
  'usage:windows.weekly',
  'usage:windows.weeklyScope',
  'usage:windows.hours_one',
  'usage:windows.hours_other',
  'usage:info.model',
  'usage:info.input',
  'usage:info.credits',
  'usage:resets.use',
  'usage:resets.useFor',
  'usage:outcome.reset',
  'workspace:agent',
  'workspace:files.newFolderHint',
  'workspace:editor.label',
  'workspace:editor.plainText',
];

const ALLOWED_IDENTICAL = [...PRODUCT_OR_TECHNICAL, ...SAME_WORD_IN_BOTH];

/** Every text of a language as `namespace:key` to value. */
function textsOf(language: 'pt-BR' | 'es'): Map<string, string> {
  const texts = new Map<string, string>();
  for (const namespace of NAMESPACES) {
    for (const [key, text] of flattenLeaves(resources[language][namespace])) {
      if (text !== null) texts.set(`${namespace}:${key}`, text);
    }
  }
  return texts;
}

describe('the Spanish translation files', () => {
  it('cover every registered namespace', () => {
    expect(Object.keys(resources.es).sort()).toEqual([...NAMESPACES].sort());
  });

  it('have no Portuguese word or letter in any value', () => {
    const found: string[] = [];
    for (const [namespace, content] of Object.entries(resources.es)) {
      for (const [key, text] of entries(content)) {
        const words = portugueseIn(text);
        if (words.length > 0) found.push(`${namespace}:${key} -> ${words.join(', ')}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('have no value identical to the Portuguese one, except the listed texts that are the same in both', () => {
    const portuguese = textsOf('pt-BR');
    const identical = [...textsOf('es')]
      .filter(([id, text]) => portuguese.get(id) === text && !ALLOWED_IDENTICAL.includes(id))
      .map(([id, text]) => `${id} = ${JSON.stringify(text)}`);
    expect(identical, 'untranslated, or add it to the list if the two languages really spell it the same').toEqual([]);
  });

  it('keep the list of identical texts honest: every entry exists and is still identical, and none is listed twice', () => {
    const portuguese = textsOf('pt-BR');
    const spanish = textsOf('es');
    const stale = ALLOWED_IDENTICAL.filter((id) => !spanish.has(id) || spanish.get(id) !== portuguese.get(id));
    expect(stale, 'translated since, or renamed: remove it from the list').toEqual([]);
    expect(new Set(ALLOWED_IDENTICAL).size).toBe(ALLOWED_IDENTICAL.length);
  });

  it('uses "tú" and not "vos" or "usted" in the instructions it gives', () => {
    const forms = /(?<!\p{L})(?:vos|usted|ustedes|tenés|podés|hacé|elegí|abrí|probá|revisá)(?!\p{L})/iu;
    const found = [...textsOf('es')].filter(([, text]) => forms.test(text)).map(([id]) => id);
    expect(found).toEqual([]);
  });
});
