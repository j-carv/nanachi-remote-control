const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Tempo relativo em pt-BR: "agora", "há 5 min", "há 2 h", "ontem" ou a data (dd/mm/aaaa).
 * Dia é o calendário local. Timestamp no futuro (relógio do PC adiantado) vira "agora".
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const diff = now - timestamp;
  if (diff < MINUTE_MS) return 'agora';
  if (diff < HOUR_MS) return `há ${Math.floor(diff / MINUTE_MS)} min`;

  const then = new Date(timestamp);
  const today = new Date(now);
  if (sameDay(then, today)) return `há ${Math.floor(diff / HOUR_MS)} h`;

  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(then, yesterday)) return 'ontem';

  return `${pad2(then.getDate())}/${pad2(then.getMonth() + 1)}/${then.getFullYear()}`;
}
