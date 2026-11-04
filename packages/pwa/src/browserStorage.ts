import type { StorageLike } from './machines.js';

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/**
 * localStorage quando o navegador deixa acessá-lo; senão memória da aba.
 * Em modo privado/bloqueado o acesso a `window.localStorage` pode lançar.
 */
export function getBrowserStorage(): StorageLike {
  try {
    return window.localStorage;
  } catch {
    return memoryStorage();
  }
}
