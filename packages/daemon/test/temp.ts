import { rm } from 'node:fs/promises';

/**
 * Remove uma pasta temporária de teste. No Windows, um arquivo ainda aberto (banco SQLite) ou um processo
 * com o cwd dentro da pasta (agente) dá EBUSY/EPERM: tenta de novo antes de desistir, para não deixar lixo em %TEMP%.
 */
export function removeTempDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
