import { access, rename as fsRename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Pasta que o daemon serve ao iPhone (saída normal do build). */
export const OUTPUT_DIR = 'dist';
/** Pasta onde o `vite build --watch` gera. Só vira `OUTPUT_DIR` depois de um build bem-sucedido. */
export const STAGING_DIR = 'dist-next';

export type RenameFn = (from: string, to: string) => Promise<void>;

export interface SwapOptions {
  /** Pasta servida (ex.: `.../dist`). */
  target: string;
  /** Pasta recém-gerada (ex.: `.../dist-next`). Some depois da troca. */
  staging: string;
  /** Tentativas de cada rename/remoção quando o arquivo está em uso. */
  attempts?: number;
  /** Pausa entre tentativas, em ms. */
  retryDelayMs?: number;
  /** Substitui `fs.rename` (testes simulam falhas com este gancho). */
  rename?: RenameFn;
  /** Aviso não fatal (ex.: `dist-old` que não pôde ser apagado). */
  warn?: (message: string) => void;
}

const DEFAULT_ATTEMPTS = 40;
const DEFAULT_RETRY_DELAY_MS = 50;
/** Códigos do Windows para "arquivo em uso" (antivírus, leitura em andamento). */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

function codeOf(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Repete `operation` enquanto o erro for de arquivo em uso; outro erro sobe na hora. */
async function retrying(operation: () => Promise<void>, attempts: number, delayMs: number): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = codeOf(error);
      if (code === undefined || !RETRYABLE_CODES.has(code) || attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

/**
 * Troca `target` pelo conteúdo de `staging` com renames no mesmo volume:
 * `target` → `target-old`, `staging` → `target`, apaga `target-old`.
 * Se o segundo rename falhar, devolve `target-old` para `target` (o servidor nunca fica sem a pasta
 * por mais que o intervalo entre os dois renames). Sobras de uma troca interrompida são tratadas
 * antes: `target-old` sem `target` é restaurado; `target-old` com `target` é apagado.
 */
export async function swapDirectory(options: SwapOptions): Promise<void> {
  const { target, staging } = options;
  const backup = `${target}-old`;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const rename = options.rename ?? fsRename;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const move = (from: string, to: string) => retrying(() => rename(from, to), attempts, delayMs);

  if (!(await exists(staging))) throw new Error(`pasta gerada ausente, a troca foi cancelada: ${staging}`);

  if (!(await exists(target)) && (await exists(backup))) {
    await move(backup, target);
  } else if (await exists(backup)) {
    await retrying(() => rm(backup, { recursive: true, force: true }), attempts, delayMs);
  }

  const hadTarget = await exists(target);
  if (hadTarget) await move(target, backup);
  try {
    await move(staging, target);
  } catch (error) {
    if (hadTarget) {
      try {
        await move(backup, target);
      } catch (restoreError) {
        throw new Error(`troca falhou e a pasta antiga não voltou: ela está em ${backup}`, {
          cause: restoreError,
        });
      }
    }
    throw error;
  }

  if (hadTarget) {
    try {
      await retrying(() => rm(backup, { recursive: true, force: true }), attempts, delayMs);
    } catch {
      warn(`dist antigo não pôde ser apagado (arquivo em uso); a próxima troca tenta de novo: ${backup}`);
    }
  }
}

/**
 * Plugin do `vite build --watch`: o build escreve em `dist-next`, e um `closeBundle` com `order: 'post'`
 * (depois do vite-plugin-pwa, que gera o sw e o precache dentro de `dist-next`) troca para `dist`.
 * Build com erro não passa pelo swap, então `dist` continua com o último build bom.
 * `npm run build` (sem watch) não muda nada: escreve em `dist` direto.
 */
export function atomicWatchOutput(): Plugin {
  let watching = false;
  let root = '';

  return {
    name: 'nanachi-atomic-watch-output',
    apply: 'build',
    config(config) {
      if (config.build?.watch) return { build: { outDir: STAGING_DIR } };
      return undefined;
    },
    configResolved(config) {
      watching = Boolean(config.build.watch);
      root = config.root;
    },
    closeBundle: {
      order: 'post',
      async handler(error) {
        if (error || !watching) return;
        await swapDirectory({
          target: resolve(root, OUTPUT_DIR),
          staging: resolve(root, STAGING_DIR),
        });
      },
    },
  };
}
