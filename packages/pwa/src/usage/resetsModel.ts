import type { ResetEntry, ResetRedeemResponse } from '@nanachi/shared';
import { describeRedeemError } from '../errorMessages.js';
import { currentLanguage, t, type Language } from '../i18n/index.js';

/** Agents with a reset source in the daemon. Any other agent id answers 400 `resets_unsupported`, so it is never asked. */
const RESET_AGENTS: ReadonlySet<string> = new Set(['omp', 'codex']);

export function supportsResets(agentId: string): boolean {
  return RESET_AGENTS.has(agentId);
}

/** "2 saved · 1 available now" (pt-BR: "2 salvos · 1 disponível agora"): the saved count and how many can be spent now. */
export function resetCountsText(entry: Pick<ResetEntry, 'available' | 'usable'>): string {
  const saved = t('usage:resets.saved', { count: entry.available });
  const usable = t('usage:resets.usable', { count: entry.usable });
  return `${saved} · ${usable}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Numeric day/month/year in Portuguese, an abbreviated month in English (the numeric order is ambiguous). */
const DATE_FORMAT: Record<Language, Intl.DateTimeFormatOptions> = {
  'pt-BR': { day: '2-digit', month: '2-digit', year: 'numeric' },
  en: { day: 'numeric', month: 'short', year: 'numeric' },
};

/**
 * "expires ..." for a row (pt-BR "expira ..."), or null when no expiry is known. Codex sends ISO-8601: near dates become
 * relative ("expires in 5 h"), a week or more away becomes the local date, a past one is "expired". The text omp prints
 * is shown as it is.
 */
export function resetExpiryText(expiresAt: string | null, now: number): string | null {
  if (expiresAt === null) return null;
  const when = ISO_DATE_TIME.test(expiresAt) ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(when)) return t('usage:expiry.raw', { when: expiresAt });

  const diff = when - now;
  if (diff <= 0) return t('usage:expiry.expired');
  // Whole minutes, rounded down like the hours below, so 59.5 min is never "60 min". Under a minute still says 1.
  if (diff < HOUR_MS) return t('usage:expiry.inMinutes', { count: Math.max(1, Math.floor(diff / MINUTE_MS)) });
  if (diff < DAY_MS) return t('usage:expiry.inHours', { count: Math.floor(diff / HOUR_MS) });
  if (diff < 7 * DAY_MS) return t('usage:expiry.inDays', { count: Math.floor(diff / DAY_MS) });
  const language = currentLanguage();
  return t('usage:expiry.onDate', { date: new Intl.DateTimeFormat(language, DATE_FORMAT[language]).format(new Date(when)) });
}

/** The row button: enabled only when a reset can be spent now, and never while a redeem is running. */
export function canRedeem(entry: Pick<ResetEntry, 'usable'>, redeeming: boolean): boolean {
  return entry.usable > 0 && !redeeming;
}

export interface RedeemConfirmText {
  title: string;
  body: string;
}

/** Texts of the confirmation sheet. Nothing is spent until the sheet's "Usar reset" is tapped. */
export function redeemConfirmText(entry: Pick<ResetEntry, 'accountLabel' | 'providerLabel'>): RedeemConfirmText {
  const who = entry.providerLabel === null ? entry.accountLabel : `${entry.accountLabel} · ${entry.providerLabel}`;
  return { title: t('usage:confirm.title'), body: t('usage:confirm.body', { who }) };
}

/** How the reply of a redeem is shown: success styling for a spent reset, an error block for a failed request. */
export type RedeemTone = 'success' | 'neutral' | 'error';

export interface RedeemResult {
  tone: RedeemTone;
  message: string;
}

export function resetOutcomeTone(outcome: ResetRedeemResponse['outcome']): 'success' | 'neutral' {
  return outcome === 'reset' ? 'success' : 'neutral';
}

/** The agent's own line (omp prints English, and it stays as it is) with the outcome's tone; a fixed text in the current language when the line is empty. */
export function redeemResultOf(response: ResetRedeemResponse): RedeemResult {
  const message = response.message.trim();
  return {
    tone: resetOutcomeTone(response.outcome),
    message: message === '' ? t(`usage:outcome.${response.outcome}`) : message,
  };
}

/** A redeem that failed as a request (409, 504, network...). It is shown as an error block. */
export function redeemFailureOf(error: unknown): RedeemResult {
  return { tone: 'error', message: describeRedeemError(error) };
}
