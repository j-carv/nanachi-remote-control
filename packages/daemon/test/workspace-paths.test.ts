import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api-error.js';
import { realRootOf, resolveEntry, resolveExisting } from '../src/workspace-paths.js';
import { removeTempDir } from './temp.js';

/** Outcome of a resolve call: `ok <rel>`, or `<status> <code>` from the thrown ApiError. */
function outcomeOf(resolve: () => { rel: string }): string {
  try {
    return `ok ${resolve().rel}`;
  } catch (error) {
    if (error instanceof ApiError) return `${error.status} ${error.code}`;
    throw error;
  }
}

/** File symlinks need a privilege on Windows (or developer mode). Probed once, synchronously. */
function probeFileSymlinks(): boolean {
  const dir = realpathSync.native(tmpdir());
  const target = join(dir, `nanachi-probe-${process.pid}.txt`);
  const link = join(dir, `nanachi-probe-${process.pid}.lnk`);
  try {
    symlinkSync(target, link, 'file');
    unlinkSync(link);
    return true;
  } catch {
    return false;
  }
}

const CAN_LINK_FILES = probeFileSymlinks();

let base: string;
let root: string;
let outside: string;
let realRoot: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-paths-')));
  root = join(base, 'workspace');
  outside = join(base, 'fora');
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'sub'));
  await mkdir(outside);
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(root, 'src', 'x.ts'), 'x');
  await writeFile(join(outside, 'segredo.txt'), 'fora');
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), '[core]');
  // Directory junctions do not need a privilege on Windows.
  symlinkSync(outside, join(root, 'link-fora'), 'junction');
  symlinkSync(join(root, '.git'), join(root, 'link-git'), 'junction');
  symlinkSync(join(root, 'src'), join(root, 'link-dentro'), 'junction');
  if (CAN_LINK_FILES) {
    symlinkSync(join(outside, 'segredo.txt'), join(root, 'arquivo-fora.txt'), 'file');
    symlinkSync(join(root, 'a.txt'), join(root, 'arquivo-dentro.txt'), 'file');
    symlinkSync(join(root, 'nao-existe.txt'), join(root, 'quebrado.txt'), 'file');
  }
  realRoot = realRootOf(root);
});

afterEach(async () => {
  await removeTempDir(base);
});

describe('caminhos que ficam dentro do workspace', () => {
  it.each([
    ['a.txt', 'a.txt'],
    ['src/x.ts', 'src/x.ts'],
    ['src\\x.ts', 'src/x.ts'],
    ['./src//x.ts', 'src/x.ts'],
    ['src/deep/../x.ts', 'src/x.ts'],
    ['src/../a.txt', 'a.txt'],
    ['.env', '.env'],
    ['CONSOLE.txt', 'CONSOLE.txt'],
    ['COM10.txt', 'COM10.txt'],
    ['gitignore.md', 'gitignore.md'],
    ['link-dentro/x.ts', 'link-dentro/x.ts'],
  ])('%s → %s', (input, rel) => {
    expect(outcomeOf(() => resolveEntry(realRoot, input))).toBe(`ok ${rel}`);
  });

  it('raiz do workspace é aceita como rel vazio (listagem)', () => {
    expect(outcomeOf(() => resolveExisting(realRoot, ''))).toBe('ok ');
  });
});

