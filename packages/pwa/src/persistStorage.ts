import type { StorageLike } from './machines.js';

/** Marker: the persistence request was already made on this device (set before the request, so it runs once). */
export const PERSIST_REQUESTED_KEY = 'nanachi.storagePersistRequested';

export interface PersistRequest {
  readonly storage: StorageLike;
  /** `navigator.storage.persist` when the browser has it; undefined otherwise. */
  readonly persist: (() => Promise<boolean>) | undefined;
  readonly log: (line: string) => void;
}

/**
 * Asks the browser to keep this origin's storage, where the pairing token lives, so it is not evicted under pressure.
 * Runs once per device, after the first successful pairing. Returns the answer, or null when no request was made.
 * A refusal or an error is only logged: the app works without persistence.
 */
export async function requestPersistentStorageOnce(request: PersistRequest): Promise<boolean | null> {
  const { storage, persist, log } = request;
  if (persist === undefined) return null;

  try {
    if (storage.getItem(PERSIST_REQUESTED_KEY) === '1') return null;
    storage.setItem(PERSIST_REQUESTED_KEY, '1');
  } catch {
    // Without a marker the request may repeat on a later pairing; that is harmless.
  }

  let granted = false;
  try {
    granted = await persist();
  } catch {
    granted = false;
  }
  log(`navigator.storage.persist(): ${granted ? 'concedido' : 'negado'}`);
  return granted;
}
