import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/**
 * Checks that a folder of built PWA output is complete and that its precache list matches the build: every local
 * file that `index.html` (`src`, `href`), the precache list and the manifest icons reference exists; every chunk of
 * the build is precached; nothing unused is precached; and the precache stays within `PRECACHE_LIMITS`. Used on the
 * staging folder before publishing and on the copied release before the pointer moves. The daemon keeps its own copy
 * of the index.html rule in `packages/daemon/src/pwa-root.ts`; change both together.
 */

/** Reads files of one output folder by relative path. */
export interface ReleaseReader {
  /** UTF-8 content of `rel`, or undefined when it does not exist. */
  readText(rel: string): Promise<string | undefined>;
  /** True when `rel` exists as a file. */
  isFile(rel: string): Promise<boolean>;
  /** Size in bytes of the file `rel`. */
  size(rel: string): Promise<number>;
  /** Relative paths (with `/`) of every file in the folder, sorted. */
  listFiles(): Promise<string[]>;
}

/** Limits of the precache list. A build over either one is not published. */
export interface PrecacheLimits {
  maxEntries: number;
  maxBytes: number;
}

/**
 * Default precache limits. The current build precaches 51 entries and about 2.7 MiB (44 chunks, CSS, icons and
 * index.html). The limits leave room for growth of about 2x in entries and 3.7x in bytes. Before the fix the precache
 * held 864 entries and 84 MB, which these limits refuse.
 */
export const PRECACHE_LIMITS: PrecacheLimits = { maxEntries: 120, maxBytes: 10 * 1024 * 1024 };

const ASSETS_PREFIX = 'assets/';
/** Text files that can cite a chunk by name. */
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.webmanifest', '.json']);
/** Service worker files written by vite-plugin-pwa. The precache list is derived from the build, so they are not roots. */
const SW_FILES = new Set(['sw.js', 'sw.mjs']);

