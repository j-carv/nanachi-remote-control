import { getLanguage, translate, type Language } from './i18n/index.js';
import type { DaemonStatus } from './types.js';

/**
 * First tray menu line and tooltip, in `language` (the one Desktop speaks now by default). The pt-BR wording is the one
 * the tests pin down.
 */
export function statusLabel(status: Pick<DaemonStatus, 'state'>, language: Language = getLanguage()): string {
  switch (status.state) {
    case 'starting':
      return translate(language, 'main.status.starting');
    case 'running':
      return translate(language, 'main.status.running');
    case 'attached':
      return translate(language, 'main.status.attached');
    case 'stopped':
      return translate(language, 'main.status.stopped');
    case 'error':
      return translate(language, 'main.status.error');
  }
}
