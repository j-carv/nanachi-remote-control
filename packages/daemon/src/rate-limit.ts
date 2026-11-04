export interface FailureLimiter {
  isBlocked(key: string, now: number): boolean;
  recordFailure(key: string, now: number): void;
}

/** Contador de falhas em memória por chave (ex.: IP), em janela deslizante. */
export function createFailureLimiter(options: { maxFailures: number; windowMs: number }): FailureLimiter {
  const failures = new Map<string, number[]>();

  function recent(key: string, now: number): number[] {
    const kept = (failures.get(key) ?? []).filter((at) => now - at < options.windowMs);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  }

  return {
    isBlocked(key, now) {
      return recent(key, now).length >= options.maxFailures;
    },
    recordFailure(key, now) {
      const kept = recent(key, now);
      kept.push(now);
      failures.set(key, kept);
    },
  };
}
