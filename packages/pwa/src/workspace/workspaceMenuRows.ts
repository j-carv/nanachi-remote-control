import { Bell, BellOff } from 'lucide-react';
import type { ActionSheetItem } from '../components/ActionSheet.js';
import { t } from '../i18n/index.js';

/**
 * The notifications row of a workspace's "..." menu: its state under the label, and a pick flips it. The screen keeps the
 * state and makes the request; `onToggle` receives the next value. Built while rendering, so the texts follow the language.
 * The row keeps the focus: the user stays on the same screen, so the sheet hands the focus back to its trigger.
 */
export function notificationsRow(muted: boolean, onToggle: (next: boolean) => void): ActionSheetItem {
  return {
    label: t('workspace:sessions.notifications'),
    icon: muted ? BellOff : Bell,
    detail: muted ? t('workspace:sessions.notificationsMuted') : t('workspace:sessions.notificationsOn'),
    keepsFocus: true,
    onSelect: () => onToggle(!muted),
  };
}