describe('caminhos recusados', () => {
  it.each([
    // `..` that leaves the root → 403
    ['..', '403 outside_workspace'],
    ['../a.txt', '403 outside_workspace'],
    ['src/../../a.txt', '403 outside_workspace'],
    ['..\\..\\Windows', '403 outside_workspace'],
    // absolutos e unidades → 400
    ['/etc/passwd', '400 invalid_path'],
    ['\\windows\\system32', '400 invalid_path'],
    ['C:\\Windows\\win.ini', '400 invalid_path'],
    ['C:win.ini', '400 invalid_path'],
    ['\\\\servidor\\compartilhamento\\x', '400 invalid_path'],
    // NUL byte and control characters → 400
    ['a.txt\u0000.png', '400 invalid_path'],
    ['a\u0001.txt', '400 invalid_path'],
    ['a\tb.txt', '400 invalid_path'],
    // .git in any letter case, in any folder, and the 8.3 short name → 400
    ['.git', '400 invalid_path'],
    ['.git/config', '400 invalid_path'],
    ['.GIT/HEAD', '400 invalid_path'],
    ['sub/.git/objects', '400 invalid_path'],
    ['GIT~1/config', '400 invalid_path'],
    ['git~2', '400 invalid_path'],
    // fluxos alternativos (ADS) e drive-relative → 400
    ['a.txt:segredo', '400 invalid_path'],
    ['a.txt::$DATA', '400 invalid_path'],
    ['sub:oculto/x.txt', '400 invalid_path'],
    // DOS reserved names, with or without an extension, in any letter case → 400
    ['CON', '400 invalid_path'],
    ['con.txt', '400 invalid_path'],
    ['NUL', '400 invalid_path'],
    ['nul.log', '400 invalid_path'],
    ['Aux.md', '400 invalid_path'],
    ['PRN', '400 invalid_path'],
    ['COM1', '400 invalid_path'],
    ['lpt9.txt', '400 invalid_path'],
    ['COM\u00b9.txt', '400 invalid_path'],
    ['con .txt', '400 invalid_path'],
    ['src/nul', '400 invalid_path'],
    // caracteres proibidos no Windows → 400
    ['a<b.txt', '400 invalid_path'],
    ['a>b.txt', '400 invalid_path'],
    ['a"b.txt', '400 invalid_path'],
    ['a|b.txt', '400 invalid_path'],
    ['a?b.txt', '400 invalid_path'],
    ['a*b.txt', '400 invalid_path'],
    // dot or space at the end of the name (Windows drops it) → 400
    ['file.', '400 invalid_path'],
    ['file ', '400 invalid_path'],
    // tamanho → 400
    [`${'a'.repeat(256)}.txt`, '400 invalid_path'],
    [`${'a/'.repeat(600)}b.txt`, '400 invalid_path'],
  ])('%j → %s', (input, expected) => {
    expect(outcomeOf(() => resolveEntry(realRoot, input))).toBe(expected);
    expect(outcomeOf(() => resolveExisting(realRoot, input))).toBe(expected);
  });
});

describe('links e junctions', () => {
  it('junction que aponta para fora do workspace → 403 ao entrar, mesmo com o caminho lexicamente dentro', () => {
    expect(outcomeOf(() => resolveExisting(realRoot, 'link-fora'))).toBe('403 outside_workspace');
    expect(outcomeOf(() => resolveExisting(realRoot, 'link-fora/segredo.txt'))).toBe('403 outside_workspace');
    expect(outcomeOf(() => resolveEntry(realRoot, 'link-fora/novo.txt'))).toBe('403 outside_workspace');
  });

  it('junction que aponta para dentro de .git → 400 (o destino real tem .git)', () => {
    expect(outcomeOf(() => resolveExisting(realRoot, 'link-git/config'))).toBe('400 invalid_path');
    expect(outcomeOf(() => resolveEntry(realRoot, 'link-git/novo'))).toBe('400 invalid_path');
  });

  it('junction que aponta para dentro do workspace é seguida normalmente', () => {
    expect(outcomeOf(() => resolveExisting(realRoot, 'link-dentro'))).toBe('ok link-dentro');
  });

  it('o próprio link (sem seguir) é o alvo de apagar: resolveEntry devolve o caminho do link', () => {
    expect(resolveEntry(realRoot, 'link-fora').abs).toBe(join(realRoot, 'link-fora'));
  });

  it.runIf(CAN_LINK_FILES)('symlink de arquivo para fora → 403', () => {
    expect(outcomeOf(() => resolveExisting(realRoot, 'arquivo-fora.txt'))).toBe('403 outside_workspace');
  });

  it.runIf(CAN_LINK_FILES)('symlink de arquivo para dentro → seguido', () => {
    expect(outcomeOf(() => resolveExisting(realRoot, 'arquivo-dentro.txt'))).toBe('ok arquivo-dentro.txt');
  });

  it.runIf(CAN_LINK_FILES)('link quebrado: leitura → 404; criação com esse nome segue o link lexical', () => {
    expect(outcomeOf(() => resolveExisting(realRoot, 'quebrado.txt'))).toBe('404 not_found');
    expect(outcomeOf(() => resolveEntry(realRoot, 'quebrado.txt'))).toBe('ok quebrado.txt');
  });
});

describe('existência', () => {
  it('arquivo inexistente: leitura → 404; alvo de criação → ok', () => {
    expect(outcomeOf(() => resolveExisting(realRoot, 'nao-existe.txt'))).toBe('404 not_found');
    expect(outcomeOf(() => resolveEntry(realRoot, 'novo.txt'))).toBe('ok novo.txt');
  });

  it('pasta pai inexistente → 404 em criação', () => {
    expect(outcomeOf(() => resolveEntry(realRoot, 'faltando/novo.txt'))).toBe('404 not_found');
  });

  it('raiz não é alvo de criação (rel vazio sai como ok e o chamador recusa)', () => {
    expect(outcomeOf(() => resolveEntry(realRoot, ''))).toBe('ok ');
  });

  it('workspace apagado do disco → 404 ao resolver a raiz', () => {
    expect(() => realRootOf(join(base, 'sumiu'))).toThrow(ApiError);
  });
});
