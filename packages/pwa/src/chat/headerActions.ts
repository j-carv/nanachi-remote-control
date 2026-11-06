import type { AgentKind, Loop } from '@nanachi/shared';
import { allowsSidePane, type LayoutMode } from '../wide/layout.js';

/*
 * What the chat header shows, decided from plain inputs (no React, no i18n). The header row keeps the title, the status
 * and at most two trailing buttons; the rest of the session actions live in the "..." menu as labelled rows. The loop
 * and the background work show a chip while they are active (a loop also while it is paused after an error). The
 * component reads the plan and does the rendering.
 */

/** Trailing controls of the header row, in order from left to right. */
export type HeaderRowAction = 'files' | 'terminal' | 'configure' | 'more';

/** Rows of the "..." menu, in order. `remove` is always last. */
export type SheetRow =
  | { readonly entry: 'usage' }
  | { readonly entry: 'loop' }
  | { readonly entry: 'background'; readonly active: number; readonly total: number }
  | { readonly entry: 'changes' }
  | { readonly entry: 'remove' };

export interface HeaderActionsInput {
  /** `acp` is a chat session (agent usage and Loop); `pty` is a terminal session. */
  kind: AgentKind;
  /** Only the three-pane layout (1280 px and up) has room for Arquivos and Terminal beside Configurar. */
  layout: LayoutMode;
  /** The session's loop, or null when there is none. */
  loop: Pick<Loop, 'state' | 'lastError'> | null;
  /** Background items the drawer lists, running or not. */
  backgroundTotal: number;
  /** Background items the chip counts: running now, or ended in the latest turn. */
  backgroundActive: number;
}

export interface HeaderActionsPlan {
  readonly row: readonly HeaderRowAction[];
  readonly sheet: readonly SheetRow[];
  readonly chips: {
    /** A loop that runs, or one paused by an error. A loop the user paused has no chip, only its menu row. */
    readonly loop: boolean;
    readonly background: boolean;
  };
}

/** Whether the header shows the loop chip: while the loop runs, and after a failure stopped it (the reason to look). */
function loopHasChip(loop: Pick<Loop, 'state' | 'lastError'> | null): boolean {
  if (loop === null) return false;
  return loop.state === 'active' || (loop.state === 'paused' && loop.lastError !== null);
}

export function planHeaderActions(input: HeaderActionsInput): HeaderActionsPlan {
  const chat = input.kind === 'acp';

  const row: HeaderRowAction[] = allowsSidePane(input.layout) ? ['files', 'terminal', 'configure', 'more'] : ['configure', 'more'];

  const sheet: SheetRow[] = [];
  if (chat) sheet.push({ entry: 'usage' }, { entry: 'loop' });
  if (input.backgroundTotal > 0) {
    sheet.push({ entry: 'background', active: input.backgroundActive, total: input.backgroundTotal });
  }
  sheet.push({ entry: 'changes' }, { entry: 'remove' });

  return {
    row,
    sheet,
    chips: {
      loop: chat && loopHasChip(input.loop),
      background: input.backgroundActive > 0,
    },
  };
}
