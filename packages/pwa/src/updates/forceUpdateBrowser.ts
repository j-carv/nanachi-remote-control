import { cacheBustPath } from './cacheBust.js';
import {
  deleteAllCaches,
  REFILL_PRECACHE_MESSAGE,
  type ActiveWorkerLike,
  type ForceUpdateEnv,
} from './forceUpdate.js';

/** How long the service worker may take to answer a refill request. */
export const REFILL_TIMEOUT_MS = 15_000;

/**
 * Asks the active service worker to refill the precache in the empty caches. It answers `true` on the port when
 * done, and `false` when it could not download one of the files.
 */
export function requestPrecacheRefill(worker: ActiveWorkerLike): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('sem resposta do service worker'));
    }, REFILL_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      channel.port1.close();
      if (event.data === true) resolve();
      else reject(new Error('refill recusado'));
    };
    worker.postMessage({ type: REFILL_PRECACHE_MESSAGE }, [channel.port2]);
  });
}

/** Browser implementation of `ForceUpdateEnv`. Only this part touches navigator, caches and location. */
export function browserForceUpdateEnv(): ForceUpdateEnv {
  return {
    async getRegistration() {
      if (!('serviceWorker' in navigator)) return null;
      return (await navigator.serviceWorker.getRegistration()) ?? null;
    },
    async deleteAllCaches() {
      if (!('caches' in window)) return;
      await deleteAllCaches(caches);
    },
    refillPrecache: requestPrecacheRefill,
    reload() {
      location.replace(cacheBustPath(location.pathname, Date.now()));
    },
  };
}
