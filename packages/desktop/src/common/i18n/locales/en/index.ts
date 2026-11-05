import type { Strings } from '../../types.js';
import type { ptBR } from '../pt-BR/index.js';
import { control } from './control.js';
import { installer } from './installer.js';
import { main } from './main.js';

export const en: Strings<typeof ptBR> = { control, main, installer };
