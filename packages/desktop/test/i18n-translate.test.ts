import { afterEach, describe, expect, it } from 'vitest';
import { getLanguage, setLanguage, t, translate } from '../src/common/i18n/index.js';
import type { MessageKey } from '../src/common/i18n/index.js';

afterEach(() => setLanguage('pt-BR'));

describe('translate', () => {
  it('reads a dotted key in the language asked for', () => {
    expect(translate('pt-BR', 'main.status.running')).toBe('Nanachi · rodando');
    expect(translate('en', 'main.status.running')).toBe('Nanachi · running');
    expect(translate('es', 'main.status.running')).toBe('Nanachi · en ejecución');
  });

  it('replaces {{name}} placeholders and keeps one it has no value for', () => {
    expect(translate('en', 'control.sessions.startingDetail', { port: 7780 })).toBe('Waiting for the daemon to answer on port 7780.');
    expect(translate('es', 'control.sessions.startingDetail')).toBe('Esperando que el daemon responda en el puerto {{port}}.');
  });

  it('a key that exists nowhere is returned as it is, never an exception', () => {
    expect(translate('en', 'main.nothing.here' as MessageKey)).toBe('main.nothing.here');
  });

  it('the current language starts as pt-BR and follows setLanguage', () => {
    expect(getLanguage()).toBe('pt-BR');
    expect(t('main.status.stopped')).toBe('Nanachi · parado');
    setLanguage('es');
    expect(getLanguage()).toBe('es');
    expect(t('main.status.stopped')).toBe('Nanachi · detenido');
    setLanguage('en');
    expect(t('main.status.stopped')).toBe('Nanachi · stopped');
  });
});
