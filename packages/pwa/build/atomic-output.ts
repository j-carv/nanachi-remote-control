import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, rename as fsRename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { buildFiles, createDirReader, listFilesUnder, releaseProblems } from './release-check.js';

/**
 * Pasta de releases do PWA (gitignored). Cada publicação do `vite build --watch` vira `releases/<id>/`, e
 * `releases/current.json` aponta para a atual. O daemon lê o ponteiro a cada requisição. Contrato com
 * `packages/daemon/src/pwa-root.ts`: se mudar nome ou formato, mude os dois.
 */
export const RELEASES_DIR = 'releases';
/** Arquivo do ponteiro: `{ "release": "<id>" }`, com `<id>` como nome de pasta dentro de `releases/`. */
export const POINTER_FILE = 'current.json';
/** Pasta onde o `vite build --watch` gera. Cada build sobrescreve esta pasta; ela nunca é servida. */
export const STAGING_DIR = `${RELEASES_DIR}/.building`;
/** Releases mantidas em disco: a atual e as anteriores mais recentes. */
export const KEEP_RELEASES = 3;

/** Nome de uma release: data UTC compacta (ordena por tempo) e sufixo hexadecimal. */
const RELEASE_ID = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;
/** Códigos do Windows para "arquivo em uso" (antivírus, Explorer, leitura em andamento). */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const DEFAULT_ATTEMPTS = 40;
const DEFAULT_RETRY_DELAY_MS = 50;

export type WarnFn = (message: string) => void;

/** Operações de disco usadas pela publicação. Testes trocam uma delas para simular EPERM. */
export interface ReleaseFs {
  /** Copia os arquivos `files` (relativos a `from`) para `to`, que não pode existir. Cria os pais. */
  copyFiles(from: string, to: string, files: readonly string[]): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  writeFile(file: string, content: string): Promise<void>;
  /** Remove recursivamente; ausente não é erro. */
  remove(path: string): Promise<void>;
  /** Nomes das subpastas de `dir`. */
  listDirs(dir: string): Promise<string[]>;
  /** Caminhos de todos os arquivos dentro de `dir` (em profundidade), relativos a `dir`, com `/`. */
  listFiles(dir: string): Promise<string[]>;
  /** Nomes, tamanhos e mtimes de todos os arquivos de `dir`. Muda se algo for gravado ali. */
  fingerprint(dir: string): Promise<string>;
}

