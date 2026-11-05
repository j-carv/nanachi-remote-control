import { describe, expect, it } from 'vitest';
import type { StorageLike } from './machines.js';
import { PERSIST_REQUESTED_KEY, requestPersistentStorageOnce } from './persistStorage.js';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe('requestPersistentStorageOnce', () => {
  it('pede a persistência na primeira vez, loga o resultado e marca como feito', async () => {
    const storage = memoryStorage();
    const logs: string[] = [];
    let calls = 0;
    const result = await requestPersistentStorageOnce({
      storage,
      persist: async () => {
        calls += 1;
        return true;
      },
      log: (line) => logs.push(line),
    });
    expect(result).toBe(true);
    expect(calls).toBe(1);
    expect(logs).toEqual(['navigator.storage.persist(): concedido']);
    expect(storage.data.get(PERSIST_REQUESTED_KEY)).toBe('1');
  });

  it('nas próximas vezes não pede de novo', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const persist = async () => {
      calls += 1;
      return false;
    };
    await requestPersistentStorageOnce({ storage, persist, log: () => undefined });
    const again = await requestPersistentStorageOnce({ storage, persist, log: () => undefined });
    expect(again).toBeNull();
    expect(calls).toBe(1);
  });

  it('negado é registrado como negado', async () => {
    const logs: string[] = [];
    const result = await requestPersistentStorageOnce({
      storage: memoryStorage(),
      persist: async () => false,
      log: (line) => logs.push(line),
    });
    expect(result).toBe(false);
    expect(logs).toEqual(['navigator.storage.persist(): negado']);
  });

  it('sem navigator.storage.persist não faz nada e não marca (tenta de novo depois)', async () => {
    const storage = memoryStorage();
    const result = await requestPersistentStorageOnce({ storage, persist: undefined, log: () => undefined });
    expect(result).toBeNull();
    expect(storage.data.has(PERSIST_REQUESTED_KEY)).toBe(false);
  });

  it('persist que lança conta como negado e não quebra o pareamento', async () => {
    const logs: string[] = [];
    const result = await requestPersistentStorageOnce({
      storage: memoryStorage(),
      persist: async () => {
        throw new Error('boom');
      },
      log: (line) => logs.push(line),
    });
    expect(result).toBe(false);
    expect(logs).toEqual(['navigator.storage.persist(): negado']);
  });

  it('storage que lança ao ler o marcador ainda pede, sem lançar', async () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    await expect(
      requestPersistentStorageOnce({ storage: broken, persist: async () => true, log: () => undefined }),
    ).resolves.toBe(true);
  });
});
