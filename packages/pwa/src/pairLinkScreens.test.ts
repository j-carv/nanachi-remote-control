import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { setLanguage, t } from './i18n/index.js';
import { PairConnecting, PairInstallGuide } from './screens/PairLinkScreens.js';
import { PairScreen } from './screens/PairScreen.js';

const noop = () => undefined;
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

describe('PairScreen after a pair link could not pair', () => {
  const props = { initialBaseUrl: 'https://pc-sala.exemplo.ts.net', canCancel: false, onCancel: noop, onPaired: noop };

  it('prefills the code and shows why the automatic attempt failed', () => {
    const markup = html(createElement(PairScreen, { ...props, initialCode: '123456', initialError: new ApiError('invalid_code', 401) }));
    expect(markup).toContain('value="123456"');
    expect(markup).toContain(t('errors:api.invalid_code'));
  });

  it('prefills the code and shows no error when there is none to explain', () => {
    const markup = html(createElement(PairScreen, { ...props, initialCode: '123456' }));
    expect(markup).toContain('value="123456"');
    expect(markup).not.toContain('role="alert"');
  });
});

describe('PairConnecting and PairInstallGuide', () => {
  it('shows a status with no form while the pair link connects', () => {
    const markup = html(createElement(PairConnecting));
    expect(markup).toContain(t('pairing:link.connecting'));
    expect(markup).not.toContain('<form');
  });

  it('shows the install steps and the way out in English, and never the pairing code', () => {
    setLanguage('en');
    const markup = html(createElement(PairInstallGuide, { onContinue: noop }));
    expect(markup).toContain(t('pairing:link.installStep2'));
    expect(markup).toContain(t('pairing:link.installContinue'));
    // The maintainer's decision: the guide shows no pairing code, not its prompt and not a six-digit run.
    expect(markup).not.toContain('enter this code');
    expect(markup).not.toMatch(/\d{6}/);
  });
});
