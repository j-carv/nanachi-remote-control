import type { Language } from '../../src/common/i18n/index.js';
import { createControlI18n, type ControlT } from '../../src/control/i18n.js';

/** The `t` of the control namespace in one language (pt-BR unless told otherwise), for the helpers that take one. */
export function controlT(language: Language = 'pt-BR'): ControlT {
  return createControlI18n(language).getFixedT(language, 'control');
}
