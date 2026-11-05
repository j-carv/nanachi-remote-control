import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  containsPath,
  createRootsStore,
  describeRoots,
  MAX_ROOT_LENGTH,
  MAX_ROOTS,
  nodeRootsFs,
  normalizeRoot,
  prepareRoots,
  readAllowedRoots,
  RootsConfigError,
  writeAllowedRoots,
  type PathProbe,
  type RootsConfigFs,
} from '../src/main/roots-config.js';
import { removeDir } from './remove-dir.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-desktop-roots-'));
  file = join(dir, 'config.json');
});
afterEach(() => {
  removeDir(dir);
});

describe('normalizeRoot', () => {
  it.each([
    ['C:\\Projetos', 'C:\\Projetos'],
    ['C:\\Projetos\\', 'C:\\Projetos'],
    ['c:/projetos/app/', 'C:\\projetos\\app'],
    ['C:\\Projetos\\app\\..\\lib', 'C:\\Projetos\\lib'],
    ['C:\\Projetos\\.\\app', 'C:\\Projetos\\app'],
    ['  C:\\Projetos  ', 'C:\\Projetos'],
    ['C:\\Users\\José\\Área de Trabalho', 'C:\\Users\\José\\Área de Trabalho'],
  ])('keeps a folder path without a trailing backslash: %s', (input, expected) => {
    expect(normalizeRoot(input)).toBe(expected);
  });

  it.each([
    ['D:\\', 'D:\\'],
    ['D:/', 'D:\\'],
    ['d:\\', 'D:\\'],
    ['D:\\Projetos\\..', 'D:\\'],
  ])('keeps the trailing backslash only on a drive root: %s', (input, expected) => {
    expect(normalizeRoot(input)).toBe(expected);
  });

  it('accepts a network share and keeps the root backslash on the share itself', () => {
    expect(normalizeRoot('\\\\servidor\\compartilhada')).toBe('\\\\servidor\\compartilhada\\');
    expect(normalizeRoot('\\\\servidor\\compartilhada\\pasta\\')).toBe('\\\\servidor\\compartilhada\\pasta');
    expect(normalizeRoot('//servidor/compartilhada/pasta')).toBe('\\\\servidor\\compartilhada\\pasta');
  });

  it('strips the extended-length prefix', () => {
    expect(normalizeRoot('\\\\?\\C:\\Projetos')).toBe('C:\\Projetos');
    expect(normalizeRoot('\\\\?\\D:\\')).toBe('D:\\');
    expect(normalizeRoot('\\\\?\\UNC\\servidor\\compartilhada\\x')).toBe('\\\\servidor\\compartilhada\\x');
  });

  it.each([
    [''],
    ['   '],
    ['Projetos'],
    ['..\\Projetos'],
    ['.\\Projetos'],
    ['C:'],
    ['C:Projetos'],
    ['\\Projetos'],
    ['/Projetos'],
    ['\\\\servidor'],
    ['\\\\servidor\\'],
    ['\\\\.\\C:\\Projetos'],
    ['\\\\?\\GLOBALROOT\\Device\\x'],
    ['http://exemplo.com/x'],
    ['C:\\Projetos\\a|b'],
    ['C:\\Projetos\\a*b'],
    ['C:\\Projetos\\a?b'],
    ['C:\\Projetos\\a"b'],
    ['C:\\Proj\u0000etos'],
    ['C:\\Proj\netos'],
    ['1:\\Projetos'],
  ])('refuses %j (not an absolute Windows path)', (input) => {
    expect(normalizeRoot(input)).toBeNull();
  });
});

describe('containsPath', () => {
  it('is true for the same path and for descendants, ignoring case', () => {
    expect(containsPath('C:\\Projetos', 'c:\\projetos')).toBe(true);
    expect(containsPath('C:\\Projetos', 'C:\\Projetos\\app\\src')).toBe(true);
    expect(containsPath('D:\\', 'D:\\Qualquer\\Coisa')).toBe(true);
    expect(containsPath('D:\\', 'D:\\')).toBe(true);
  });

  it('is false for siblings that share a prefix and for other drives', () => {
    expect(containsPath('C:\\Projetos', 'C:\\Projetos-antigos')).toBe(false);
    expect(containsPath('C:\\Projetos\\app', 'C:\\Projetos')).toBe(false);
    expect(containsPath('C:\\', 'D:\\Projetos')).toBe(false);
  });
});

