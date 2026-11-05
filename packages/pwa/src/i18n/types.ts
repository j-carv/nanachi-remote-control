// Types the keys of `t` from the pt-BR files: a key that is not in them fails `npm run typecheck`.
// English is checked against pt-BR by `i18n.test.ts`.
import type { DEFAULT_NAMESPACE, resources } from './resources.js';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: (typeof resources)['pt-BR'];
  }
}
