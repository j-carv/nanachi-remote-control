import type { Language } from '../languages.js';
import type { Strings } from '../types.js';
import { en } from './en/index.js';
import { es } from './es/index.js';
import { ptBR } from './pt-BR/index.js';

/** The shape every language follows: the keys of the pt-BR dictionary, every text a plain string. */
export type Dictionary = Strings<typeof ptBR>;

/** Every dictionary is bundled: nothing is loaded lazily. Texts live in `locales/<language>/<group>.ts`. */
export const dictionaries: Record<Language, Dictionary> = { 'pt-BR': ptBR, en, es };
