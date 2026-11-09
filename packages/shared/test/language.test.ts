import { describe, expect, it } from 'vitest';
import { APP_LANGUAGES, AppLanguageSchema } from '../src/index.js';

describe('APP_LANGUAGES', () => {
  it('lists the languages the app is translated into, pt-BR first (the default)', () => {
    expect(APP_LANGUAGES).toEqual(['pt-BR', 'en', 'es']);
  });
});

describe('AppLanguageSchema', () => {
  it.each(['pt-BR', 'en', 'es'])('accepts %s', (language) => {
    expect(AppLanguageSchema.parse(language)).toBe(language);
  });

  it.each(['pt', 'pt-br', 'PT-BR', 'en-US', 'fr', ''])('rejects %j', (language) => {
    expect(AppLanguageSchema.safeParse(language).success).toBe(false);
  });
});
