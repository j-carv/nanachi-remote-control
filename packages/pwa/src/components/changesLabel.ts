import { t } from '../i18n/index.js';

/** Count of changed files in the workspace, in the current language ("sem alterações", "1 alteração", "3 alterações"). */
export function changesLabel(count: number): string {
  // Zero is explicit: Portuguese plural rules treat 0 like 1, which would read "0 alteração".
  if (count === 0) return t('workspace:infoBar.noChanges');
  return t('workspace:infoBar.changes', { count });
}
