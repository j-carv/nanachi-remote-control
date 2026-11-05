import { PWA_LANGUAGE_KEY, type Language } from '../common/i18n/languages.js';
import type { SeedMachine } from '../common/types.js';

/** Same keys as `packages/pwa/src/machines.ts`. */
export const MACHINES_KEY = 'nanachi.machines';
export const SELECTED_KEY = 'nanachi.selectedMachine';

/** The part of `Storage` used here. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SeedOutcome = 'seeded' | 'updated' | 'unchanged' | 'skipped';

function hasId(entry: unknown, id: string): boolean {
  return typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === id;
}

function sameMachine(entry: unknown, machine: SeedMachine): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    record.id === machine.id &&
    record.name === machine.name &&
    record.baseUrl === machine.baseUrl &&
    record.token === machine.token
  );
}

/**
 * Makes sure the PWA's own storage knows the Desktop machine, in the exact `MachineSchema` format
 * (`{ id, name, baseUrl, token }`):
 * - missing: it is added (other machines the user added stay where they are);
 * - present with another token or name (Desktop paired again): it is replaced in place;
 * - the selected machine is set only when nothing valid is selected;
 * - a saved list that cannot be read is left alone, so the PWA can say so instead of losing what is there.
 * The write happens only when `origin` is the daemon's own origin, so the token never lands in another site's storage.
 */
export function seedMachines(storage: StorageLike, machine: SeedMachine | null, origin: string): SeedOutcome {
  if (machine === null) return 'skipped';
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(machine.baseUrl).origin;
  } catch {
    return 'skipped';
  }
  if (origin !== expectedOrigin) return 'skipped';

  try {
    const raw = storage.getItem(MACHINES_KEY);
    let list: unknown[];
    if (raw === null) {
      list = [];
    } else {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return 'skipped';
      list = parsed;
    }

    const index = list.findIndex((entry) => hasId(entry, machine.id));
    let outcome: SeedOutcome = 'unchanged';
    if (index === -1) {
      list = [...list, machine];
      outcome = 'seeded';
    } else if (!sameMachine(list[index], machine)) {
      list = list.map((entry, i) => (i === index ? machine : entry));
      outcome = 'updated';
    }
    if (outcome !== 'unchanged') storage.setItem(MACHINES_KEY, JSON.stringify(list));

    const selected = storage.getItem(SELECTED_KEY);
    const selectedIsKnown = selected !== null && list.some((entry) => hasId(entry, selected));
    if (!selectedIsKnown) storage.setItem(SELECTED_KEY, machine.id);
    return outcome;
  } catch {
    // Unreadable JSON or storage that refuses to answer: leave the page to cope, never throw in the preload.
    return 'skipped';
  }
}

/**
 * Gives the PWA Desktop's language: only the `nanachi.language` key, nothing else of its storage. Main hands a language to the
 * preload only when it has something to write (the first load, a change in Desktop), so this never undoes a choice made inside the PWA.
 */
export function seedLanguage(storage: StorageLike, language: Language | null): boolean {
  if (language === null) return false;
  try {
    storage.setItem(PWA_LANGUAGE_KEY, language);
    return true;
  } catch {
    // Storage that refuses to answer: the PWA starts in its own language, never an exception in the preload.
    return false;
  }
}