/** A probe backed by a fixed map: a folder, a file, a share that does not answer, or missing. */
function probeOf(entries: Record<string, 'dir' | 'file' | 'timeout'>): PathProbe {
  const lower = new Map(Object.entries(entries).map(([path, kind]) => [path.toLowerCase(), kind]));
  return (path) => Promise.resolve(lower.get(path.toLowerCase()) ?? 'missing');
}

describe('prepareRoots', () => {
  const probe = probeOf({ 'C:\\Projetos': 'dir', 'C:\\Projetos\\app': 'dir', 'D:\\': 'dir', 'C:\\arquivo.txt': 'file', '\\\\servidor\\x\\': 'timeout' });

  it('normalizes, dedupes case-insensitively and keeps the insertion order', async () => {
    const result = await prepareRoots(['D:\\', 'C:\\Projetos\\', 'c:/projetos', 'C:\\Projetos\\app\\', 'd:\\'], [], probe);
    expect(result).toEqual(['D:\\', 'C:\\Projetos', 'C:\\Projetos\\app']);
  });

  it('accepts an empty list', async () => {
    expect(await prepareRoots([], ['C:\\Antiga'], probe)).toEqual([]);
  });

  it('refuses a relative path, saying which one', async () => {
    await expect(prepareRoots(['C:\\Projetos', 'projetos\\app'], [], probe)).rejects.toBeInstanceOf(RootsConfigError);
    const error = await prepareRoots(['projetos\\app'], [], probe).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RootsConfigError);
    expect((error as RootsConfigError).code).toBe('invalid_input');
    expect((error as RootsConfigError).message).toContain('projetos\\app');
    expect((error as RootsConfigError).message).toContain('absoluto');
  });

  it('refuses a new path that does not exist and one that is a file', async () => {
    await expect(prepareRoots(['C:\\NaoExiste'], [], probe)).rejects.toThrow(/não existe/);
    await expect(prepareRoots(['C:\\arquivo.txt'], [], probe)).rejects.toThrow(/não é uma pasta/);
  });

  it('keeps an entry that was already saved and went missing, but not a new one', async () => {
    expect(await prepareRoots(['C:\\Sumiu', 'C:\\Projetos'], ['c:\\sumiu\\'], probe)).toEqual(['C:\\Sumiu', 'C:\\Projetos']);
    await expect(prepareRoots(['C:\\Sumiu'], ['C:\\Outra'], probe)).rejects.toThrow(/não existe/);
  });

  it('does not keep a saved entry that is now a file', async () => {
    await expect(prepareRoots(['C:\\arquivo.txt'], ['C:\\arquivo.txt'], probe)).rejects.toThrow(/não é uma pasta/);
  });

  it('a share that does not answer in time is refused when new, and kept when it was already saved', async () => {
    await expect(prepareRoots(['\\\\servidor\\x'], [], probe)).rejects.toThrow(/não respondeu/);
    expect(await prepareRoots(['\\\\servidor\\x'], ['\\\\servidor\\x\\'], probe)).toEqual(['\\\\servidor\\x\\']);
  });

  it('looks at every folder at the same time, so one that hangs does not hold up the others one after another', async () => {
    let running = 0;
    let peak = 0;
    const slow: PathProbe = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return 'dir';
    };
    await prepareRoots(['C:\\a', 'C:\\b', 'C:\\c', 'C:\\d'], [], slow);
    expect(peak).toBe(4);
  });

  it('reports every bad entry at once', async () => {
    const error = await prepareRoots(['rel', 'C:\\NaoExiste'], [], probe).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('rel');
    expect((error as Error).message).toContain('C:\\NaoExiste');
  });

  it('refuses anything that is not a list of strings, and absurd sizes', async () => {
    await expect(prepareRoots('C:\\Projetos' as never, [], probe)).rejects.toThrow(RootsConfigError);
    await expect(prepareRoots([1] as never, [], probe)).rejects.toThrow(RootsConfigError);
    await expect(prepareRoots([null] as never, [], probe)).rejects.toThrow(RootsConfigError);
    await expect(prepareRoots([`C:\\${'a'.repeat(MAX_ROOT_LENGTH)}`], [], probe)).rejects.toThrow(/longo/);
    const many = Array.from({ length: MAX_ROOTS + 1 }, (_, index) => `C:\\p${index}`);
    await expect(prepareRoots(many, [], () => Promise.resolve('dir'))).rejects.toThrow(/muitas/i);
  });
});

