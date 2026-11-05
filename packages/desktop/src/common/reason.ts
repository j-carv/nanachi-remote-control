import type { Language } from './i18n/languages.js';
import { getLanguage, translate, type MessageKey } from './i18n/translate.js';

/**
 * A message that stays in state (the daemon's `message`, the Tailscale error) is kept as what it says and not as the text it
 * had when it was made: it is turned into text when it is read, in the language in effect then, so a language switch is
 * followed without anyone having to rebuild it. A `Reason` is either a dictionary key with its parameters (a parameter may
 * itself be a `Reason`, as in "crashed (signal SIGTERM)") or a text that is nobody's to translate (what a sidecar printed).
 */
export interface KeyReason {
  readonly key: MessageKey;
  readonly params?: { readonly [name: string]: string | number | Reason };
}

export interface TextReason {
  readonly text: string;
}

export type Reason = KeyReason | TextReason;

/** A reason from a key and, optionally, its parameters. */
export function reasonOf(key: MessageKey, params?: KeyReason['params']): Reason {
  return params === undefined ? { key } : { key, params };
}

/** The text of a reason in `language` (the current one by default), nested reasons included. */
export function reasonText(reason: Reason, language: Language = getLanguage()): string {
  if ('text' in reason) return reason.text;
  if (reason.params === undefined) return translate(language, reason.key);
  const resolved: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(reason.params)) {
    resolved[name] = typeof value === 'object' ? reasonText(value, language) : value;
  }
  return translate(language, reason.key, resolved);
}
