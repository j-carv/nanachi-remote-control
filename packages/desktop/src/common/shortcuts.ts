import { CONTROL_SECTIONS, type ControlSection } from './control-api.js';

/** The part of a DOM `KeyboardEvent` (and of Electron's `Input`) the shortcuts read. */
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

/** Ctrl+1..8 -> the section with that number (`CONTROL_SECTIONS`; a section without a number has no shortcut). */
export function sectionForShortcut(event: KeyLike): ControlSection | null {
  if (!isPlainCtrl(event) || !/^[1-9]$/.test(event.key)) return null;
  return CONTROL_SECTIONS[Number(event.key) - 1] ?? null;
}

/** Ctrl+B collapses or expands the sidebar. */
export function isSidebarToggle(event: KeyLike): boolean {
  return isPlainCtrl(event) && event.key.toLowerCase() === 'b';
}

/** The part of Electron's `before-input-event` `Input` used here (its modifier flags are not the DOM's). */
export interface InputLike {
  type: string;
  key: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  isAutoRepeat?: boolean;
}

/**
 * The section a key press selects, read from an Electron input event: the sessions view (the PWA) holds the keyboard focus
 * while it is on screen, so main watches its key presses for Ctrl+1..8 and hands them to the page, which otherwise would
 * never see them and the user could not leave the section with the keyboard.
 */
export function sectionForInput(input: InputLike): ControlSection | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat === true) return null;
  return sectionForShortcut({ key: input.key, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta });
}
