import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PRECACHE_LIMITS,
  buildFiles,
  createDirReader,
  htmlLocalRefs,
  keepBuildEntries,
  localPath,
  precacheUrls,
  releaseProblems,
} from './release-check.js';

const INDEX = `<!doctype html>
<html><head>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="stylesheet" crossorigin href="/assets/index-abc.css">
<link rel="preconnect" href="https://fonts.gstatic.com">
<script type="module" crossorigin src="/assets/index-def.js"></script>
<script src="https://cdn.example.com/x.js"></script>
<script src="registerSW.js?v=2#top"></script>
</head><body></body></html>`;

const SW = `self.__WB_MANIFEST;Rc([{"revision":"aa","url":"index.html"},{"revision":null,"url":"assets/index-def.js"},{"url":"assets/index-abc.css","revision":"bb"}]);var x={url:"/api/ignored"};`;

const MANIFEST = JSON.stringify({ name: 'x', start_url: '/', icons: [{ src: 'icon-192.png' }, { src: '/icon-512.png' }] });

describe('localPath', () => {
  it('keeps relative paths and strips the leading slash, query and fragment', () => {
    expect(localPath('/assets/a.js')).toBe('assets/a.js');
    expect(localPath('registerSW.js?v=2#top')).toBe('registerSW.js');
  });

  it('ignores external URLs, data URIs, fragments and the root', () => {
    expect(localPath('https://fonts.gstatic.com/x.css')).toBeUndefined();
    expect(localPath('//cdn.example.com/x.js')).toBeUndefined();
    expect(localPath('data:text/plain,hi')).toBeUndefined();
    expect(localPath('#top')).toBeUndefined();
    expect(localPath('/')).toBeUndefined();
    expect(localPath('  ')).toBeUndefined();
  });
});

describe('htmlLocalRefs', () => {
  it('collects local script src and link href, and nothing external', () => {
    expect(htmlLocalRefs(INDEX)).toEqual([
      'manifest.webmanifest',
      'apple-touch-icon.png',
      'assets/index-abc.css',
      'assets/index-def.js',
      'registerSW.js',
    ]);
  });

  it('accepts single-quoted and unquoted attributes', () => {
    expect(htmlLocalRefs(`<script src='a.js'></script><link href=b.css rel=stylesheet>`)).toEqual(['a.js', 'b.css']);
  });
});

describe('precacheUrls', () => {
  it('reads the urls of the workbox precache list, in either key order', () => {
    expect(precacheUrls(SW)).toEqual(['index.html', 'assets/index-def.js', 'assets/index-abc.css']);
  });

  it('returns nothing when the file has no precache list', () => {
    expect(precacheUrls('console.log(1)')).toEqual([]);
  });
});

describe('releaseProblems', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanachi-check-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Creates the complete set of files that INDEX, SW and MANIFEST reference. */
  async function completeRelease(omit: readonly string[] = [], sw: string = SW): Promise<void> {
    const files: Record<string, string> = {
      'index.html': INDEX,
      'sw.js': sw,
      'manifest.webmanifest': MANIFEST,
      'registerSW.js': '',
      'apple-touch-icon.png': '',
      'icon-192.png': '',
      'icon-512.png': '',
      'assets/index-abc.css': '',
      'assets/index-def.js': '',
    };
    await mkdir(join(dir, 'assets'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      if (omit.includes(name)) continue;
      await writeFile(join(dir, name), content);
    }
  }

  it('a complete release has no problems', async () => {
    await completeRelease();

    expect(await releaseProblems(createDirReader(dir))).toEqual([]);
  });

  it('a release missing the CSS that index.html references lists it', async () => {
    await completeRelease(['assets/index-abc.css']);

    expect(await releaseProblems(createDirReader(dir))).toEqual(['assets/index-abc.css']);
  });

  it('a release without index.html is reported as such', async () => {
    await completeRelease(['index.html']);

    expect(await releaseProblems(createDirReader(dir))).toEqual(['index.html']);
  });

  it('a release without sw.js is reported', async () => {
    await completeRelease(['sw.js']);

    expect(await releaseProblems(createDirReader(dir))).toEqual(['sw.js']);
  });

  it('a precache entry missing on disk is reported', async () => {
    await completeRelease(['assets/index-def.js']);

    expect(await releaseProblems(createDirReader(dir))).toEqual(['assets/index-def.js']);
  });

  it('a manifest icon missing on disk is reported', async () => {
    await completeRelease(['icon-512.png']);

    expect(await releaseProblems(createDirReader(dir))).toEqual(['icon-512.png']);
  });

  it('an sw.js with no precache list is reported, not treated as complete', async () => {
    await completeRelease();
    await writeFile(join(dir, 'sw.js'), 'console.log(1)');

    expect(await releaseProblems(createDirReader(dir))).toEqual(['sw.js (sem manifesto de precache)']);
  });

  it('a manifest that is not valid JSON is reported', async () => {
    await completeRelease();
    await writeFile(join(dir, 'manifest.webmanifest'), '{ nope');

    expect(await releaseProblems(createDirReader(dir))).toEqual(['manifest.webmanifest (JSON inválido)']);
  });

  it('a chunk the build cites but the precache list omits is reported (CSS-less precache)', async () => {
    const withoutCss = SW.replace('{"url":"assets/index-abc.css","revision":"bb"}', '{"revision":"x","url":"index.html"}');
    await completeRelease([], withoutCss);

    expect(await releaseProblems(createDirReader(dir))).toEqual(['assets/index-abc.css (falta no precache)']);
  });

  it('a precache entry for a file the build does not use (stale chunk) is reported', async () => {
    await completeRelease();
    await writeFile(join(dir, 'assets', 'old.js'), 'nobody cites me');
    const stale = SW.replace('{"revision":null,"url":"assets/index-def.js"}', '{"revision":null,"url":"assets/old.js"}');
    await writeFile(join(dir, 'sw.js'), stale);

    expect(await releaseProblems(createDirReader(dir))).toEqual(
      expect.arrayContaining(['assets/old.js (precache de arquivo que o build não usa)']),
    );
  });

  it('a precache entry that is a source map is reported', async () => {
    await completeRelease();
    await writeFile(join(dir, 'assets', 'index-def.js.map'), '{}');
    const withMap = SW.replace('"url":"index.html"}', '"url":"index.html"},{"revision":null,"url":"assets/index-def.js.map"}');
    await writeFile(join(dir, 'sw.js'), withMap);

    expect(await releaseProblems(createDirReader(dir))).toEqual([
      'assets/index-def.js.map (precache de arquivo que o build não usa)',
    ]);
  });

  it('a precache over the entry cap is reported with the numbers', async () => {
    await completeRelease();

    const problems = await releaseProblems(createDirReader(dir), { maxEntries: 2, maxBytes: 1024 * 1024 });

    expect(problems).toEqual(['precache acima do limite: 3 entradas, 0.0 MB (limite 2 entradas, 1.0 MB)']);
  });

  it('a precache over the byte cap is reported', async () => {
    await completeRelease();
    await writeFile(join(dir, 'assets', 'index-def.js'), 'x'.repeat(2048));

    const problems = await releaseProblems(createDirReader(dir), { maxEntries: 100, maxBytes: 1024 });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/acima do limite/);
  });

  it('the default cap accepts the current build size (51 entries, about 2.7 MB)', () => {
    expect(PRECACHE_LIMITS.maxEntries).toBe(120);
    expect(PRECACHE_LIMITS.maxBytes).toBe(10 * 1024 * 1024);
  });
});

