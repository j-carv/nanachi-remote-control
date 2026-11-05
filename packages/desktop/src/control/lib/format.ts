/**
 * Portuguese (pt-BR) formatting for the control center. Pure functions: the clock is always an argument, and dates are
 * built from the local calendar so a test and a user in any timezone read the same text.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'] as const;
const DAY_MS = 86_400_000;

const numberFormats = new Map<number, Intl.NumberFormat>();
function numberFormat(maximumFractionDigits: number): Intl.NumberFormat {
  let format = numberFormats.get(maximumFractionDigits);
  if (!format) {
    format = new Intl.NumberFormat('pt-BR', { maximumFractionDigits });
    numberFormats.set(maximumFractionDigits, format);
  }
  return format;
}

function digitsFor(value: number, unit: number): number {
  if (unit === 0) return 0;
  if (value >= 100) return 0;
  if (value >= 10) return 1;
  return 2;
}

/** `238 GB`, `12,3 GB`, `1,82 TB`: binary units (as Explorer shows them), three significant digits, decimal comma. */
export function formatBytes(bytes: number | null): string {
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
  return `${numberFormat(digits).format(value)} ${BYTE_UNITS[unit]}`;
}

/** `1 sessão`, `2 sessões`. */
export function pluralize(count: number, one: string, other: string): string {
  return `${count} ${count === 1 ? one : other}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `5 nov 2026`. */
export function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** `5 nov 2026, 14:32` (24 h). */
export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  return `${formatDate(ms)}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** `agora há pouco`, `há 12 min`, `há 3 h`, `ontem`, `há 3 dias`, then the date. `null` is a device that never connected. */
export function formatRelative(ms: number | null, now: number): string {
  if (ms === null) return 'Nunca';
  const diff = now - ms;
  if (diff < 45_000) return 'agora há pouco';
  if (diff < 3_600_000) return `há ${Math.max(1, Math.floor(diff / 60_000))} min`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return `há ${Math.floor(diff / 3_600_000)} h`;
  if (days === 1) return 'ontem';
  if (days < 7) return `há ${days} dias`;
  return formatDate(ms);
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
