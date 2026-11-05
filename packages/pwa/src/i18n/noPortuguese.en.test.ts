// A sweep for Portuguese left in the English interface. Every screen, panel and card that can be server-rendered is
// rendered in `en` with fake data written in English, so any Portuguese word in the markup comes from the app, not from
// the data. The text nodes and the attributes a person reads (aria-label, title, placeholder, alt) are checked against
// a list of Portuguese UI words, and any letter with a Portuguese diacritic is flagged. What is rendered lives in
// `screenSweep.ts`, shared with the Spanish sweep; this file brings the English detector.
//
// Sheets (drawers) mount in a portal that a static render skips, so their text is checked in the translation files
// instead (the last block) and in the browser by e2e/run-i18n.mjs. Effects do not run in a static render: the data
// screens show their first state (loading).
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { describeError } from '../errorMessages.js';
import { FilesScreen } from '../screens/FilesScreen.js';
import { PairScreen } from '../screens/PairScreen.js';
import { NAMESPACES, setLanguage } from './index.js';
import ptChat from './locales/pt-BR/chat.json';
import enAccounts from './locales/en/accounts.json';
import enChat from './locales/en/chat.json';
import enCommon from './locales/en/common.json';
import enDesktop from './locales/en/desktop.json';
import enDevices from './locales/en/devices.json';
import enErrors from './locales/en/errors.json';
import enFiles from './locales/en/files.json';
import enMachines from './locales/en/machines.json';
import enPairing from './locales/en/pairing.json';
import enSettings from './locales/en/settings.json';
import enTerminal from './locales/en/terminal.json';
import enUsage from './locales/en/usage.json';
import enWide from './locales/en/wide.json';
import enWorkspace from './locales/en/workspace.json';
import { api, describeScreenSweep, entries, html, nav, noop, visibleText, workspace } from './screenSweep.js';

// --- the detector -------------------------------------------------------------------------------------------------

/** Portuguese UI words that are not English words. Short words that exist in English too (no, for, a, e...) stay out. */
const PORTUGUESE_WORDS = new Set(
  (
    'sessão sessões sessao remover remova cancelar configurar configuração configurações enviar envie novo nova novos ' +
    'novas abrir abra abrindo fechar feche conta contas uso ajustes ajuste carregando nenhum nenhuma voltar salvar ' +
    'salvo salvos salva salvando arquivo arquivos pasta pastas erro tentar tente atualizar atualização atualizando ' +
    'alterações alteração copiar copiado colar editar excluir apagar buscar procurar aguardando aguarde conectado ' +
    'conectando desconectado dispositivo dispositivos máquina máquinas parear pareamento código endereço rodando ' +
    'pronta pronto parado parada retomar retomando silenciar usar limite restante restantes hoje ontem agora ' +
    'mensagem mensagens permitir negar recusar aprovar trabalhando pensando falhou falha sucesso tela projeto ' +
    'histórico importando importar listando nome nomear renomear caractere caracteres segundos minutos horas dias ' +
    'semana não você seu sua seus suas uma para pelo pela foi está são ainda também quando onde porque mas deste ' +
    'desta neste nesta este esta executar execução alterado ações ação ver mostrar ocultar fixar sair entrar ' +
    'usuário senha celular aparelho consultando indisponível disponível desligado ligado ativo ativa inativo'
  ).split(' '),
);

/** Texts that are Portuguese on purpose: each language shows its own name, and the row title is bilingual. */
const KEPT_PORTUGUESE = ['Português (Brasil)', 'Idioma / Language'];

const DIACRITIC = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/** The Portuguese words in a text, in order of appearance (empty when it is all English). */
function portugueseIn(raw: string): string[] {
  let text = raw;
  for (const kept of KEPT_PORTUGUESE) text = text.split(kept).join(' ');
  const found: string[] = [];
  for (const word of text.match(/\p{L}+/gu) ?? []) {
    if (PORTUGUESE_WORDS.has(word.toLowerCase()) || DIACRITIC.test(word)) found.push(word);
  }
  return found;
}

/** Fails with the offending words, and the markup they came from, when a rendered piece still has Portuguese. */
function expectEnglish(name: string, markup: string): void {
  expect(markup.length, `${name} rendered nothing`).toBeGreaterThan(0);
  expect(portugueseIn(visibleText(markup)), `Portuguese left in ${name}`).toEqual([]);
}

describe('the detector', () => {
  it('finds Portuguese words and diacritics, in text and in the attributes a person reads', () => {
    expect(portugueseIn(visibleText('<button aria-label="Fechar">Salvar alterações</button>'))).toEqual(['Salvar', 'alterações', 'Fechar']);
    expect(portugueseIn(visibleText('<input placeholder="Nome do arquivo"/>'))).toEqual(['Nome', 'arquivo']);
    expect(portugueseIn('Não é possível')).toEqual(['Não', 'é', 'possível']);
  });

  it('leaves English, markup noise and the two kept names alone', () => {
    expect(portugueseIn(visibleText('<div class="flex uso" data-x="Sessão">Loading sessions…</div>'))).toEqual([]);
    expect(portugueseIn('Português (Brasil) Idioma / Language English')).toEqual([]);
    expect(portugueseIn(visibleText('<span>can&#x27;t</span>'))).toEqual([]);
  });
});

describe('the sweep is not vacuous', () => {
  it('trips on the same screens and texts in Portuguese', () => {
    setLanguage('pt-BR');
    const pair = { initialBaseUrl: 'http://127.0.0.1:7777', canCancel: true, onCancel: noop, onPaired: noop };
    expect(portugueseIn(visibleText(html(createElement(PairScreen, pair)))).length).toBeGreaterThan(3);
    expect(portugueseIn(visibleText(html(createElement(FilesScreen, { workspace, path: '', api, nav, onRepair: noop })))).length).toBeGreaterThan(3);
    expect(portugueseIn(describeError(new ApiError('unauthorized', 401))).length).toBeGreaterThan(0);
    expect(entries(ptChat).filter(([, text]) => portugueseIn(text).length > 0).length).toBeGreaterThan(50);
  });
});

describeScreenSweep({ language: 'en', label: 'English', expectClean: expectEnglish, leftover: portugueseIn });

// --- the translation files (covers the sheets, toasts and every text built outside React) ----------------------------

describe('the English translation files', () => {
  const files: Record<string, unknown> = {
    accounts: enAccounts,
    chat: enChat,
    common: enCommon,
    desktop: enDesktop,
    devices: enDevices,
    errors: enErrors,
    files: enFiles,
    machines: enMachines,
    pairing: enPairing,
    settings: enSettings,
    terminal: enTerminal,
    usage: enUsage,
    wide: enWide,
    workspace: enWorkspace,
  };

  it('covers every registered namespace', () => {
    expect(Object.keys(files).sort()).toEqual([...NAMESPACES].sort());
  });

  it('has no Portuguese word or diacritic in any value', () => {
    const found: string[] = [];
    for (const [namespace, content] of Object.entries(files)) {
      for (const [key, text] of entries(content)) {
        const words = portugueseIn(text);
        if (words.length > 0) found.push(`${namespace}:${key} -> ${words.join(', ')}`);
      }
    }
    expect(found).toEqual([]);
  });
});
