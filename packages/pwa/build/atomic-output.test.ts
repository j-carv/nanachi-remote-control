import { mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEEP_RELEASES,
  POINTER_FILE,
  createCoalescedRunner,
  createWatchPublisher,
  nodeReleaseFs,
  publishRelease,
  publishWatchRelease,
  releaseIdFor,
  type ReleaseFs,
  type SetTimer,
} from './atomic-output.js';
import { PRECACHE_LIMITS } from './release-check.js';

/** Erro de sistema de arquivos com código (EBUSY, EPERM...), como o Node lança no Windows. */
function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: arquivo em uso`), { code });
}

let base: string;
let staging: string;
let releasesDir: string;

/** Um build completo: index.html referencia JS e CSS; sw.js tem o manifesto de precache com os três. */
const STAGING_FILES: Record<string, string> = {
  'index.html': '<!doctype html><link rel="stylesheet" href="/assets/a.css"><script type="module" src="/assets/b.js"></script>',
  'sw.js': '[{"revision":"1","url":"index.html"},{"revision":"2","url":"assets/a.css"},{"revision":"3","url":"assets/b.js"}]',
  'assets/a.css': 'a',
  'assets/b.js': 'b',
};

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content);
  }
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else out[rel] = await readFile(join(current, entry.name), 'utf8');
    }
  }
  await walk(dir, '');
  return out;
}

async function pointerRelease(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(join(releasesDir, POINTER_FILE), 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'release' in parsed && typeof parsed.release === 'string') {
    return parsed.release;
  }
  throw new Error('ponteiro sem release');
}

async function releaseNames(): Promise<string[]> {
  return (await readdir(releasesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/** Sistema de arquivos real, com um gancho para simular falhas em uma operação. */
function faultyFs(overrides: Partial<ReleaseFs>): ReleaseFs {
  return { ...nodeReleaseFs, ...overrides };
}

/** Opções sem espera entre tentativas (os testes não precisam dormir). */
function options(overrides: Partial<Parameters<typeof publishRelease>[0]> = {}) {
  return {
    staging,
    releasesDir,
    attempts: 3,
    retryDelayMs: 0,
    newId: () => NEW_ID,
    ...overrides,
  };
}

const NEW_ID = '20260110T000000000Z-ffffff';
const NEWER_ID = '20260111T000000000Z-ffffff';

const OLD_IDS = [
  '20260101T000000000Z-aaaaaa',
  '20260102T000000000Z-bbbbbb',
  '20260103T000000000Z-cccccc',
];

/** Uma release antiga válida, já publicada: pasta com index.html e ponteiro apontando para ela. */
async function seedPublished(ids: readonly string[]): Promise<void> {
  for (const id of ids) await writeTree(join(releasesDir, id), { 'index.html': id });
  await writeFile(join(releasesDir, POINTER_FILE), JSON.stringify({ release: ids.at(-1) }));
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nanachi-release-'));
  staging = join(base, 'releases', '.building');
  releasesDir = join(base, 'releases');
  await writeTree(staging, STAGING_FILES);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('releaseIdFor', () => {
  it('monta um id ordenável por tempo: data compacta UTC e sufixo', () => {
    const id = releaseIdFor(new Date('2026-11-04T15:47:46.123Z'), 'abc123');

    expect(id).toBe('20261104T154746123Z-abc123');
    expect(id < releaseIdFor(new Date('2026-11-04T15:47:47.000Z'), '000000')).toBe(true);
  });
});

describe('publishRelease', () => {
  it('copia o staging para releases/<id>, grava o ponteiro e deixa o staging como está', async () => {
    await seedPublished(OLD_IDS);

    const id = await publishRelease(options());

    expect(id).toBe(NEW_ID);
    expect(await readTree(join(releasesDir, NEW_ID))).toEqual(STAGING_FILES);
    expect(await pointerRelease()).toBe(NEW_ID);
    expect(await readTree(staging)).toEqual(STAGING_FILES);
    expect(await readdir(releasesDir)).not.toContain(`${POINTER_FILE}.${NEW_ID}.tmp`);
  });

  it('primeira publicação (sem releases antigas) cria a pasta e o ponteiro', async () => {
    const id = await publishRelease(options());

    expect(id).toBe(NEW_ID);
    expect(await pointerRelease()).toBe(NEW_ID);
  });

  it('mantém só as últimas KEEP_RELEASES releases e nunca apaga a atual', async () => {
    expect(KEEP_RELEASES).toBe(3);
    await seedPublished(['20260101T000000000Z-aaaaaa', '20260102T000000000Z-bbbbbb', '20260103T000000000Z-cccccc', '20260104T000000000Z-dddddd']);

    await publishRelease(options({ newId: () => '20260105T000000000Z-eeeeee' }));

    expect(await releaseNames()).toEqual(['20260103T000000000Z-cccccc', '20260104T000000000Z-dddddd', '20260105T000000000Z-eeeeee']);
  });

  it('não mexe em entradas que não são releases (staging, arquivos soltos)', async () => {
    await seedPublished(OLD_IDS);
    await writeFile(join(releasesDir, 'notas.txt'), 'deixe-me em paz');

    await publishRelease(options());

    expect(await readdir(releasesDir)).toEqual(expect.arrayContaining(['.building', 'notas.txt', POINTER_FILE, NEW_ID]));
    expect(await releaseNames()).not.toContain(OLD_IDS[0]);
  });

  it('rename do ponteiro com EPERM passageiro: tenta de novo e publica', async () => {
    await seedPublished(OLD_IDS);
    let pointerRenames = 0;
    const fs = faultyFs({
      rename: async (from, to) => {
        if (to.endsWith(POINTER_FILE)) {
          pointerRenames += 1;
          if (pointerRenames === 1) throw fsError('EPERM');
        }
        await fsRename(from, to);
      },
    });

    await publishRelease(options({ fs }));

    expect(pointerRenames).toBe(2);
    expect(await pointerRelease()).toBe(NEW_ID);
  });

  it('ponteiro que nunca troca (EPERM sem fim): lança, o ponteiro antigo continua e a release nova some', async () => {
    await seedPublished(OLD_IDS);
    const fs = faultyFs({
      rename: async (from, to) => {
        if (to.endsWith(POINTER_FILE)) throw fsError('EPERM');
        await fsRename(from, to);
      },
    });

    await expect(publishRelease(options({ fs }))).rejects.toThrow(/EPERM/);

    expect(await pointerRelease()).toBe(OLD_IDS[2]);
    expect(await releaseNames()).not.toContain(NEW_ID);
    expect(await readdir(releasesDir)).not.toContain(`${POINTER_FILE}.${NEW_ID}.tmp`);
    expect(await readTree(join(releasesDir, OLD_IDS[2] ?? ''))).toEqual({ 'index.html': OLD_IDS[2] });
  });

  it('cópia com EPERM sem fim: lança sem trocar o ponteiro e sem deixar pasta parcial', async () => {
    await seedPublished(OLD_IDS);
    const fs = faultyFs({
      copyFiles: async () => {
        throw fsError('EPERM');
      },
    });

    await expect(publishRelease(options({ fs }))).rejects.toThrow(/EPERM/);

    expect(await pointerRelease()).toBe(OLD_IDS[2]);
    expect(await releaseNames()).toEqual(OLD_IDS);
  });

  it('prune com EPERM numa release antiga: publica mesmo assim, avisa e apaga na publicação seguinte', async () => {
    const stuck = OLD_IDS[0] ?? '';
    await seedPublished([...OLD_IDS, '20260104T000000000Z-dddddd']);
    const warnings: string[] = [];
    let blockPrune = true;
    const fs = faultyFs({
      remove: async (path) => {
        if (blockPrune && path.endsWith(stuck)) throw fsError('EPERM');
        await rm(path, { recursive: true, force: true });
      },
    });

    const id = await publishRelease(options({ fs, warn: (message) => warnings.push(message), newId: () => NEW_ID }));

    expect(id).toBe(NEW_ID);
    expect(await pointerRelease()).toBe(NEW_ID);
    expect(await releaseNames()).toContain(stuck);
    expect(warnings).toHaveLength(1);

    blockPrune = false;
    await publishRelease(options({ fs, warn: (message) => warnings.push(message), newId: () => NEWER_ID }));

    expect(await releaseNames()).not.toContain(stuck);
    expect(warnings).toHaveLength(1);
  });

  it('falha do prune não falha a publicação (sem warn injetado, nada lança)', async () => {
    await seedPublished([...OLD_IDS, '20260104T000000000Z-dddddd']);
    const fs = faultyFs({
      remove: async (path) => {
        if (OLD_IDS.some((id) => path.endsWith(id)) || path.endsWith('20260104T000000000Z-dddddd')) throw fsError('EBUSY');
        await rm(path, { recursive: true, force: true });
      },
    });

    await expect(publishRelease(options({ fs }))).resolves.toBe(NEW_ID);
    expect(await pointerRelease()).toBe(NEW_ID);
  });
});

describe('publishRelease: validation of the staging folder', () => {
  it('staging sem o CSS que o index.html referencia: não publica, não cria pasta e mantém o ponteiro', async () => {
    await seedPublished(OLD_IDS);
    await rm(join(staging, 'assets', 'a.css'));

    await expect(publishRelease(options())).rejects.toThrow(/assets\/a\.css/);

    expect(await pointerRelease()).toBe(OLD_IDS[2]);
    expect(await releaseNames()).toEqual(OLD_IDS);
  });

  it('staging com sw.js sem manifesto de precache também não publica', async () => {
    await seedPublished(OLD_IDS);
    await writeFile(join(staging, 'sw.js'), 'console.log(1)');

    await expect(publishRelease(options())).rejects.toThrow(/sem manifesto de precache/);
    expect(await pointerRelease()).toBe(OLD_IDS[2]);
  });
});

describe('publishRelease: validation of the copy', () => {
  it('uma cópia que perde o CSS é apagada e o ponteiro não muda', async () => {
    await seedPublished(OLD_IDS);
    const fs = faultyFs({
      copyFiles: async (from, to, files) => {
        await nodeReleaseFs.copyFiles(from, to, files);
        await rm(join(to, 'assets', 'a.css'));
      },
    });

    await expect(publishRelease(options({ fs }))).rejects.toThrow(/cópia incompleta.*assets\/a\.css/);

    expect(await pointerRelease()).toBe(OLD_IDS[2]);
    expect(await releaseNames()).toEqual(OLD_IDS);
  });

  it('staging que muda durante a cópia não é publicado', async () => {
    await seedPublished(OLD_IDS);
    const fs = faultyFs({
      copyFiles: async (from, to, files) => {
        await nodeReleaseFs.copyFiles(from, to, files);
        await writeFile(join(from, 'assets', 'b.js'), 'reescrito durante a cópia');
      },
    });

    await expect(publishRelease(options({ fs }))).rejects.toThrow(/mudou durante a cópia/);

    expect(await pointerRelease()).toBe(OLD_IDS[2]);
    expect(await releaseNames()).toEqual(OLD_IDS);
  });
});

describe('publishRelease: only the files of the current build', () => {
  it('a stale chunk stays in staging and is not copied into the release', async () => {
    await seedPublished(OLD_IDS);
    await writeFile(join(staging, 'assets', 'stale.js'), 'built by an earlier cycle');

    await publishRelease(options());

    expect(await readTree(join(releasesDir, NEW_ID))).toEqual(STAGING_FILES);
    expect(await readTree(staging)).toHaveProperty(['assets/stale.js'], 'built by an earlier cycle');
  });

  it('a stale chunk that only other stale chunks cite (a cycle) is not copied', async () => {
    await writeFile(join(staging, 'assets', 'bootstrap-old.js'), 'import "./EditorScreen-old.js"');
    await writeFile(join(staging, 'assets', 'EditorScreen-old.js'), 'import "./bootstrap-old.js"');

    await publishRelease(options());

    expect(await readTree(join(releasesDir, NEW_ID))).toEqual(STAGING_FILES);
  });

  it('a source map in staging is not copied into the release', async () => {
    await writeFile(join(staging, 'assets', 'a.css.map'), '{}');

    await publishRelease(options());

    expect(await readTree(join(releasesDir, NEW_ID))).toEqual(STAGING_FILES);
  });

  it('a precache list that names a stale chunk is refused: nothing is published', async () => {
    await seedPublished(OLD_IDS);
    await writeFile(join(staging, 'assets', 'stale.js'), 'old');
    await writeFile(
      join(staging, 'sw.js'),
      '[{"revision":"1","url":"index.html"},{"revision":"2","url":"assets/a.css"},{"revision":"3","url":"assets/b.js"},{"revision":"4","url":"assets/stale.js"}]',
    );

    await expect(publishRelease(options())).rejects.toThrow(/assets\/stale\.js \(precache de arquivo que o build não usa\)/);

    expect(await pointerRelease()).toBe(OLD_IDS[2]);
    expect(await releaseNames()).toEqual(OLD_IDS);
  });

  it('a build whose precache is over the entry cap is refused: nothing is published', async () => {
    await seedPublished(OLD_IDS);
    const count = PRECACHE_LIMITS.maxEntries + 1;
    const names = Array.from({ length: count }, (_, index) => `assets/chunk-${index}.js`);
    await writeFile(join(staging, 'index.html'), names.map((name) => `<link rel="modulepreload" href="/${name}">`).join(''));
    for (const name of names) await writeFile(join(staging, name), '');
    const precache = [{ revision: 'r', url: 'index.html' }, ...names.map((url) => ({ revision: null, url }))];
    await writeFile(join(staging, 'sw.js'), JSON.stringify(precache));

    await expect(publishRelease(options())).rejects.toThrow(/acima do limite/);

    expect(await pointerRelease()).toBe(OLD_IDS[2]);
    expect(await releaseNames()).toEqual(OLD_IDS);
  });
});

describe('publishWatchRelease', () => {
  it('publicação que funciona devolve true e não avisa', async () => {
    const warnings: string[] = [];

    await expect(publishWatchRelease(options({ warn: (message) => warnings.push(message) }))).resolves.toBe(true);
    expect(warnings).toEqual([]);
  });

  it('sem staging (build que não gerou nada) não lança: avisa e devolve false', async () => {
    const warnings: string[] = [];

    await expect(
      publishWatchRelease(options({ staging: join(base, 'nao-existe'), warn: (message) => warnings.push(message) })),
    ).resolves.toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/versão anterior/);
  });

  it('build com CSS faltando não publica e o aviso lista o arquivo que falta', async () => {
    await seedPublished(OLD_IDS);
    await rm(join(staging, 'assets', 'a.css'));
    const warnings: string[] = [];

    await expect(publishWatchRelease(options({ warn: (message) => warnings.push(message) }))).resolves.toBe(false);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/assets\/a\.css/);
    expect(warnings[0]).toMatch(/versão anterior/);
    expect(await pointerRelease()).toBe(OLD_IDS[2]);
  });

  it('ponteiro travado: não derruba o processo, avisa e mantém a release anterior no ar', async () => {
    await seedPublished(OLD_IDS);
    const warnings: string[] = [];
    const fs = faultyFs({
      rename: async (from, to) => {
        if (to.endsWith(POINTER_FILE)) throw fsError('EPERM');
        await fsRename(from, to);
      },
    });

    await expect(publishWatchRelease(options({ fs, warn: (message) => warnings.push(message) }))).resolves.toBe(false);
    expect(await pointerRelease()).toBe(OLD_IDS[2]);
    expect(warnings).toHaveLength(1);
  });
});

/** Timers manuais: o teste dispara cada um quando quiser, sem esperar o tempo real. */
function manualTimers() {
  const pending: { run: () => void; cancelled: boolean }[] = [];
  const setTimer: SetTimer = (run) => {
    const timer = { run, cancelled: false };
    pending.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  /** Dispara os timers ainda não cancelados. */
  function fire(): void {
    for (const timer of pending.splice(0)) if (!timer.cancelled) timer.run();
  }
  return { setTimer, fire, pendingCount: () => pending.filter((timer) => !timer.cancelled).length };
}

describe('createWatchPublisher', () => {
  it('várias closeBundle seguidos geram uma única publicação, depois do debounce', async () => {
    const timers = manualTimers();
    let publishes = 0;
    const publisher = createWatchPublisher({ publish: async () => void (publishes += 1), debounceMs: 1500, setTimer: timers.setTimer });

    publisher.buildEnd(undefined);
    publisher.buildEnd(undefined);
    publisher.buildEnd(undefined);

    expect(timers.pendingCount()).toBe(1);
    timers.fire();
    await publisher.idle();
    expect(publishes).toBe(1);
  });

  it('buildStart antes do fim do debounce cancela a publicação agendada', async () => {
    const timers = manualTimers();
    let publishes = 0;
    const publisher = createWatchPublisher({ publish: async () => void (publishes += 1), setTimer: timers.setTimer });

    publisher.buildEnd(undefined);
    publisher.buildStart();
    timers.fire();
    await publisher.idle();
    expect(publishes).toBe(0);

    publisher.buildEnd(undefined);
    timers.fire();
    await publisher.idle();
    expect(publishes).toBe(1);
  });

  it('build com erro não agenda publicação: a release anterior continua', async () => {
    const timers = manualTimers();
    let publishes = 0;
    const publisher = createWatchPublisher({ publish: async () => void (publishes += 1), setTimer: timers.setTimer });

    publisher.buildEnd(new Error('falha de compilação'));

    expect(timers.pendingCount()).toBe(0);
    timers.fire();
    await publisher.idle();
    expect(publishes).toBe(0);
  });

  it('a publicação roda uma vez por vez: chamadas durante uma execução viram uma execução extra depois dela', async () => {
    const events: string[] = [];
    const finishers: (() => void)[] = [];
    const run = createCoalescedRunner(async () => {
      events.push('start');
      await new Promise<void>((resolve) => {
        finishers.push(resolve);
      });
      events.push('end');
    });

    const first = run();
    const second = run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['start']);

    finishers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['start', 'end', 'start']);

    finishers.shift()?.();
    await Promise.all([first, second]);
    expect(events).toEqual(['start', 'end', 'start', 'end']);
  });

  it('integração com o disco: várias closeBundle geram uma só release e o ponteiro aponta para ela', async () => {
    await seedPublished(OLD_IDS);
    const timers = manualTimers();
    const publisher = createWatchPublisher({
      publish: async () => {
        await publishWatchRelease(options({ newId: () => NEW_ID, warn: () => undefined }));
      },
      setTimer: timers.setTimer,
    });

    publisher.buildEnd(undefined);
    publisher.buildEnd(undefined);
    timers.fire();
    await publisher.idle();

    expect(await releaseNames()).toEqual([OLD_IDS[1], OLD_IDS[2], NEW_ID].sort());
    expect(await pointerRelease()).toBe(NEW_ID);
  });
});
