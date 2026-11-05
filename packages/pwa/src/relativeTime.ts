import { currentLanguage, t, type Language } from './i18n/index.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Older dates: numeric day/month/year in Portuguese and Spanish, an abbreviated month in English (the numeric order is
 * ambiguous).
 */
const DATE_FORMAT: Record<Language, Intl.DateTimeFormatOptions> = {
  'pt-BR': { day: '2-digit', month: '2-digit', year: 'numeric' },
  en: { day: 'numeric', month: 'short', year: 'numeric' },
  es: { day: '2-digit', month: '2-digit', year: 'numeric' },
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Relative time in the current language: "agora" / "now" / "ahora", "há 5 min" / "5 min ago" / "hace 5 min", "há 2 h" /
 * "2 h ago" / "hace 2 h", "ontem" / "yesterday" / "ayer", or the date (28/10/2026, Oct 28, 2026). Day is the local
 * calendar. A timestamp in the future (the PC's clock ahead) reads as "now".
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const diff = now - timestamp;
  if (diff < MINUTE_MS) return t('common:relativeTime.now');
  if (diff < HOUR_MS) return t('common:relativeTime.minutes', { minutes: Math.floor(diff / MINUTE_MS) });

  const then = new Date(timestamp);
  const today = new Date(now);
  if (sameDay(then, today)) return t('common:relativeTime.hours', { hours: Math.floor(diff / HOUR_MS) });

  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(then, yesterday)) return t('common:relativeTime.yesterday');

  const language = currentLanguage();
  return new Intl.DateTimeFormat(language, DATE_FORMAT[language]).format(then);
}
