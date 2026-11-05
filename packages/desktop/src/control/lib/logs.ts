export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** True while the viewport shows the end of the log (within `threshold` px): the log keeps following new lines. */
export function isNearBottom(metrics: ScrollMetrics, threshold = 24): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export type LogLevel = 'error' | 'warn' | 'info';

/** Only clear markers get a tone; everything else is plain text. Word boundaries keep `terror` from being an error. */
export function classifyLogLine(line: string): LogLevel {
  if (/\b(error|erro|fatal|exception|uncaught|panic)\b/i.test(line)) return 'error';
  if (/\b(warn|warning|aviso)\b/i.test(line)) return 'warn';
  return 'info';
}

export function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => line === b[index]);
}
