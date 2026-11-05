import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Nome de release aceito no ponteiro. É o formato que `packages/pwa/build/atomic-output.ts` gera
 * (`YYYYMMDDTHHMMSSmmmZ-<6 hex>`). Qualquer outra coisa é rejeitada, então o ponteiro nunca aponta para fora de `releases/`.
 */
const RELEASE_ID = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;

export interface PwaRootOptions {
  /** Pasta `packages/pwa/dist`: serve enquanto não há ponteiro (build sem watch, ou supervisor antigo). */
  fallbackDir: string;
  /** `packages/pwa/releases/current.json`, gravado a cada publicação do build em watch. */
  pointerFile: string;
  /** Aviso não fatal (ponteiro inválido, release incompleta). */
  warn?: (message: string) => void;
  /** Arquivos que a release não tem para o index.html funcionar. Vazio quando ela pode ser servida. */
  missingFiles?: (releaseDir: string) => string[];
}

export interface PwaRoot {
  /** Pasta a servir agora. Barata: só relê o ponteiro quando o arquivo muda. */
  current(): string;
}

interface Seen {
  /** Identidade do ponteiro (inode, tamanho, mtime) na última leitura. */
  key: string;
  root: string;
}

/**
 * Local `src` and `href` of the `<script>` and `<link>` tags of an HTML document. Mirrors the rule in
 * `packages/pwa/build/release-check.ts`; change both together.
 */
const LINK_OR_SCRIPT_TAG = /<(?:script|link)\b[^>]*>/gi;
const SRC_OR_HREF = /(?<![\w-])(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function localPath(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (trimmed === '' || trimmed.startsWith('#') || EXTERNAL.test(trimmed)) return undefined;
  const path = (trimmed.split(/[?#]/, 1)[0] ?? '').replace(/^\/+/, '');
  return path === '' ? undefined : path;
}

function htmlLocalRefs(html: string): string[] {
  const refs: string[] = [];
  for (const [tag] of html.matchAll(LINK_OR_SCRIPT_TAG)) {
    const attr = SRC_OR_HREF.exec(tag);
    if (attr === null) continue;
    const path = localPath(attr[1] ?? attr[2] ?? attr[3] ?? '');
    if (path !== undefined) refs.push(path);
  }
  return refs;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Local files that `index.html` of a release references and the release does not have, as paths relative to the
 * release. A missing or unreadable `index.html` is reported as `index.html`. Empty when the release can be served.
 */
export function missingReleaseFiles(releaseDir: string): string[] {
  let html: string;
  try {
    html = readFileSync(join(releaseDir, 'index.html'), 'utf8');
  } catch {
    return ['index.html'];
  }
  return [...new Set(htmlLocalRefs(html))].filter((ref) => !isFile(join(releaseDir, ref)));
}

function releaseOf(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('release' in parsed)) return undefined;
    const { release } = parsed;
    return typeof release === 'string' && RELEASE_ID.test(release) ? release : undefined;
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Raiz do PWA por requisição. Com ponteiro válido e release completa (todo arquivo que o index.html referencia
 * existe), serve a release. Sem ponteiro, serve `fallbackDir`. Ponteiro inválido ou release incompleta mantém a
 * última release boa (ou o fallback, se nunca houve uma) e avisa uma vez por mudança do ponteiro. Falha de leitura
 * transitória (o Windows bloqueia o arquivo por um instante durante o rename) também mantém a última boa, sem aviso.
 * O resultado da verificação de cada release fica em cache: releases são imutáveis depois de publicadas.
 */
export function createPwaRoot(options: PwaRootOptions): PwaRoot {
  const warn = options.warn ?? (() => undefined);
  const missingFiles = options.missingFiles ?? missingReleaseFiles;
  const checked = new Map<string, string[]>();
  let seen: Seen | undefined;
  let lastGood: string | undefined;

  const fallback = (): string => lastGood ?? options.fallbackDir;

  /** Missing files of a release, checked once per release folder that exists. */
  const missingOf = (dir: string): string[] => {
    const cached = checked.get(dir);
    if (cached !== undefined) return cached;
    const missing = missingFiles(dir);
    if (isDirectory(dir)) checked.set(dir, missing);
    return missing;
  };

  return {
    current() {
      let stat;
      try {
        stat = statSync(options.pointerFile);
      } catch (error) {
        if (!isNotFound(error)) return fallback();
        seen = undefined;
        lastGood = undefined;
        return options.fallbackDir;
      }

      const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (seen !== undefined && seen.key === key) return seen.root;

      let text: string;
      try {
        text = readFileSync(options.pointerFile, 'utf8');
      } catch {
        return fallback();
      }

      const release = releaseOf(text);
      if (release === undefined) {
        warn(`ponteiro do PWA inválido; continua em ${fallback()}`);
        seen = { key, root: fallback() };
        return seen.root;
      }

      const dir = join(dirname(options.pointerFile), release);
      const missing = missingOf(dir);
      if (missing.length === 0) {
        lastGood = dir;
        seen = { key, root: dir };
        return dir;
      }

      warn(`release ${release} incompleta, faltam: ${missing.join(', ')}; continua em ${fallback()}`);
      seen = { key, root: fallback() };
      return seen.root;
    },
  };
}
