/**
 * How long a press of "Desinstalar" holds the uninstall off. The uninstaller's own window takes a few seconds to appear, and
 * a second press before it does would open a second one. The control center holds its button for this long, and Desktop
 * refuses a request that comes inside it.
 */
export const UNINSTALL_GUARD_MS = 8_000;

/**
 * The time the guard set by a press at `startedAt` still holds at `now` (both on the same monotonic clock), or zero when it
 * is over or no press holds it (`null`). A clock that reads earlier than the press holds nothing, so it cannot lock the
 * uninstall for longer than the window.
 */
export function uninstallGuardRemaining(startedAt: number | null, now: number): number {
  if (startedAt === null) return 0;
  const elapsed = now - startedAt;
  if (elapsed < 0 || elapsed >= UNINSTALL_GUARD_MS) return 0;
  return UNINSTALL_GUARD_MS - elapsed;
}
