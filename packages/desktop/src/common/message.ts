/**
 * The text of anything that was thrown or rejected. A `catch` binding is `unknown`: a promise can reject with a string, a
 * plain object or `undefined`, and `(error as Error).message` then reads `undefined` (or throws on `null`).
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  try {
    return String(error);
  } catch {
    return 'erro desconhecido';
  }
}
