import { analyzeLogLine, type LogLevel } from './log-tokens.js';

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** True while the viewport shows the end of the log (within `threshold` px): the log keeps following new lines. */
export function isNearBottom(metrics: ScrollMetrics, threshold = 24): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export type { LogLevel } from './log-tokens.js';

/**
 * The level of a line: the one it names (`"level":50`, `[warn]`, a level word at its start), or for a line that names none,
 * a clear marker such as `error` or `warning`. Word boundaries keep `terror` from being an error.
 */
export function classifyLogLine(line: string): LogLevel {
  return analyzeLogLine(line).level;
}

export function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => line === b[index]);
}
