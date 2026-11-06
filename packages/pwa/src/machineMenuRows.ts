import { Trash } from 'lucide-react';
import type { ActionSheetItem } from './components/ActionSheet.js';
import { t } from './i18n/index.js';

/**
 * The rows of a machine's "..." menu on the home screen. "Remover máquina" is the only one, and it is destructive: it sits
 * in this menu, not in the bottom stack under the primary button. Built while rendering, so the text follows the language.
 */
export function machineMenuRows(onRemove: () => void): ActionSheetItem[] {
  return [{ label: t('machines:main.removeMachine'), icon: Trash, tone: 'danger', onSelect: onRemove }];
}