describe('describeRoots', () => {
  const probe = probeOf({ 'C:\\Projetos': 'dir', 'C:\\Projetos\\app': 'dir', 'D:\\': 'dir', 'D:\\Dados': 'dir' });

  it('flags missing folders and the entry that already covers another one', async () => {
    const entries = await describeRoots(['C:\\Projetos\\app', 'C:\\Projetos', 'C:\\Sumiu', 'D:\\', 'D:\\Dados'], probe);
    expect(entries).toEqual([
      { path: 'C:\\Projetos\\app', exists: true, coveredBy: 'C:\\Projetos' },
      { path: 'C:\\Projetos', exists: true, coveredBy: null },
      { path: 'C:\\Sumiu', exists: false, coveredBy: null },
      { path: 'D:\\', exists: true, coveredBy: null },
      { path: 'D:\\Dados', exists: true, coveredBy: 'D:\\' },
    ]);
  });

  it('names the outermost entry when several cover the same folder', async () => {
    const entries = await describeRoots(['C:\\Projetos\\app', 'C:\\Projetos', 'C:\\'], probeOf({}));
    expect(entries.map((entry) => entry.coveredBy)).toEqual(['C:\\', 'C:\\', null]);
  });

  it('does not wait for a share that does not answer: it is shown as not there', async () => {
    const entries = await describeRoots(['C:\\Projetos', '\\\\servidor\\x\\'], probeOf({ 'C:\\Projetos': 'dir', '\\\\servidor\\x\\': 'timeout' }));
    expect(entries.map((entry) => entry.exists)).toEqual([true, false]);
  });
});

