import {
  dictionaries,
  languageFromLocale,
  setLanguage,
  t,
  translate,
  type Language,
  type MessageKey,
} from '../../src/common/i18n/index.js';
import type { InstallerApi, UninstallerApi } from '../../src/install/ipc.js';

declare global {
  interface Window {
    installer?: InstallerApi;
    uninstaller?: UninstallerApi;
  }
}

/** The element with `data-slot="<slot>"`; a missing one is a bug in the page, so it throws. */
export function slot<T extends HTMLElement = HTMLElement>(name: string): T {
  const element = document.querySelector<T>(`[data-slot="${name}"]`);
  if (element === null) throw new Error(`data-slot="${name}" is not in the page`);
  return element;
}

/** Shows one `<section data-view>` and hides the others. */
export function showView(name: string): void {
  for (const view of document.querySelectorAll<HTMLElement>('[data-view]')) {
    view.hidden = view.dataset.view !== name;
  }
}

/** True when `key` is a message of the dictionary (the pages name theirs in `data-i18n*` attributes, which are plain text). */
function isMessageKey(key: string): key is MessageKey {
  let node: unknown = dictionaries['pt-BR'];
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return false;
    node = Reflect.get(node, part);
  }
  return typeof node === 'string';
}

/** The attributes a page can translate and the `data-i18n-*` attribute that names the message of each. */
const ATTRIBUTES = [
  { attribute: 'aria-label', source: 'data-i18n-aria-label' },
  { attribute: 'title', source: 'data-i18n-title' },
  { attribute: 'alt', source: 'data-i18n-alt' },
] as const;

/**
 * Writes the page in `language`: the text of every `data-i18n="<key>"` element, the attributes named by `data-i18n-aria-label`
 * and its siblings, and `<html lang>`; the process-wide language is set too, so the scripts' own texts follow (`t`). The
 * Portuguese that the HTML carries is only the fallback for a key that does not exist. The page is then shown: its stage is
 * hidden until now, so no text flashes in another language.
 */
export function applyLanguage(language: Language): void {
  setLanguage(language);
  document.documentElement.lang = language;
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n;
    if (key !== undefined && isMessageKey(key)) element.textContent = translate(language, key);
  }
  for (const { attribute, source } of ATTRIBUTES) {
    for (const element of document.querySelectorAll<HTMLElement>(`[${source}]`)) {
      const key = element.getAttribute(source);
      if (key !== null && isMessageKey(key)) element.setAttribute(attribute, translate(language, key));
    }
  }
  document.documentElement.dataset.ready = 'true';
}

/** The language of the page's own browser, for the moments before (or without) the answer of the main process. */
export function browserLanguage(): Language {
  return languageFromLocale(navigator.language);
}

/** What the page says when the preload bridge is missing: there is no process to ask, so the browser's language is used. */
export function showBridgeMissing(key: 'installer.setup.bridgeMissing' | 'installer.uninstall.bridgeMissing'): void {
  const language = browserLanguage();
  document.documentElement.lang = language;
  document.documentElement.dataset.ready = 'true';
  document.body.textContent = translate(language, key);
}

/** Updates the bar and its labels. The bar never goes backwards. */
export function createProgressView(): { set(label: string, percent: number): void; reset(): void } {
  const step = slot('step');
  const percentLabel = slot('percent');
  const track = slot('track');
  const fill = track.querySelector<HTMLElement>('.fill');
  let shown = 0;
  function paint(percent: number): void {
    shown = percent;
    percentLabel.textContent = `${percent}%`;
    track.setAttribute('aria-valuenow', String(percent));
    fill?.style.setProperty('--progress', String(percent / 100));
  }
  return {
    set(label, percent) {
      step.textContent = `${label}…`;
      paint(Math.max(shown, Math.min(100, Math.round(percent))));
    },
    reset() {
      step.textContent = t('installer.common.preparing');
      paint(0);
    },
  };
}
