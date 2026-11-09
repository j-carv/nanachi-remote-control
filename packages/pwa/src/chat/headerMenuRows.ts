import type { Loop } from '@nanachi/shared';
import { Gauge, GitCommitVertical, Layers, Repeat } from 'lucide-react';
import type { ActionSheetItem } from '../components/ActionSheet.js';
import { t } from '../i18n/index.js';
import type { SheetRow } from './headerActions.js';
import { loopMenuDetail } from './loop.js';

/** What the menu rows do when picked. Each one opens a sheet or a screen, or removes the session from the app. */
export interface HeaderMenuActions {
  openUsage(): void;
  openLoop(): void;
  openBackground(): void;
  openHistory(): void;
  remove(): void;
}

/**
 * The rows of the chat's "..." menu, from the plan's sheet: labels, icons, the detail under each label, and what a
 * pick does. Pure: the screen passes its loop and its actions in. The loop detail comes only from `loopMenuDetail`.
 */
export function headerMenuRows(sheet: readonly SheetRow[], loop: Loop | null, actions: HeaderMenuActions): ActionSheetItem[] {
  return sheet.map((row): ActionSheetItem => {
    switch (row.entry) {
      case 'usage':
        return { label: t('chat:header.usage'), icon: Gauge, haspopup: 'dialog', onSelect: actions.openUsage };
      case 'loop':
        return {
          label: t('chat:header.loop'),
          icon: Repeat,
          detail: loopMenuDetail(loop),
          haspopup: 'dialog',
          onSelect: actions.openLoop,
        };
      case 'background':
        return {
          label: t('chat:background.title'),
          icon: Layers,
          detail:
            row.active > 0
              ? t('chat:header.backgroundRunning', { count: row.active })
              : t('chat:header.backgroundTotal', { count: row.total }),
          haspopup: 'dialog',
          onSelect: actions.openBackground,
        };
      case 'history':
        return { label: t('chat:header.history'), icon: GitCommitVertical, onSelect: actions.openHistory };
      case 'remove':
        return { label: t('chat:header.removeFromApp'), tone: 'danger', haspopup: 'dialog', onSelect: actions.remove };
    }
  });
}
