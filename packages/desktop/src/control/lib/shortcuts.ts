import { CONTROL_SECTIONS, type ControlSection } from '../../common/control-api.js';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function isPlainCtrl(event: KeyLike): boolean {
  return event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
}

/** Ctrl+1..7 -> the section at that position of the sidebar. */
export function sectionForShortcut(event: KeyLike): ControlSection | null {
  if (!isPlainCtrl(event) || !/^[1-9]$/.test(event.key)) return null;
  return CONTROL_SECTIONS[Number(event.key) - 1] ?? null;
}

/** Ctrl+B collapses or expands the sidebar. */
export function isSidebarToggle(event: KeyLike): boolean {
  return isPlainCtrl(event) && event.key.toLowerCase() === 'b';
}
