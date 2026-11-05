import { t } from '../i18n/index.js';

// Injected by `define` in vite.config.ts (the build id). Without the define, for example in a dev server that was
// already running before the change, the identifier is not replaced; `typeof` avoids a ReferenceError.
declare const __APP_BUILD__: string;

/** Id of the running build (the short git hash), or "desconhecida" / "unknown" when the build did not provide one. */
export function appBuildId(): string {
  const known = typeof __APP_BUILD__ === 'string' && __APP_BUILD__.length > 0;
  return known ? __APP_BUILD__ : t('common:forceUpdate.unknownBuild');
}
