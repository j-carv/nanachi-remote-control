import type { ControlError } from '../../common/control-api.js';
import type { ControlT } from '../i18n.js';

/** Short headline for an error state; the `message` from main (already in the page's language) goes under it. */
export function errorTitle(code: ControlError['code'], t: ControlT): string {
  return t(`errors.title.${code}`);
}

/**
 * Attached to a daemon Desktop did not start, the daemon may not know this app: devices and accounts answer these codes.
 * They are expected there, so the screen explains instead of alarming.
 */
export function isCalmError(code: ControlError['code']): boolean {
  return code === 'not_paired' || code === 'unauthorized' || code === 'not_own_daemon';
}

export function calmErrorHint(t: ControlT): string {
  return t('errors.calmHint');
}

/**
 * An IPC call that rejects (instead of returning a `ControlError`) is shown as an unknown error, never as raw text. The
 * failure was born in the page, so there is no message from main to carry: it is left empty and `errorMessage` words it in the
 * language on screen when the error is shown.
 */
export function toControlError(_error: unknown): ControlError {
  return { ok: false, code: 'unknown', message: '' };
}

/** The text to show for an error: main's own message, or (for an empty one) the page's generic line in the current language. */
export function errorMessage(error: ControlError, t: ControlT): string {
  return error.message === '' ? t('errors.unreachable') : error.message;
}
