// Kept apart from forceUpdate.ts: the service worker imports this file, and forceUpdate.ts pulls in i18next and every
// translation, which the worker does not need (it would also grow the worker and break its WebWorker-only types).

/** Message the page posts to the service worker to refill the precache (see `sw.ts`). */
export const REFILL_PRECACHE_MESSAGE = 'refill-precache';

/** True when `data` is the message the page posts to ask for a precache refill. */
export function isRefillPrecacheRequest(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === REFILL_PRECACHE_MESSAGE;
}