describe('buildFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanachi-build-files-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the root files and the chunks reachable from index.html, and nothing else', async () => {
    await writeFile(join(dir, 'index.html'), '<script src="/assets/index-live.js"></script>');
    await writeFile(join(dir, 'sw.js'), 'the precache lists everything');
    await writeFile(join(dir, 'icon-192.png'), '');
    await writeFile(join(dir, 'assets', 'index-live.js'), 'import("./dist-live.js")');
    await writeFile(join(dir, 'assets', 'dist-live.js'), '');
    await writeFile(join(dir, 'assets', 'index-old.js'), '');

    expect(await buildFiles(createDirReader(dir))).toEqual([
      'assets/dist-live.js',
      'assets/index-live.js',
      'icon-192.png',
      'index.html',
      'sw.js',
    ]);
  });

  it('drops stale chunks that cite each other in a cycle (the case the old rule kept forever)', async () => {
    await writeFile(join(dir, 'index.html'), '<script src="/assets/index-live.js"></script>');
    await writeFile(join(dir, 'assets', 'index-live.js'), '');
    await writeFile(join(dir, 'assets', 'bootstrap-old.js'), 'import "./EditorScreen-old.js"');
    await writeFile(join(dir, 'assets', 'EditorScreen-old.js'), 'import "./bootstrap-old.js"');

    expect(await buildFiles(createDirReader(dir))).toEqual(['assets/index-live.js', 'index.html']);
  });

  it('never includes source maps, even when a chunk cites them', async () => {
    await writeFile(join(dir, 'index.html'), '<script src="/assets/index-live.js"></script>');
    await writeFile(join(dir, 'assets', 'index-live.js'), '//# sourceMappingURL=index-live.js.map');
    await writeFile(join(dir, 'assets', 'index-live.js.map'), '{}');
    await writeFile(join(dir, 'index.html.map'), '{}');

    expect(await buildFiles(createDirReader(dir))).toEqual(['assets/index-live.js', 'index.html']);
  });

  it('a chunk that index.html references but is missing is not listed (the release check reports it)', async () => {
    await writeFile(join(dir, 'index.html'), '<script src="/assets/index-gone.js"></script>');

    expect(await buildFiles(createDirReader(dir))).toEqual(['index.html']);
  });
});

describe('keepBuildEntries', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanachi-keep-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<script src="/assets/index-live.js"></script>');
    await writeFile(join(dir, 'assets', 'index-live.js'), '');
    await writeFile(join(dir, 'assets', 'index-old.js'), '');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('drops the precache entries the build does not use and keeps the rest in order', async () => {
    const transform = keepBuildEntries(() => dir);
    const entries = [
      { url: 'index.html', revision: 'a', size: 1 },
      { url: 'assets/index-old.js', revision: null, size: 1 },
      { url: 'assets/index-live.js', revision: null, size: 1 },
      { url: 'assets/index-live.js.map', revision: null, size: 1 },
    ];

    const result = await transform(entries);

    expect(result.manifest.map((entry) => entry.url)).toEqual(['index.html', 'assets/index-live.js']);
    expect(result.manifest[0]).toBe(entries[0]);
  });
});