export function createDirReader(dir: string): ReleaseReader {
  return {
    async readText(rel) {
      try {
        return await readFile(join(dir, rel), 'utf8');
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async isFile(rel) {
      try {
        return (await stat(join(dir, rel))).isFile();
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async size(rel) {
      return (await stat(join(dir, rel))).size;
    },
    listFiles: () => listFilesUnder(dir),
  };
}

/** Relative paths (with `/`) of all files under `dir`, sorted. Throws when `dir` does not exist. */
export async function listFilesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  await walk(dir, '');
  return files.sort();
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Relative path of a local reference, or undefined for external URLs, fragments and the root. */
export function localPath(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (trimmed === '' || trimmed.startsWith('#') || EXTERNAL.test(trimmed)) return undefined;
  const bare = trimmed.split(/[?#]/, 1)[0] ?? '';
  const path = bare.replace(/^\/+/, '');
  return path === '' ? undefined : path;
}

const LINK_OR_SCRIPT_TAG = /<(?:script|link)\b[^>]*>/gi;
const SRC_OR_HREF = /(?<![\w-])(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/** Local `src` and `href` of the `<script>` and `<link>` tags of an HTML document. */
export function htmlLocalRefs(html: string): string[] {
  const refs: string[] = [];
  for (const [tag] of html.matchAll(LINK_OR_SCRIPT_TAG)) {
    const attr = SRC_OR_HREF.exec(tag);
    if (attr === null) continue;
    const path = localPath(attr[1] ?? attr[2] ?? attr[3] ?? '');
    if (path !== undefined) refs.push(path);
  }
  return refs;
}

/** Urls of the workbox precache list in a generated `sw.js` (`{"revision":..,"url":..}` in either key order). */
const PRECACHE_ENTRY = /\{"revision":(?:"[^"]*"|null),"url":"([^"]+)"\}|\{"url":"([^"]+)","revision":(?:"[^"]*"|null)\}/g;

export function precacheUrls(sw: string): string[] {
  const urls: string[] = [];
  for (const match of sw.matchAll(PRECACHE_ENTRY)) {
    const path = localPath(match[1] ?? match[2] ?? '');
    if (path !== undefined) urls.push(path);
  }
  return urls;
}

/** Icon `src` values of a web app manifest. Throws on invalid JSON. */
function manifestIconRefs(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || !('icons' in parsed) || !Array.isArray(parsed.icons)) return [];
  const refs: string[] = [];
  for (const icon of parsed.icons) {
    if (typeof icon === 'object' && icon !== null && 'src' in icon && typeof icon.src === 'string') {
      const path = localPath(icon.src);
      if (path !== undefined) refs.push(path);
    }
  }
  return refs;
}

function isChunk(rel: string): boolean {
  return rel.startsWith(ASSETS_PREFIX);
}

/**
 * Files that belong in a release of `reader`'s folder, sorted: every file outside `assets/` (source maps and the
 * service worker's precache source excluded from the roots), plus the chunks under `assets/` that the build cites.
 * Roots are the text files outside `assets/` (index.html, registerSW.js, the manifest). A chunk is cited when its
 * basename appears in the text of a file already reached, so reachability starts at the roots and follows citations.
 * A rule that drops only chunks nothing cites never drops a stale cycle (old builds cite each other), which is why
 * this one walks from the roots. Substring matching may keep a little too much, never too little.
 */
export async function buildFiles(reader: ReleaseReader): Promise<string[]> {
  const all = (await reader.listFiles()).filter((rel) => !rel.endsWith('.map'));
  const chunks = all.filter(isChunk);
  const kept = all.filter((rel) => !isChunk(rel));

  const rootTexts: string[] = [];
  for (const rel of kept) {
    if (SW_FILES.has(rel) || !TEXT_EXTENSIONS.has(extname(rel))) continue;
    rootTexts.push((await reader.readText(rel)) ?? '');
  }

  const cited = new Set<string>();
  const queue = chunks.filter((chunk) => rootTexts.some((text) => text.includes(basename(chunk))));
  for (let next = 0; next < queue.length; next += 1) {
    const rel = queue[next];
    if (rel === undefined || cited.has(rel)) continue;
    cited.add(rel);
    if (!TEXT_EXTENSIONS.has(extname(rel))) continue;
    const text = (await reader.readText(rel)) ?? '';
    for (const other of chunks) {
      if (!cited.has(other) && text.includes(basename(other))) queue.push(other);
    }
  }

  return [...kept, ...cited].sort();
}

/**
 * Files the release is missing or that do not match the build, as relative paths. Empty when the release is
 * complete. A missing `index.html` or `sw.js` is reported by name; an sw.js without a precache list is reported as
 * such so it cannot pass silently. The precache list must name every chunk of the build and nothing else, and must
 * stay within `limits`.
 */
export async function releaseProblems(reader: ReleaseReader, limits: PrecacheLimits = PRECACHE_LIMITS): Promise<string[]> {
  const problems = new Set<string>();
  // Without index.html there is no build to compare the precache with, so only the existence and the limits apply.
  const html = await reader.readText('index.html');
  const files = html === undefined ? undefined : await buildFiles(reader);
  if (html === undefined) {
    problems.add('index.html');
  } else {
    for (const ref of htmlLocalRefs(html)) {
      if (!(await reader.isFile(ref))) problems.add(ref);
    }
  }

  const sw = await reader.readText('sw.js');
  if (sw === undefined) {
    problems.add('sw.js');
  } else {
    const urls = precacheUrls(sw);
    if (urls.length === 0) problems.add('sw.js (sem manifesto de precache)');
    else for (const problem of await precacheProblems(reader, urls, files, limits)) problems.add(problem);
  }

  const manifest = await reader.readText('manifest.webmanifest');
  if (manifest !== undefined) {
    let icons: string[];
    try {
      icons = manifestIconRefs(manifest);
    } catch {
      problems.add('manifest.webmanifest (JSON inválido)');
      icons = [];
    }
    for (const icon of icons) {
      if (!(await reader.isFile(icon))) problems.add(icon);
    }
  }

  return [...problems];
}

/**
 * Checks of the precache list: existence, then (when `files`, the build's files, is known) that it names every chunk
 * of the build and nothing else, then the limits. `urls` is not empty.
 */
async function precacheProblems(
  reader: ReleaseReader,
  urls: readonly string[],
  files: readonly string[] | undefined,
  limits: PrecacheLimits,
): Promise<string[]> {
  const problems: string[] = [];
  const inBuild = new Set(files);
  const listed = new Set(urls);
  let bytes = 0;

  for (const url of urls) {
    if (!(await reader.isFile(url))) {
      problems.push(url);
      continue;
    }
    if (files !== undefined && !inBuild.has(url)) problems.push(`${url} (precache de arquivo que o build não usa)`);
    bytes += await reader.size(url);
  }
  for (const file of files ?? []) {
    if (isChunk(file) && !listed.has(file)) problems.push(`${file} (falta no precache)`);
  }
  if (urls.length > limits.maxEntries || bytes > limits.maxBytes) {
    problems.push(
      `precache acima do limite: ${urls.length} entradas, ${mebibytes(bytes)} MB (limite ${limits.maxEntries} entradas, ${mebibytes(limits.maxBytes)} MB)`,
    );
  }
  return problems;
}

function mebibytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * `injectManifest.manifestTransforms` entry: keeps only the precache entries that are files of the build in the
 * folder `dir()` returns (see `buildFiles`). vite-plugin-pwa globs the whole output folder, so without this the
 * precache lists every stale chunk the watch folder still holds. Entries keep their order and objects.
 */
export function keepBuildEntries(dir: () => string) {
  return async <T extends { url: string }>(entries: T[]): Promise<{ manifest: T[]; warnings: string[] }> => {
    const used = new Set(await buildFiles(createDirReader(dir())));
    return { manifest: entries.filter((entry) => used.has(entry.url)), warnings: [] };
  };
}
