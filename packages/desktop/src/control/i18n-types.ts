// Types the keys of `t` from the pt-BR dictionary: a key that is not in it fails `npm run typecheck`. The other languages are
// held to the same keys by their annotation (`Strings<typeof ptBR...>`) and by `test/i18n-dictionaries.test.ts`.
import type { control } from '../common/i18n/locales/pt-BR/control.js';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'control';
    resources: { control: typeof control };
  }
}
