import { createElement, type ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Language } from '../../src/common/i18n/index.js';
import { createControlI18n } from '../../src/control/i18n.js';

/**
 * Renders a view of the control center to static markup in one language (pt-BR unless told otherwise). Every component reads
 * its texts through i18next, so a render needs the provider that `App` normally gives.
 */
export function html(element: ReactElement, language: Language = 'pt-BR'): string {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: createControlI18n(language) }, element));
}
