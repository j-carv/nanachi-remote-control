import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectory, PathError, resolveInsideRoots, type PathErrorCode } from '../src/roots.js';
import { removeTempDir } from './temp.js';

let base: string;
/** Raiz permitida. */
let root: string;
/** Pasta irmã de `root` com o mesmo prefixo de nome (`bc` vs `b`). */
let sibling: string;
/** Pasta fora das raízes, ao lado. */
let outside: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-roots-')));
  root = join(base, 'a', 'b');
  sibling = join(base, 'a', 'bc');
  outside = join(base, 'fora');
  await mkdir(join(root, 'projeto', 'sub'), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'segredo.txt'), 'x');
});

afterEach(async () => {
  await removeTempDir(base);
});

/** Confere que a função lança PathError com o código esperado. */
function expectPathError(fn: () => unknown, code: PathErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PathError);
  expect((caught as PathError).code).toBe(code);
}

describe('resolveInsideRoots', () => {
  it('aceita uma pasta dentro da raiz e devolve o caminho real', () => {
    expect(resolveInsideRoots(join(root, 'projeto'), [root])).toBe(join(root, 'projeto'));
  });

  it('aceita a própria raiz', () => {
    expect(resolveInsideRoots(root, [root])).toBe(root);
  });

  it('aceita descendentes em vários níveis', () => {
    expect(resolveInsideRoots(join(root, 'projeto', 'sub'), [root])).toBe(join(root, 'projeto', 'sub'));
  });

  it('recusa irmã cujo nome começa igual à raiz (a/bc não está em a/b)', () => {
    expectPathError(() => resolveInsideRoots(sibling, [root]), 'outside_roots');
  });

  it('resolve .. antes de decidir: sair da raiz por .. é outside_roots', () => {
    expectPathError(() => resolveInsideRoots(join(root, '..', '..', 'fora'), [root]), 'outside_roots');
  });

  it('.. que continua dentro da raiz é aceito', () => {
    expect(resolveInsideRoots(join(root, 'projeto', '..', 'projeto'), [root])).toBe(join(root, 'projeto'));
  });

  it('recusa junction que aponta para fora da raiz', () => {
    const link = join(root, 'escape');
    symlinkSync(outside, link, 'junction');
    try {
      expectPathError(() => resolveInsideRoots(link, [root]), 'outside_roots');
      expectPathError(() => resolveInsideRoots(join(link, 'segredo.txt'), [root]), 'outside_roots');
    } finally {
      rmdirSync(link);
    }
  });

  it('pasta inexistente dentro da raiz é not_found', () => {
    expectPathError(() => resolveInsideRoots(join(root, 'nao-existe'), [root]), 'not_found');
  });

  it('pasta inexistente fora da raiz é outside_roots, sem revelar se existe', () => {
    expectPathError(() => resolveInsideRoots(join(base, 'nao-existe'), [root]), 'outside_roots');
  });

  it('sem raízes, qualquer caminho é outside_roots', () => {
    expectPathError(() => resolveInsideRoots(root, []), 'outside_roots');
  });

  it('caminho relativo é outside_roots', () => {
    expectPathError(() => resolveInsideRoots('projeto', [root]), 'outside_roots');
  });

  it.runIf(process.platform === 'win32')('compara sem diferenciar maiúsculas no Windows', () => {
    expect(resolveInsideRoots(join(root, 'projeto').toUpperCase(), [root])).toBe(join(root, 'projeto'));
  });
});

describe('listDirectory', () => {
  beforeEach(async () => {
    await mkdir(join(root, 'Zeta'));
    await mkdir(join(root, 'alfa'));
    await mkdir(join(root, '.oculta'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'notas.txt'), 'x');
  });

  it('lista só subpastas, ordenadas, sem ocultas, node_modules nem arquivos', () => {
    const listing = listDirectory(root, [root]);
    expect(listing).toEqual({
      path: root,
      parent: null,
      dirs: [
        { name: 'alfa', path: join(root, 'alfa') },
        { name: 'projeto', path: join(root, 'projeto') },
        { name: 'Zeta', path: join(root, 'Zeta') },
      ],
    });
  });

  it('omite junction que aponta para fora da raiz', () => {
    const escape = join(root, 'escape');
    symlinkSync(outside, escape, 'junction');
    try {
      expect(listDirectory(root, [root]).dirs.map((dir) => dir.name)).toEqual(['alfa', 'projeto', 'Zeta']);
    } finally {
      rmdirSync(escape);
    }
  });

  it('lista junction que aponta para pasta dentro da raiz, com o caminho sob a pasta listada', () => {
    const inner = join(root, 'interno');
    symlinkSync(join(root, 'projeto'), inner, 'junction');
    try {
      expect(listDirectory(root, [root]).dirs).toEqual([
        { name: 'alfa', path: join(root, 'alfa') },
        { name: 'interno', path: inner },
        { name: 'projeto', path: join(root, 'projeto') },
        { name: 'Zeta', path: join(root, 'Zeta') },
      ]);
    } finally {
      rmdirSync(inner);
    }
  });

  it('lista symlink de diretório que aponta para dentro da raiz (pula se o Windows não permitir)', (ctx) => {
    const inner = join(root, 'link-dir');
    try {
      symlinkSync(join(root, 'projeto'), inner, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw error;
    }
    try {
      expect(listDirectory(root, [root]).dirs.map((dir) => dir.name)).toContain('link-dir');
    } finally {
      unlinkSync(inner);
    }
  });

  it('omite symlink de diretório que aponta para fora (pula se o Windows não permitir)', (ctx) => {
    const escape = join(root, 'link-fora');
    try {
      symlinkSync(outside, escape, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw error;
    }
    try {
      expect(listDirectory(root, [root]).dirs.map((dir) => dir.name)).not.toContain('link-fora');
    } finally {
      unlinkSync(escape);
    }
  });

  it('omite só a entrada cujo alvo não pode ser lido (junction quebrada), sem derrubar a listagem', () => {
    const broken = join(root, 'quebrada');
    symlinkSync(join(base, 'nao-existe'), broken, 'junction');
    try {
      expect(listDirectory(root, [root]).dirs.map((dir) => dir.name)).toEqual(['alfa', 'projeto', 'Zeta']);
    } finally {
      rmdirSync(broken);
    }
  });

  it('omite entrada oculta mesmo quando é junction válida dentro da raiz', () => {
    const hidden = join(root, '.oculta-link');
    symlinkSync(join(root, 'projeto'), hidden, 'junction');
    try {
      expect(listDirectory(root, [root]).dirs.map((dir) => dir.name)).toEqual(['alfa', 'projeto', 'Zeta']);
    } finally {
      rmdirSync(hidden);
    }
  });

  it('parent aponta para a pasta acima dentro da raiz', () => {
    expect(listDirectory(join(root, 'projeto'), [root]).parent).toBe(root);
  });

  it('parent é null na própria raiz, mesmo com subpastas', () => {
    expect(listDirectory(root, [root]).parent).toBeNull();
  });

  it('arquivo no lugar de pasta é not_a_directory', () => {
    expectPathError(() => listDirectory(join(root, 'notas.txt'), [root]), 'not_a_directory');
  });

  it('caminho fora das raízes é outside_roots', () => {
    expectPathError(() => listDirectory(outside, [root]), 'outside_roots');
  });
});
