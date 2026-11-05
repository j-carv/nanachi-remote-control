// Runs before every test file. The tests assert Portuguese texts, so every test starts in pt-BR; a test that switches
// the language does not leak into the next one.
import { afterEach } from 'vitest';
import { DEFAULT_LANGUAGE, setLanguage } from './index.js';

setLanguage(DEFAULT_LANGUAGE);

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE);
});
