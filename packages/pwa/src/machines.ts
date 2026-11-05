import { z } from 'zod';

export const MACHINES_KEY = 'nanachi.machines';
export const SELECTED_KEY = 'nanachi.selectedMachine';

/** Subconjunto de `Storage` usado aqui; facilita testar sem DOM. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Normaliza a URL base de uma máquina: só http(s), sem barra final, sem query/hash.
 * Retorna `null` se não for uma URL http(s) válida.
 */
export function normalizeBaseUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Pareamento manda a senha de uso (código) e devolve o token: só https, ou http para loopback
 * (localhost, 127.0.0.1) e para a própria origem da app (quando ela é servida pelo daemon na rede).
 */
export function isSafePairingBaseUrl(baseUrl: string, appOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.origin === appOrigin;
}

const MachineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z
    .string()
    .refine((value) => normalizeBaseUrl(value) !== null, 'baseUrl precisa ser http(s)'),
  token: z.string().min(1),
});

export type Machine = z.infer<typeof MachineSchema>;

/**
 * What the stored list says. `ok` with an empty list means nothing is saved (a new device). `unreadable` means
 * something is saved but it cannot be read, so the app must say so instead of acting as if nothing was paired.
 */
export type StoredMachines =
  | { readonly status: 'ok'; readonly machines: Machine[] }
  | { readonly status: 'unreadable' };

/**
 * Parses the stored list. Entries that do not match the schema, or repeat an id, are dropped and counted in a
 * console warning; the rest are kept. Invalid JSON or a value that is not a list is `unreadable`.
 */
export function parseStoredMachines(raw: string | null): StoredMachines {
  if (raw === null) return { status: 'ok', machines: [] };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: 'unreadable' };
  }
  if (!Array.isArray(json)) return { status: 'unreadable' };

  const seen = new Set<string>();
  const machines: Machine[] = [];
  let dropped = 0;
  for (const item of json) {
    const parsed = MachineSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) {
      dropped += 1;
      continue;
    }
    seen.add(parsed.data.id);
    machines.push(parsed.data);
  }
  if (dropped > 0) console.warn(`nanachi: ${dropped} acesso(s) salvo(s) inválido(s) descartado(s).`);
  return { status: 'ok', machines };
}

/** Lista de máquinas do JSON salvo; ilegível vira lista vazia (use parseStoredMachines para distinguir). */
export function parseMachines(raw: string | null): Machine[] {
  const stored = parseStoredMachines(raw);
  return stored.status === 'ok' ? stored.machines : [];
}

/** Adiciona a máquina, ou substitui a existente com o mesmo id (mantendo a posição). */
export function upsertMachine(machines: readonly Machine[], machine: Machine): Machine[] {
  const index = machines.findIndex((existing) => existing.id === machine.id);
  if (index === -1) return [...machines, machine];
  return machines.map((existing, i) => (i === index ? machine : existing));
}

export function removeMachine(machines: readonly Machine[], id: string): Machine[] {
  return machines.filter((machine) => machine.id !== id);
}

/** Máquina selecionada; sem seleção válida, cai na primeira da lista. */
export function resolveSelected(
  machines: readonly Machine[],
  selectedId: string | null,
): Machine | undefined {
  return machines.find((machine) => machine.id === selectedId) ?? machines[0];
}

/** Lê a lista salva. Storage que lança na leitura é `unreadable` (não é o mesmo que vazio). */
export function readStoredMachines(storage: StorageLike): StoredMachines {
  let raw: string | null;
  try {
    raw = storage.getItem(MACHINES_KEY);
  } catch {
    return { status: 'unreadable' };
  }
  return parseStoredMachines(raw);
}

export function readMachines(storage: StorageLike): Machine[] {
  const stored = readStoredMachines(storage);
  return stored.status === 'ok' ? stored.machines : [];
}

/** Retorna `false` se o storage recusou a escrita (modo privado, cota cheia). */
export function writeMachines(storage: StorageLike, machines: readonly Machine[]): boolean {
  try {
    storage.setItem(MACHINES_KEY, JSON.stringify(machines));
    return true;
  } catch {
    return false;
  }
}

export function readSelectedId(storage: StorageLike): string | null {
  try {
    return storage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

export function writeSelectedId(storage: StorageLike, id: string | null): void {
  try {
    if (id === null) {
      storage.removeItem(SELECTED_KEY);
    } else {
      storage.setItem(SELECTED_KEY, id);
    }
  } catch {
    // Seleção é conveniência: sem persistência, a app cai na primeira máquina.
  }
}