export const nodeReleaseFs: ReleaseFs = {
  async copyFiles(from, to, files) {
    for (const rel of files) {
      await mkdir(dirname(join(to, rel)), { recursive: true });
      await copyFile(join(from, rel), join(to, rel), constants.COPYFILE_EXCL);
    }
  },
  rename: fsRename,
  writeFile: (file, content) => writeFile(file, content),
  remove: (path) => rm(path, { recursive: true, force: true }),
  async listDirs(dir) {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
  listFiles: (dir) => listFilesUnder(dir),
  async fingerprint(dir) {
    const lines: string[] = [];
    for (const rel of await listFilesUnder(dir)) {
      const info = await stat(join(dir, rel));
      lines.push(`${rel}:${info.size}:${info.mtimeMs}`);
    }
    return lines.join('\n');
  },
};

export interface PublishOptions {
  /** Pasta gerada pelo vite (`releases/.building`). Não é alterada. */
  staging: string;
  /** Pasta `releases/`. */
  releasesDir: string;
  /** Gera o id da release. Padrão: hora UTC atual com sufixo aleatório. */
  newId?: () => string;
  fs?: ReleaseFs;
  /** Tentativas de copiar e de trocar o ponteiro quando o arquivo está em uso. */
  attempts?: number;
  /** Pausa entre tentativas, em ms. */
  retryDelayMs?: number;
  /** Quantas releases manter. Padrão: `KEEP_RELEASES`. */
  keep?: number;
  /** Aviso não fatal (prune que não pôde apagar, por exemplo). */
  warn?: WarnFn;
}

/** Id de release: `YYYYMMDDTHHMMSSmmmZ-<sufixo>`. Ordenar pelo nome é ordenar pelo tempo. */
export function releaseIdFor(now: Date, suffix: string): string {
  return `${now.toISOString().replace(/[-:.]/g, '')}-${suffix}`;
}

function defaultReleaseId(): string {
  return releaseIdFor(new Date(), randomBytes(3).toString('hex'));
}

function codeOf(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first problems of a failed check, so a stale precache of hundreds of entries does not flood the log. */
function summarize(problems: readonly string[], shown = 10): string {
  const rest = problems.length - shown;
  return problems.slice(0, shown).join(', ') + (rest > 0 ? ` (e mais ${rest})` : '');
}

/**
 * Publica os arquivos do build em `staging` como uma release nova e aponta `current.json` para ela.
 * Ordem: confere o staging (`releaseProblems`), copia só os arquivos do build (`buildFiles`) para `releases/<id>/`
 * (pasta nova, nada aberto nela), confere a cópia, grava o ponteiro em arquivo temporário e troca por `current.json`
 * com rename (atômico no mesmo volume). Até a troca, o ponteiro antigo continua válido: se qualquer passo antes dela
 * falha, a release nova é apagada e o erro sobe. Depois da troca, o prune apaga as releases mais antigas que `keep`;
 * falha no prune só gera aviso e fica para a próxima publicação. Devolve o id publicado.
 */
export async function publishRelease(options: PublishOptions): Promise<string> {
  const fs = options.fs ?? nodeReleaseFs;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const keep = options.keep ?? KEEP_RELEASES;
  const warn: WarnFn = options.warn ?? ((message) => console.warn(message));
  const id = (options.newId ?? defaultReleaseId)();
  const releaseDir = join(options.releasesDir, id);

  // Staging must be complete and must not change while it is copied.
  const before = await fs.fingerprint(options.staging);
  const stagingReader = createDirReader(options.staging);
  const staged = await releaseProblems(stagingReader);
  if (staged.length > 0) throw new Error(`build incompleto ou fora dos limites: ${summarize(staged)}`);
  const files = await buildFiles(stagingReader);

  try {
    // Remove antes de cada tentativa: uma cópia pela metade não pode impedir a seguinte.
    await retrying(
      async () => {
        await fs.remove(releaseDir);
        await fs.copyFiles(options.staging, releaseDir, files);
      },
      attempts,
      delayMs,
    );
    if ((await fs.fingerprint(options.staging)) !== before) throw new Error('a pasta de build mudou durante a cópia');
    const copied = await releaseProblems(createDirReader(releaseDir));
    if (copied.length > 0) throw new Error(`cópia incompleta ou fora dos limites: ${summarize(copied)}`);
    await writePointer(fs, options.releasesDir, id, attempts, delayMs);
  } catch (error) {
    await fs.remove(releaseDir).catch(() => undefined);
    throw new Error(`publicação ${id} falhou: ${errorText(error)}`, { cause: error });
  }

  await pruneReleases(fs, options.releasesDir, { keepId: id, keep, warn });
  return id;
}

/**
 * Wraps `task` so it never runs twice at once. A call made during a run schedules exactly one more run after it,
 * so that run sees the latest state, and all calls made during the same run share it. Each call resolves when
 * the run that covers it has finished (or rejects, if that run failed).
 */
export function createCoalescedRunner(task: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | undefined;
  let again = false;

  async function drain(): Promise<void> {
    try {
      do {
        again = false;
        await task();
      } while (again);
    } finally {
      current = undefined;
    }
  }

  return () => {
    again = true;
    current ??= drain();
    return current;
  };
}

/**
 * Build options for `vite build --watch`: output goes to the staging folder and the folder is not emptied at
 * each build. A watch rebuild does not re-emit files it considers unchanged (CSS, for one), so emptying the
 * folder deletes files the next release needs. The folder therefore keeps stale chunks; the release and the precache
 * list only take the files of the build (`buildFiles`, `keepBuildEntries`).
 */
export function watchBuildOverrides(): { outDir: string; emptyOutDir: boolean } {
  return { outDir: STAGING_DIR, emptyOutDir: false };
}

let buildOutDir: string | undefined;

/**
 * Output folder of the build (`releases/.building` under watch, `dist` otherwise), known once Vite has resolved the
 * config. The precache transform reads it at service worker build time, which runs after the output is written.
 */
export function currentBuildDir(): string {
  if (buildOutDir === undefined) throw new Error('a pasta de saída do build ainda não foi resolvida');
  return buildOutDir;
}

/** Grava `{ "release": id }` em arquivo temporário e troca por `current.json`. */
async function writePointer(fs: ReleaseFs, releasesDir: string, id: string, attempts: number, delayMs: number): Promise<void> {
  const temp = join(releasesDir, `${POINTER_FILE}.${id}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify({ release: id })}\n`);
  try {
    await retrying(() => fs.rename(temp, join(releasesDir, POINTER_FILE)), attempts, delayMs);
  } catch (error) {
    await fs.remove(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Apaga releases além das `keep` mais recentes, sem nunca tocar em `keepId`. Só considera pastas com nome de
 * release; qualquer outra coisa em `releases/` fica como está. Falha de remoção (EPERM, EBUSY) não é erro:
 * vira um aviso e a pasta fica para a próxima publicação.
 */
async function pruneReleases(fs: ReleaseFs, releasesDir: string, options: { keepId: string; keep: number; warn: WarnFn }): Promise<void> {
  let names: string[];
  try {
    names = (await fs.listDirs(releasesDir)).filter((name) => RELEASE_ID.test(name)).sort();
  } catch (error) {
    options.warn(`não listou as releases antigas para apagar (${errorText(error)}); a próxima publicação tenta de novo`);
    return;
  }
  const doomed = names.slice(0, Math.max(0, names.length - options.keep)).filter((name) => name !== options.keepId);
  const stuck: string[] = [];
  for (const name of doomed) {
    try {
      await fs.remove(join(releasesDir, name));
    } catch {
      stuck.push(name);
    }
  }
  if (stuck.length > 0) {
    options.warn(`release antiga em uso, não apagada agora (${stuck.join(', ')}); a próxima publicação tenta de novo`);
  }
}

/**
 * Publicação do `vite build --watch`: nunca lança. Qualquer falha vira aviso e a release anterior continua no
 * ar. Derrubar o processo do watch faria o supervisor reiniciá-lo e perder o build em andamento.
 * Devolve true se o ponteiro foi trocado.
 */
export async function publishWatchRelease(options: PublishOptions): Promise<boolean> {
  const warn: WarnFn = options.warn ?? ((message) => console.warn(message));
  try {
    await publishRelease({ ...options, warn });
    return true;
  } catch (error) {
    warn(`PWA não publicado: ${errorText(error)}. A versão anterior continua no ar.`);
    return false;
  }
}

/** Quiet time after the last build output before a publication starts. Vite can write the output twice per cycle. */
export const PUBLISH_DEBOUNCE_MS = 1500;

/** Schedules `run` after `ms` and returns a function that cancels it. */
export type SetTimer = (run: () => void, ms: number) => () => void;

export interface WatchPublisherOptions {
  /** Starts a publication. Never throws (see `publishWatchRelease`). */
  publish: () => Promise<void>;
  debounceMs?: number | undefined;
  setTimer?: SetTimer | undefined;
}

export interface WatchPublisher {
  /** A build started: a publication scheduled by an earlier build output is dropped. */
  buildStart(): void;
  /** A build finished writing its output. A failed build schedules nothing, so the previous release stays. */
  buildEnd(error: unknown): void;
  /** Resolves when the last started publication has finished. */
  idle(): Promise<void>;
}

const realSetTimer: SetTimer = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * Turns the build outputs of `vite build --watch` into at most one publication per quiet period. Each build output
 * restarts the debounce. A new build start cancels the pending publication, because that output is about to be
 * replaced. The publication itself runs after the debounce, when the output has been stable for `debounceMs`.
 */
export function createWatchPublisher(options: WatchPublisherOptions): WatchPublisher {
  const debounceMs = options.debounceMs ?? PUBLISH_DEBOUNCE_MS;
  const setTimer = options.setTimer ?? realSetTimer;
  let cancelScheduled: (() => void) | undefined;
  let last: Promise<void> = Promise.resolve();

  const dropScheduled = (): void => {
    cancelScheduled?.();
    cancelScheduled = undefined;
  };

  return {
    buildStart() {
      dropScheduled();
    },
    buildEnd(error) {
      dropScheduled();
      if (error) return;
      cancelScheduled = setTimer(() => {
        cancelScheduled = undefined;
        last = options.publish();
      }, debounceMs);
    },
    idle: () => last,
  };
}

/**
 * Plugins do `vite build --watch`. Em watch, o build escreve em `releases/.building` (sem esvaziar a pasta). Os dois
 * plugins:
 * - `nanachi-atomic-watch-config`: ajusta a saída do watch e guarda a pasta de saída de cada build (`currentBuildDir`).
 * - `nanachi-atomic-watch-output`: no `closeBundle` (`order: 'post'`), publica a saída como release nova, uma
 *   publicação por vez (`createCoalescedRunner`).
 * Build com erro não mexe em nada. `npm run build` (sem watch) não publica: escreve em `dist`.
 */
export function atomicWatchOutput(): Plugin[] {
  let watching = false;
  let releasesDir = '';
  let staging = '';
  const publish = createCoalescedRunner(async () => {
    await publishWatchRelease({ staging, releasesDir });
  });
  const publisher = createWatchPublisher({ publish: () => publish() });

  const config: Plugin = {
    name: 'nanachi-atomic-watch-config',
    apply: 'build',
    config(userConfig) {
      if (userConfig.build?.watch) return { build: watchBuildOverrides() };
      return undefined;
    },
    configResolved(resolved) {
      watching = Boolean(resolved.build.watch);
      releasesDir = resolve(resolved.root, RELEASES_DIR);
      staging = resolve(resolved.root, STAGING_DIR);
      buildOutDir = resolve(resolved.root, resolved.build.outDir);
    },
  };

  // A plugin instance used in the vite-plugin-pwa service-worker sub-build would see its own config and change
  // `watching`. That sub-build gets no plugins (no `injectManifest.buildPlugins`), so this plugin never runs there.
  const output: Plugin = {
    name: 'nanachi-atomic-watch-output',
    apply: 'build',
    buildStart() {
      if (watching) publisher.buildStart();
    },
    closeBundle: {
      order: 'post',
      handler(error) {
        if (!watching) return;
        publisher.buildEnd(error);
      },
    },
  };

  return [config, output];
}
