import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPwaRoot, missingReleaseFiles } from '../src/pwa-root.js';

const RELEASE_A = '20261104T154746123Z-aaaaaa';
const RELEASE_B = '20261104T160000000Z-bbbbbb';

let base: string;
let fallbackDir: string;
let pointer: string;
let warnings: string[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nanachi-pwa-root-'));
  fallbackDir = join(base, 'pwa');
  pointer = join(base, 'releases', 'current.json');
  warnings = [];
  await mkdir(fallbackDir, { recursive: true });
  await mkdir(join(base, 'releases'), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Pasta de release com index.html (o que o resolvedor exige). */
async function release(id: string): Promise<string> {
  const dir = join(base, 'releases', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), id);
  return dir;
}

/** Escreve o ponteiro com mtime explícito: o resolvedor compara mtime, tamanho e inode. */
async function writePointer(body: string, seconds: number): Promise<void> {
  await writeFile(pointer, body);
  const when = new Date(seconds * 1000);
  await utimes(pointer, when, when);
}

function root() {
  return createPwaRoot({ fallbackDir, pointerFile: pointer, warn: (message) => warnings.push(message) });
}

describe('createPwaRoot', () => {
  it('sem ponteiro, devolve a pasta de fallback (dist)', () => {
    expect(root().current()).toBe(fallbackDir);
  });

  it('com ponteiro válido, devolve a pasta da release', async () => {
    const dir = await release(RELEASE_A);
    await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);

    expect(root().current()).toBe(dir);
    expect(warnings).toEqual([]);
  });

  it('segue o ponteiro quando ele muda, sem recriar o resolvedor', async () => {
    await release(RELEASE_A);
    const dirB = await release(RELEASE_B);
    const resolver = root();
    await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);
    expect(resolver.current()).toContain(RELEASE_A);

    await writePointer(JSON.stringify({ release: RELEASE_B }), 2_000);

    expect(resolver.current()).toBe(dirB);
  });

  it('não relê enquanto o ponteiro não muda (cache por mtime, tamanho e inode)', async () => {
    const dirA = await release(RELEASE_A);
    await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);
    const resolver = root();
    expect(resolver.current()).toBe(dirA);

    // Mesmo tamanho e mtime: o cache responde o último valor, sem reabrir o arquivo.
    await release(RELEASE_B);
    await writePointer(JSON.stringify({ release: RELEASE_B }), 1_000);

    expect(resolver.current()).toBe(dirA);
  });

  it('ponteiro removido volta para o fallback', async () => {
    await release(RELEASE_A);
    await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);
    const resolver = root();
    expect(resolver.current()).toContain(RELEASE_A);

    await rm(pointer);

    expect(resolver.current()).toBe(fallbackDir);
  });

  it('ponteiro com JSON inválido mantém a última release boa e avisa uma vez', async () => {
    const dirA = await release(RELEASE_A);
    await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);
    const resolver = root();
    expect(resolver.current()).toBe(dirA);

    await writePointer('{ isto não é json', 2_000);

    expect(resolver.current()).toBe(dirA);
    expect(resolver.current()).toBe(dirA);
    expect(warnings).toHaveLength(1);
  });

  it('release sem index.html não vira raiz: fica a última boa (ou o fallback, se não há nenhuma)', async () => {
    await writePointer(JSON.stringify({ release: RELEASE_B }), 1_000);
    expect(root().current()).toBe(fallbackDir);

    const dirA = await release(RELEASE_A);
    await writePointer(JSON.stringify({ release: RELEASE_A }), 2_000);
    const resolver = root();
    expect(resolver.current()).toBe(dirA);
    await writePointer(JSON.stringify({ release: RELEASE_B }), 3_000);
    expect(resolver.current()).toBe(dirA);
  });

  it('nome fora do formato de release (caminho, ponto-ponto, lixo) é rejeitado', async () => {
    const dirA = await release(RELEASE_A);
    await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);
    const resolver = root();
    expect(resolver.current()).toBe(dirA);

    for (const [seconds, bad] of [
      [2_000, '../pwa'],
      [3_000, RELEASE_B.replace('-', '/')],
      [4_000, 'x'],
    ] as const) {
      await writePointer(JSON.stringify({ release: bad }), seconds);
      expect(resolver.current()).toBe(dirA);
    }
    expect(warnings).toHaveLength(3);
  });

  it('JSON sem o campo release também é inválido', async () => {
    await writePointer(JSON.stringify({ outro: RELEASE_A }), 1_000);

    expect(root().current()).toBe(fallbackDir);
    expect(warnings).toHaveLength(1);
  });

  describe('release com arquivos referenciados faltando', () => {
    /** Release cujo index.html referencia um CSS e um JS; `present` são os que existem na pasta. */
    async function releaseReferencing(id: string, present: readonly string[]): Promise<string> {
      const dir = join(base, 'releases', id);
      await mkdir(join(dir, 'assets'), { recursive: true });
      await writeFile(
        join(dir, 'index.html'),
        '<link rel="stylesheet" href="/assets/index-abc.css"><script type="module" src="/assets/index-def.js"></script>',
      );
      for (const rel of present) await writeFile(join(dir, rel), '');
      return dir;
    }

    it('release cujo CSS referenciado não existe não é servida: cai para pwa/ e avisa qual arquivo falta', async () => {
      await releaseReferencing(RELEASE_A, ['assets/index-def.js']);
      await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);

      expect(root().current()).toBe(fallbackDir);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/assets\/index-abc\.css/);
    });

    it('release com todos os arquivos referenciados é servida sem aviso', async () => {
      const dirA = await releaseReferencing(RELEASE_A, ['assets/index-abc.css', 'assets/index-def.js']);
      await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);

      expect(root().current()).toBe(dirA);
      expect(warnings).toEqual([]);
    });

    it('release nova incompleta mantém a última release completa no ar', async () => {
      const dirA = await releaseReferencing(RELEASE_A, ['assets/index-abc.css', 'assets/index-def.js']);
      await releaseReferencing(RELEASE_B, ['assets/index-def.js']);
      const resolver = root();
      await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);
      expect(resolver.current()).toBe(dirA);

      await writePointer(JSON.stringify({ release: RELEASE_B }), 2_000);

      expect(resolver.current()).toBe(dirA);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/assets\/index-abc\.css/);
    });

    it('cada release é verificada uma vez: o ponteiro indo e voltando não relê a pasta', async () => {
      const checked: string[] = [];
      await release(RELEASE_A);
      await release(RELEASE_B);
      const resolver = createPwaRoot({
        fallbackDir,
        pointerFile: pointer,
        warn: (message) => warnings.push(message),
        missingFiles: (dir) => {
          checked.push(dir);
          return missingReleaseFiles(dir);
        },
      });

      await writePointer(JSON.stringify({ release: RELEASE_A }), 1_000);
      resolver.current();
      await writePointer(JSON.stringify({ release: RELEASE_B }), 2_000);
      resolver.current();
      await writePointer(JSON.stringify({ release: RELEASE_A }), 3_000);
      resolver.current();
      await writePointer(JSON.stringify({ release: RELEASE_B }), 4_000);
      resolver.current();

      expect(checked).toEqual([join(base, 'releases', RELEASE_A), join(base, 'releases', RELEASE_B)]);
    });
  });
});
