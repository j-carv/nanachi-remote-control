import type { ResetEntry, ResetRedeemResponse } from '@nanachi/shared';
import { describeRedeemError } from '../errorMessages.js';

/** Agents with a reset source in the daemon. Any other agent id answers 400 `resets_unsupported`, so it is never asked. */
const RESET_AGENTS: ReadonlySet<string> = new Set(['omp', 'codex']);

export function supportsResets(agentId: string): boolean {
  return RESET_AGENTS.has(agentId);
}

/** "2 salvos · 1 disponível agora": the saved count and how many can be spent now, in the right number. */
export function resetCountsText(entry: Pick<ResetEntry, 'available' | 'usable'>): string {
  const saved = entry.available === 1 ? 'salvo' : 'salvos';
  const usable = entry.usable === 1 ? 'disponível' : 'disponíveis';
  return `${entry.available} ${saved} · ${entry.usable} ${usable} agora`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * "expira ..." for a row, or null when no expiry is known. Codex sends ISO-8601: near dates become relative ("expira
 * em 5 h"), a week or more away becomes the local date, a past one is "expirou". The text omp prints is shown as it is.
 */
export function resetExpiryText(expiresAt: string | null, now: number): string | null {
  if (expiresAt === null) return null;
  const when = ISO_DATE_TIME.test(expiresAt) ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(when)) return `expira ${expiresAt}`;

  const diff = when - now;
  if (diff <= 0) return 'expirou';
  // Whole minutes, rounded down like the hours below, so 59.5 min is never "60 min". Under a minute still says 1.
  if (diff < HOUR_MS) return `expira em ${Math.max(1, Math.floor(diff / MINUTE_MS))} min`;
  if (diff < DAY_MS) return `expira em ${Math.floor(diff / HOUR_MS)} h`;
  if (diff < 7 * DAY_MS) {
    const days = Math.floor(diff / DAY_MS);
    return `expira em ${days} ${days === 1 ? 'dia' : 'dias'}`;
  }
  const date = new Date(when);
  return `expira em ${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
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
  return {
    title: 'Usar 1 reset?',
    body: `${who}. Gasta um reset salvo e libera o limite agora. Não dá para desfazer.`,
  };
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

const OUTCOME_TEXT: Record<ResetRedeemResponse['outcome'], string> = {
  reset: 'Reset aplicado.',
  nothing_to_reset: 'Não há nada para liberar agora; nenhum reset foi gasto.',
  no_credit: 'Não há resets salvos para gastar.',
  already_redeemed: 'Esse reset já foi usado.',
  failed: 'O agente não confirmou o reset.',
};

/** The agent's own line (omp prints English) with the outcome's tone; a fixed text when the line is empty. */
export function redeemResultOf(response: ResetRedeemResponse): RedeemResult {
  const message = response.message.trim();
  return { tone: resetOutcomeTone(response.outcome), message: message === '' ? OUTCOME_TEXT[response.outcome] : message };
}

/** A redeem that failed as a request (409, 504, network...). It is shown as an error block. */
export function redeemFailureOf(error: unknown): RedeemResult {
  return { tone: 'error', message: describeRedeemError(error) };
}