describe('the probe that looks at the disk', () => {
  it('never blocks: a stat that never comes back is answered as a timeout, the others still answer', async () => {
    const hung = new Promise<{ isDirectory(): boolean }>(() => undefined);
    const fs: RootsConfigFs = {
      ...nodeRootsFs,
      stat: (path) => {
        if (path.includes('offline')) return hung;
        if (path.includes('arquivo')) return Promise.resolve({ isDirectory: () => false });
        if (path.includes('sumiu')) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return Promise.resolve({ isDirectory: () => true });
      },
    };
    const store = createRootsStore({ home: dir, ensureConfig: () => undefined, fs, probeTimeoutMs: 20 });
    const started = Date.now();
    expect(await Promise.all(['C:\\offline', 'C:\\pasta', 'C:\\arquivo', 'C:\\sumiu'].map((path) => store.probe(path)))).toEqual(['timeout', 'dir', 'file', 'missing']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('works on the real disk, and is a promise (nothing in it is synchronous)', async () => {
    const store = createRootsStore({ home: dir, ensureConfig: () => undefined });
    const result = store.probe(dir);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe('dir');
    expect(await store.probe(join(dir, 'nada'))).toBe('missing');
    writeFileSync(file, '{}', 'utf8');
    expect(await store.probe(file)).toBe('file');
  });
});

describe('readAllowedRoots', () => {
  it('reads allowedRoots, tolerating a UTF-8 BOM (PowerShell 5.1 writes one)', () => {
    writeFileSync(file, `\uFEFF${JSON.stringify({ port: 7780, allowedRoots: ['C:\\A', 'D:\\'] })}`, 'utf8');
    expect(readAllowedRoots(file)).toEqual(['C:\\A', 'D:\\']);
  });

  it('gives an empty list when the key is missing or is not a list, and ignores non-string entries', () => {
    writeFileSync(file, '{"port":7780}', 'utf8');
    expect(readAllowedRoots(file)).toEqual([]);
    writeFileSync(file, '{"allowedRoots":"C:\\\\A"}', 'utf8');
    expect(readAllowedRoots(file)).toEqual([]);
    writeFileSync(file, '{"allowedRoots":["C:\\\\A",1,null,{"x":1}]}', 'utf8');
    expect(readAllowedRoots(file)).toEqual(['C:\\A']);
  });

  it('fails with an io error for a missing, invalid or non-object file, never an empty list', () => {
    expect(() => readAllowedRoots(join(dir, 'nada.json'))).toThrowError(RootsConfigError);
    writeFileSync(file, '{ not json', 'utf8');
    expect(() => readAllowedRoots(file)).toThrow(/config\.json/);
    writeFileSync(file, '[1,2]', 'utf8');
    expect(() => readAllowedRoots(file)).toThrow(RootsConfigError);
    try {
      readAllowedRoots(join(dir, 'nada.json'));
    } catch (error) {
      expect((error as RootsConfigError).code).toBe('io');
    }
  });
});

describe('writeAllowedRoots', () => {
  /** No waiting in the tests: the delays are recorded. */
  const noSleep = (delays: number[] = []) => ({ sleep: (ms: number) => Promise.resolve(void delays.push(ms)) });

  it('replaces only allowedRoots: every other key and the key order stay', async () => {
    const original = {
      machineName: 'PC',
      port: 7780,
      allowedRoots: ['C:\\Velha'],
      allowedTailscaleLogins: ['eu@exemplo.com'],
      agents: { omp: { label: 'Oh My Pi', kind: 'acp', command: 'omp', args: ['acp'] } },
      reloadQuietMs: 1000,
    };
    writeFileSync(file, JSON.stringify(original), 'utf8');

    await writeAllowedRoots(file, ['D:\\', 'C:\\Projetos']);

    const text = readFileSync(file, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['machineName', 'port', 'allowedRoots', 'allowedTailscaleLogins', 'agents', 'reloadQuietMs']);
    expect(parsed).toEqual({ ...original, allowedRoots: ['D:\\', 'C:\\Projetos'] });
    expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it('appends allowedRoots at the end when the key did not exist', async () => {
    writeFileSync(file, '{"port":7780,"machineName":"PC"}', 'utf8');
    await writeAllowedRoots(file, ['C:\\A']);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object)).toEqual(['port', 'machineName', 'allowedRoots']);
  });

  it('writes UTF-8 without a BOM, even when the old file had one', async () => {
    writeFileSync(file, `\uFEFF{"port":7780}`, 'utf8');
    await writeAllowedRoots(file, ['C:\\José']);
    const bytes = readFileSync(file);
    expect(bytes[0]).toBe(0x7b);
    expect(bytes.toString('utf8')).toContain('C:\\\\José');
    expect(bytes.at(-1)).toBe(0x0a);
  });

  it('is atomic: a failing rename leaves the old file untouched and no temp file behind', async () => {
    const before = '{"port":7780,"allowedRoots":["C:\\\\Velha"]}\n';
    writeFileSync(file, before, 'utf8');
    const failing: RootsConfigFs = {
      ...nodeRootsFs,
      rename: () => Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })),
    };
    await expect(writeAllowedRoots(file, ['C:\\Nova'], failing, noSleep())).rejects.toBeInstanceOf(RootsConfigError);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('writes through a temp file in the same folder, then renames', async () => {
    writeFileSync(file, '{"port":7780}', 'utf8');
    const calls: string[] = [];
    const spy: RootsConfigFs = {
      ...nodeRootsFs,
      writeFileSync: ((path: string, data: string, options: unknown) => {
        calls.push(`write:${path === file ? 'config' : 'temp'}`);
        nodeFs.writeFileSync(path, data, options as BufferEncoding);
      }) as RootsConfigFs['writeFileSync'],
      rename: async (from, to) => {
        calls.push(`rename:${from === file ? 'config' : 'temp'}->${to === file ? 'config' : 'other'}`);
        await nodeFs.promises.rename(from, to);
      },
    };
    await writeAllowedRoots(file, ['C:\\A'], spy);
    expect(calls).toEqual(['write:temp', 'rename:temp->config']);
  });

  describe('when Windows holds the file for a moment (antivirus, indexer, OneDrive)', () => {
    const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code });

    it.each(['EPERM', 'EBUSY', 'EACCES'])('tries the rename again after %s and succeeds once it lets go', async (code) => {
      writeFileSync(file, '{"port":7780}', 'utf8');
      let failures = 2;
      const delays: number[] = [];
      const flaky: RootsConfigFs = {
        ...nodeRootsFs,
        rename: async (from, to) => {
          if (failures > 0) {
            failures -= 1;
            throw busy(code);
          }
          await nodeFs.promises.rename(from, to);
        },
      };
      await writeAllowedRoots(file, ['C:\\A'], flaky, noSleep(delays));
      expect((JSON.parse(readFileSync(file, 'utf8')) as { allowedRoots: string[] }).allowedRoots).toEqual(['C:\\A']);
      expect(delays).toHaveLength(2);
      expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
      expect(readdirSync(dir)).toEqual(['config.json']);
    });

    it('gives up after a few tries with the old file intact, no temp file left, and says so', async () => {
      const before = '{"port":7780}';
      writeFileSync(file, before, 'utf8');
      let attempts = 0;
      const stuck: RootsConfigFs = {
        ...nodeRootsFs,
        rename: () => {
          attempts += 1;
          return Promise.reject(busy('EBUSY'));
        },
      };
      await expect(writeAllowedRoots(file, ['C:\\A'], stuck, noSleep())).rejects.toThrow(/gravar o config\.json/);
      expect(attempts).toBeGreaterThan(1);
      expect(attempts).toBeLessThanOrEqual(6);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readdirSync(dir)).toEqual(['config.json']);
    });

    it('does not retry an error that waiting cannot fix', async () => {
      writeFileSync(file, '{"port":7780}', 'utf8');
      let attempts = 0;
      const broken: RootsConfigFs = {
        ...nodeRootsFs,
        rename: () => {
          attempts += 1;
          return Promise.reject(busy('ENOSPC'));
        },
      };
      await expect(writeAllowedRoots(file, ['C:\\A'], broken, noSleep())).rejects.toBeInstanceOf(RootsConfigError);
      expect(attempts).toBe(1);
    });
  });

  it('refuses to create a config.json that does not exist: it would lose the port and fall back to 7777', async () => {
    await expect(writeAllowedRoots(join(dir, 'nada.json'), ['C:\\A'])).rejects.toBeInstanceOf(RootsConfigError);
    expect(existsSync(join(dir, 'nada.json'))).toBe(false);
  });

  it('refuses to overwrite a file it cannot parse', async () => {
    writeFileSync(file, '{ comentario do usuario', 'utf8');
    await expect(writeAllowedRoots(file, ['C:\\A'])).rejects.toThrow(/config\.json/);
    expect(readFileSync(file, 'utf8')).toBe('{ comentario do usuario');
  });
});

