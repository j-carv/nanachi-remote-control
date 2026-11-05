/**
 * Formatting for the control center, in the language of the page. Pure functions: the clock is always an argument, and dates
 * are built from the local calendar so a test and a user in any timezone read the same text. Numbers go through `Intl` (the
 * decimal mark follows the language); the words of a date (months, "yesterday", "3 min ago") are dictionary texts, so they
 * read the same in a test, in Node and in the Electron build whatever ICU data each one carries.
 */
import { DEFAULT_LANGUAGE, isLanguage, type Language } from '../../common/i18n/index.js';
import type { ControlT } from '../i18n.js';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const DAY_MS = 86_400_000;

/** The language an i18next instance speaks, or the default when it somehow speaks another one. */
export function languageOf(i18n: { language: string }): Language {
  return isLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(language: Language, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${language}:${maximumFractionDigits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(language, { maximumFractionDigits });
    numberFormats.set(key, format);
  }
  return format;
}

function digitsFor(value: number, unit: number): number {
  if (unit === 0) return 0;
  if (value >= 100) return 0;
  if (value >= 10) return 1;
  return 2;
}

/**
 * `238 GB`, `12,3 GB` (pt-BR, es) or `12.3 GB` (en), `1,82 TB`: binary units (as Explorer shows them), three significant
 * digits, the decimal mark of the language.
 */
export function formatBytes(bytes: number | null, language: Language): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let digits = digitsFor(value, unit);
  // 1023,9 KB rounds to 1.024: show it as 1 MB instead.
  if (unit > 0 && unit < BYTE_UNITS.length - 1 && Number(value.toFixed(digits)) >= 1000) {
    value /= 1024;
    unit += 1;
    digits = digitsFor(value, unit);
  }
  return `${numberFormat(language, digits).format(value)} ${BYTE_UNITS[unit]}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `5 nov 2026` (pt-BR, es) or `5 Nov 2026` (en). */
export function formatDate(ms: number, t: ControlT): string {
  const date = new Date(ms);
  const month = MONTH_KEYS[date.getMonth()] ?? 'jan';
  return `${date.getDate()} ${t(`format.months.${month}`)} ${date.getFullYear()}`;
}

/** `5 nov 2026, 14:32` (24 h). */
export function formatDateTime(ms: number, t: ControlT): string {
  const date = new Date(ms);
  return `${formatDate(ms, t)}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * `agora há pouco`, `há 12 min`, `há 3 h`, `ontem`, `há 3 dias`, then the date (`just now`, `12 min ago`, `3 h ago`,
 * `yesterday`, `3 days ago` in English). `null` is a device that never connected.
 */
export function formatRelative(ms: number | null, now: number, t: ControlT): string {
  if (ms === null) return t('format.relative.never');
  const diff = now - ms;
  if (diff < 45_000) return t('format.relative.justNow');
  if (diff < 3_600_000) return t('format.relative.minutes', { minutes: Math.max(1, Math.floor(diff / 60_000)) });
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return t('format.relative.hours', { hours: Math.floor(diff / 3_600_000) });
  if (days === 1) return t('format.relative.yesterday');
  if (days < 7) return t('format.relative.days', { days });
  return formatDate(ms, t);
}

/** Whole seconds until `expiresAt`, rounded up, never negative. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** `4:32`. */
export function formatCountdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

/** Share of the code's lifetime that is left (1 at the start, 0 when expired). */
export function remainingFraction(expiresAt: number, startedAt: number, now: number): number {
  const total = expiresAt - startedAt;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (expiresAt - now) / total));
}

/** `482 915`: the six digits in two blocks, easier to read aloud and to type. */
export function formatPairingCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
