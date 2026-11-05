import { describe, expect, it } from 'vitest';
import { dictionaries } from '../src/common/i18n/index.js';

/** Every leaf of a dictionary group as `path -> text`. */
function flatten(node: unknown, prefix: string, into: Map<string, string>): Map<string, string> {
  if (typeof node === 'string') {
    into.set(prefix, node);
    return into;
  }
  if (typeof node !== 'object' || node === null) throw new Error(`${prefix}: not a string or an object`);
  for (const [key, value] of Object.entries(node)) flatten(value, `${prefix}.${key}`, into);
  return into;
}

/**
 * Texts that are legitimately the same as the Brazilian Portuguese ones: a product name, or a word that is spelled the same
 * in Spanish. Each entry says why; anything else that is identical to pt-BR is a text somebody forgot to translate. The
 * `control` group is held to the same rule by `test/control/noPortuguese.test.ts` (it has its own list).
 */
const SAME_AS_PT_BR: Record<string, string> = {
  'en main.dialogs.title': 'the product name',
  'es main.dialogs.title': 'the product name',
  'es main.status.starting': 'Nanachi · iniciando is spelled the same in Spanish',
  'es main.tray.open': '"Abrir Nanachi" is spelled the same in Spanish',
  'es main.pairingWindow.codeLabel': '"Código {{code}}" is spelled the same in Spanish',
  'es installer.window.minimize': '"Minimizar" is spelled the same in Spanish',
  'es installer.common.cancel': '"Cancelar" is spelled the same in Spanish',
  'es installer.common.preparing': '"Preparando" is spelled the same in Spanish',
  'es installer.setup.install': '"Instalar" is spelled the same in Spanish',
  'es installer.setup.doneTitle': '"Nanachi instalado" is spelled the same in Spanish',
};

describe('no text is left in Portuguese in English or Spanish', () => {
  for (const language of ['en', 'es'] as const) {
    for (const group of ['main', 'installer'] as const) {
      it(`${language} ${group}: no text equals its pt-BR text unless it is listed with a reason`, () => {
        const model = flatten(dictionaries['pt-BR'][group], group, new Map());
        const texts = flatten(dictionaries[language][group], group, new Map());
        const forgotten = [...texts]
          .filter(([key, text]) => text === model.get(key) && SAME_AS_PT_BR[`${language} ${key}`] === undefined)
          .map(([key]) => key);
        expect(forgotten).toEqual([]);
      });
    }
  }

  it('every entry of the list still names a text that is identical (a stale entry hides a real leftover later)', () => {
    for (const key of Object.keys(SAME_AS_PT_BR)) {
      const [language, path] = key.split(' ') as ['en' | 'es', string];
      const [group] = path.split('.') as ['main' | 'installer'];
      const model = flatten(dictionaries['pt-BR'][group], group, new Map());
      const texts = flatten(dictionaries[language][group], group, new Map());
      expect(texts.get(path), key).toBe(model.get(path));
    }
  });

  it('English and Spanish have no Portuguese-only letter (ã õ ç) in main or installer texts', () => {
    for (const language of ['en', 'es'] as const) {
      for (const group of ['main', 'installer'] as const) {
        for (const [key, text] of flatten(dictionaries[language][group], group, new Map())) {
          expect(/[ãõç]/i.test(text), `${language} ${key}: ${text}`).toBe(false);
        }
      }
    }
  });

  it('English has no accented letter at all in main or installer texts', () => {
    for (const [key, text] of flatten(dictionaries.en.main, 'main', new Map()).entries()) {
      expect(/[À-ÿ]/.test(text), `en ${key}: ${text}`).toBe(false);
    }
    for (const [key, text] of flatten(dictionaries.en.installer, 'installer', new Map()).entries()) {
      expect(/[À-ÿ]/.test(text), `en ${key}: ${text}`).toBe(false);
    }
  });
});