describe('createRootsStore', () => {
  it('creates the config first when it is missing (port 7780 survives)', async () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    const calls: string[] = [];
    const store = createRootsStore({
      home,
      ensureConfig: (target) => {
        calls.push(`ensure:${target === home}`);
        writeFileSync(join(target, 'config.json'), '{"port":7780}\n', 'utf8');
      },
      probe: probeOf({ 'C:\\A': 'dir' }),
    });
    expect(store.read()).toEqual([]);
    expect(await store.save(['C:\\A\\'])).toEqual(['C:\\A']);
    expect(calls).toEqual(['ensure:true', 'ensure:true']);
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(config).toEqual({ port: 7780, allowedRoots: ['C:\\A'] });
  });

  it('validates against the roots saved before the write', async () => {
    writeFileSync(file, JSON.stringify({ port: 7780, allowedRoots: ['C:\\Sumiu'] }), 'utf8');
    const store = createRootsStore({ home: dir, ensureConfig: () => undefined, probe: probeOf({ 'C:\\Nova': 'dir' }) });
    expect(await store.save(['C:\\Sumiu', 'C:\\Nova'])).toEqual(['C:\\Sumiu', 'C:\\Nova']);
    await expect(store.save(['C:\\Outra'])).rejects.toThrow(/não existe/);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { allowedRoots: string[] }).allowedRoots).toEqual(['C:\\Sumiu', 'C:\\Nova']);
  });

  it('describe() uses the same probe', async () => {
    const store = createRootsStore({ home: dir, ensureConfig: () => undefined, probe: probeOf({ 'C:\\A': 'dir' }) });
    expect(await store.describe(['C:\\A', 'C:\\B'])).toEqual([
      { path: 'C:\\A', exists: true, coveredBy: null },
      { path: 'C:\\B', exists: false, coveredBy: null },
    ]);
  });

  it('read() returns the saved list as written, normalized for display', () => {
    writeFileSync(file, JSON.stringify({ allowedRoots: ['c:/projetos/', 'D:\\', 'relativo'] }), 'utf8');
    const store = createRootsStore({ home: dir, ensureConfig: () => undefined, probe: probeOf({}) });
    // A hand-written entry that is not an absolute path is shown as it is, so the user can see and remove it.
    expect(store.read()).toEqual(['C:\\projetos', 'D:\\', 'relativo']);
  });
});
