import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceEntriesResponse, WorkspaceFileResponse, WorkspaceFileWriteResponse } from '@nanachi/shared';
import { WorkspaceEntriesResponseSchema, WorkspaceFileResponseSchema, WorkspaceFileWriteResponseSchema } from '@nanachi/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEXT_MAX_BYTES } from '../src/workspace-fs.js';
import { authHeader, createWorkspace } from './agent-support.js';
import { initRepo, writeIn } from './git-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-fs-')));
  root = join(base, 'projeto');
  outside = join(base, 'fora');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'segredo.txt'), 'fora do workspace');
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registered before the daemons: its afterEach runs last.
const env = setupDaemonTests();

interface Call {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  url: string;
  payload?: object;
}

/** Authenticated call. Every call uses the same token, because the write limit is per device. */
async function call(daemon: TestDaemon, token: string, { method, url, payload }: Call): Promise<LightMyRequestResponse> {
  return daemon.app.inject({ method, url, headers: { authorization: token }, ...(payload === undefined ? {} : { payload }) });
}

async function start(): Promise<{ daemon: TestDaemon; id: string; token: string }> {
  const daemon = await env.start({ config: { allowedRoots: [base] } });
  const headers = await authHeader(daemon);
  const token = headers.authorization;
  const id = await createWorkspace(daemon, root);
  return { daemon, id, token };
}

function fsUrl(id: string, route: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `/api/workspaces/${id}/fs/${route}${search === '' ? '' : `?${search}`}`;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('GET fs/list', () => {
  it('lista pastas primeiro, depois arquivos, sem .git, com tipo e tamanho', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'b.txt', 'bb');
    await writeIn(root, 'pasta/x.ts', 'x');
    await mkdir(join(root, '.git'));
    await writeIn(root, 'A.md', 'a');

    const res = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list') });
    expect(res.statusCode).toBe(200);
    const body: WorkspaceEntriesResponse = WorkspaceEntriesResponseSchema.parse(res.json<unknown>());
    expect(body.entries.map((entry) => [entry.name, entry.type])).toEqual([
      ['pasta', 'dir'],
      ['A.md', 'file'],
      ['b.txt', 'file'],
    ]);
    expect(body.entries.find((entry) => entry.name === 'b.txt')?.size).toBe(2);
    expect(body.entries.every((entry) => entry.ignored === false)).toBe(true);
  });

  it('lista subpasta pelo path relativo', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'src/deep/x.ts', 'x');
    const res = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list', { path: 'src' }) });
    expect(res.json<WorkspaceEntriesResponse>().entries.map((entry) => entry.name)).toEqual(['deep']);
  });

  it('junction para fora aparece como symlink e nunca é seguida', async () => {
    const { daemon, id, token } = await start();
    symlinkSync(outside, join(root, 'atalho'), 'junction');
    const res = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list') });
    const entry = res.json<WorkspaceEntriesResponse>().entries.find((item) => item.name === 'atalho');
    expect(entry?.type).toBe('symlink');
    const inside = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list', { path: 'atalho' }) });
    expect(inside.statusCode).toBe(403);
    expect(inside.json()).toEqual({ error: 'outside_workspace' });
  });

  it('marca ignorados em repositório git com uma consulta só; tracked e normais ficam false', async () => {
    const { daemon, id, token } = await start();
    initRepo(root);
    await writeFile(join(root, '.gitignore'), 'build/\n*.log\n');
    await writeIn(root, 'build/saida.js', 'x');
    await writeIn(root, 'erro.log', 'x');
    await writeIn(root, 'fonte.ts', 'x');

    const res = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list') });
    const ignored = Object.fromEntries(res.json<WorkspaceEntriesResponse>().entries.map((entry) => [entry.name, entry.ignored]));
    expect(ignored).toEqual({ '.gitignore': false, 'a.txt': false, 'build': true, 'erro.log': true, 'fonte.ts': false, 'remover.txt': false });
  });

  it('listar um arquivo → 400; pasta inexistente → 404; path com .. que sai → 403', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'a.txt', 'a');
    expect((await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list', { path: 'a.txt' }) })).json()).toEqual({
      error: 'not_a_directory',
    });
    expect((await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list', { path: 'nao-existe' }) })).statusCode).toBe(404);
    const escape = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list', { path: '../fora' }) });
    expect(escape.statusCode).toBe(403);
  });

  it('workspace inexistente → 404 not_found', async () => {
    const { daemon, token } = await start();
    const res = await call(daemon, token, { method: 'GET', url: fsUrl('nao-existe', 'list') });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET fs/file', () => {
  it('lê texto com etag (sha256 do conteúdo), tamanho e mtime', async () => {
    const { daemon, id, token } = await start();
    const bytes = Buffer.from('olá\nmundo\n', 'utf8');
    await writeIn(root, 'a.txt', bytes);

    const res = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'a.txt' }) });
    expect(res.statusCode).toBe(200);
    const body: WorkspaceFileResponse = WorkspaceFileResponseSchema.parse(res.json<unknown>());
    expect(body).toMatchObject({ path: 'a.txt', content: 'olá\nmundo\n', encoding: 'utf8', size: bytes.length });
    expect(body.etag).toBe(sha256(bytes));
    expect(body.mtimeMs).toBeGreaterThan(0);
  });

  it('preserva BOM e CRLF na leitura', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'win.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));
    const body = (await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'win.txt' }) })).json<WorkspaceFileResponse>();
    expect(body.content).toBe('﻿a\r\nb\r\n');
  });

  it('arquivo binário (NUL nos primeiros 8 KiB) → 415 binary_file', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
    const res = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'img.png' }) });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'binary_file' });
  });

  it('bytes que não são UTF-8 válido → 415 (não reescreve Windows-1252 com perda)', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const res = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'latin.txt' }) });
    expect(res.json()).toEqual({ error: 'binary_file' });
  });

  it('arquivo acima de 2 MiB → 413 file_too_large; exatamente 2 MiB é lido', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'grande.txt', Buffer.alloc(TEXT_MAX_BYTES + 1, 'a'));
    await writeIn(root, 'no-limite.txt', Buffer.alloc(TEXT_MAX_BYTES, 'a'));
    const big = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'grande.txt' }) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: 'file_too_large' });
    const edge = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'no-limite.txt' }) });
    expect(edge.statusCode).toBe(200);
  });

  it('pasta → 400 not_a_file; inexistente → 404; raiz do workspace → 400', async () => {
    const { daemon, id, token } = await start();
    await mkdir(join(root, 'pasta'));
    expect((await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'pasta' }) })).json()).toEqual({ error: 'not_a_file' });
    expect((await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'nao.txt' }) })).statusCode).toBe(404);
    expect((await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: '' }) })).json()).toEqual({ error: 'not_a_file' });
  });

  it('arquivo fora do workspace por junction → 403, sem ler o conteúdo', async () => {
    const { daemon, id, token } = await start();
    symlinkSync(outside, join(root, 'atalho'), 'junction');
    const res = await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'atalho/segredo.txt' }) });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('fora do workspace');
  });
});

describe('PUT fs/file', () => {
  it('atualiza com o etag atual e devolve o etag novo', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'a.txt', 'um\n');
    const read = (await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'a.txt' }) })).json<WorkspaceFileResponse>();

    const res = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'a.txt', content: 'dois\n', baseEtag: read.etag },
    });
    expect(res.statusCode).toBe(200);
    const body: WorkspaceFileWriteResponse = WorkspaceFileWriteResponseSchema.parse(res.json<unknown>());
    expect(body.etag).toBe(sha256(Buffer.from('dois\n')));
    expect(body.size).toBe(5);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('dois\n');
  });

  it('etag diferente → 409 file_changed com o etag atual; o arquivo não muda', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'a.txt', 'do outro lado');
    const res = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'a.txt', content: 'meu', baseEtag: 'etag-velho' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'file_changed', details: { etag: sha256(Buffer.from('do outro lado')) } });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('do outro lado');
  });

  it('baseEtag null cria o arquivo; se já existe → 409 file_exists e nada muda', async () => {
    const { daemon, id, token } = await start();
    const created = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'novo/x.md', content: '# oi', baseEtag: null },
    });
    expect(created.statusCode).toBe(404);

    await mkdir(join(root, 'novo'));
    const first = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'novo/x.md', content: '# oi', baseEtag: null },
    });
    expect(first.statusCode).toBe(200);
    expect(await readFile(join(root, 'novo', 'x.md'), 'utf8')).toBe('# oi');

    const again = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'novo/x.md', content: 'outra', baseEtag: null },
    });
    expect(again.json()).toEqual({ error: 'file_exists' });
    expect(await readFile(join(root, 'novo', 'x.md'), 'utf8')).toBe('# oi');
  });

  it('atualizar arquivo que sumiu → 404 not_found', async () => {
    const { daemon, id, token } = await start();
    const res = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'sumiu.txt', content: 'x', baseEtag: 'algum' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('não grava não-texto: arquivo binário com o etag dele → 415, nada muda', async () => {
    const { daemon, id, token } = await start();
    const bin = Buffer.from([0x00, 0x01, 0x02]);
    await writeIn(root, 'bin.dat', bin);
    const res = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'bin.dat', content: 'texto', baseEtag: sha256(bin) },
    });
    expect(res.json()).toEqual({ error: 'binary_file' });
    expect(await readFile(join(root, 'bin.dat'))).toEqual(bin);
  });

  it('preserva CRLF do original mesmo quando o cliente manda LF', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'win.txt', 'a\r\nb\r\n');
    const read = (await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'win.txt' }) })).json<WorkspaceFileResponse>();
    await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'win.txt', content: 'a\nc\nd\n', baseEtag: read.etag },
    });
    expect(await readFile(join(root, 'win.txt'), 'utf8')).toBe('a\r\nc\r\nd\r\n');
  });

  it('preserva LF do original mesmo quando o cliente manda CRLF', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'unix.txt', 'a\nb\n');
    const read = (await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'unix.txt' }) })).json<WorkspaceFileResponse>();
    await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'unix.txt', content: 'a\r\nz\r\n', baseEtag: read.etag },
    });
    expect(await readFile(join(root, 'unix.txt'), 'utf8')).toBe('a\nz\n');
  });

  it('arquivo novo grava o conteúdo como veio (sem converter fim de linha)', async () => {
    const { daemon, id, token } = await start();
    await call(daemon, token, { method: 'PUT', url: fsUrl(id, 'file'), payload: { path: 'n.txt', content: 'a\r\nb', baseEtag: null } });
    expect(await readFile(join(root, 'n.txt'), 'utf8')).toBe('a\r\nb');
  });

  it('BOM sobrevive a uma leitura seguida de gravação', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n')]));
    const read = (await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'bom.txt' }) })).json<WorkspaceFileResponse>();
    await call(daemon, token, { method: 'PUT', url: fsUrl(id, 'file'), payload: { path: 'bom.txt', content: read.content + 'y\n', baseEtag: read.etag } });
    expect(await readFile(join(root, 'bom.txt'))).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\ny\n')]));
  });

  it('conteúdo acima de 2 MiB → 413 file_too_large, sem gravar nada', async () => {
    const { daemon, id, token } = await start();
    const res = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'grande.txt', content: 'a'.repeat(TEXT_MAX_BYTES + 1), baseEtag: null },
    });
    expect(res.json()).toEqual({ error: 'file_too_large' });
    expect(existsSync(join(root, 'grande.txt'))).toBe(false);
  });

  it('não deixa arquivo temporário para trás depois de gravar', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'a.txt', 'um');
    const read = (await call(daemon, token, { method: 'GET', url: fsUrl(id, 'file', { path: 'a.txt' }) })).json<WorkspaceFileResponse>();
    await call(daemon, token, { method: 'PUT', url: fsUrl(id, 'file'), payload: { path: 'a.txt', content: 'dois', baseEtag: read.etag } });
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('caminho que sai do workspace → 403; caminho proibido → 400; body inválido → 400', async () => {
    const { daemon, id, token } = await start();
    const escape = await call(daemon, token, { method: 'PUT', url: fsUrl(id, 'file'), payload: { path: '../x.txt', content: 'x', baseEtag: null } });
    expect(escape.statusCode).toBe(403);
    const forbidden = await call(daemon, token, { method: 'PUT', url: fsUrl(id, 'file'), payload: { path: '.git/config', content: 'x', baseEtag: null } });
    expect(forbidden.json()).toEqual({ error: 'invalid_path' });
    const badBody = await call(daemon, token, { method: 'PUT', url: fsUrl(id, 'file'), payload: { path: 'x.txt', content: 'x' } });
    expect(badBody.json()).toEqual({ error: 'invalid_request' });
  });

  it('gravação por junction para fora → 403 e o alvo externo não muda', async () => {
    const { daemon, id, token } = await start();
    symlinkSync(outside, join(root, 'atalho'), 'junction');
    const res = await call(daemon, token, {
      method: 'PUT',
      url: fsUrl(id, 'file'),
      payload: { path: 'atalho/novo.txt', content: 'x', baseEtag: null },
    });
    expect(res.statusCode).toBe(403);
    expect(existsSync(join(outside, 'novo.txt'))).toBe(false);
  });
});

describe('POST fs/mkdir, POST fs/rename, DELETE fs/entry', () => {
  it('mkdir cria a pasta; já existe → 409 already_exists; pai ausente → 404', async () => {
    const { daemon, id, token } = await start();
    const created = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'mkdir'), payload: { path: 'nova' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ path: 'nova' });
    expect((await call(daemon, token, { method: 'POST', url: fsUrl(id, 'mkdir'), payload: { path: 'nova' } })).json()).toEqual({
      error: 'already_exists',
    });
    expect((await call(daemon, token, { method: 'POST', url: fsUrl(id, 'mkdir'), payload: { path: 'x/y' } })).statusCode).toBe(404);
  });

  it('rename move arquivo e pasta; destino existente → 409; origem ausente → 404', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'a.txt', 'a');
    await writeIn(root, 'b.txt', 'b');
    const existing = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'rename'), payload: { from: 'a.txt', to: 'b.txt' } });
    expect(existing.json()).toEqual({ error: 'already_exists' });

    const moved = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'rename'), payload: { from: 'a.txt', to: 'sub/c.txt' } });
    expect(moved.statusCode).toBe(404);
    await mkdir(join(root, 'sub'));
    const ok = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'rename'), payload: { from: 'a.txt', to: 'sub/c.txt' } });
    expect(ok.json()).toEqual({ from: 'a.txt', to: 'sub/c.txt' });
    expect(existsSync(join(root, 'sub', 'c.txt'))).toBe(true);
    expect(existsSync(join(root, 'a.txt'))).toBe(false);

    const missing = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'rename'), payload: { from: 'nao.txt', to: 'x.txt' } });
    expect(missing.statusCode).toBe(404);
  });

  it('rename só de maiúsculas/minúsculas no mesmo arquivo é permitido', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'readme.md', 'r');
    const res = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'rename'), payload: { from: 'readme.md', to: 'README.md' } });
    expect(res.statusCode).toBe(200);
    expect(readdirSync(root)).toContain('README.md');
  });

  it('rename de pasta para dentro dela mesma → 400 invalid_path; de/para .git → 400', async () => {
    const { daemon, id, token } = await start();
    await mkdir(join(root, 'pasta'));
    const inside = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'rename'), payload: { from: 'pasta', to: 'pasta/x' } });
    expect(inside.json()).toEqual({ error: 'invalid_path' });
    const toGit = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'rename'), payload: { from: 'pasta', to: '.git' } });
    expect(toGit.json()).toEqual({ error: 'invalid_path' });
  });

  it('delete apaga arquivo e pasta vazia; pasta com conteúdo → 409 dir_not_empty, nada apagado', async () => {
    const { daemon, id, token } = await start();
    await writeIn(root, 'a.txt', 'a');
    await mkdir(join(root, 'vazia'));
    await writeIn(root, 'cheia/x.txt', 'x');

    expect((await call(daemon, token, { method: 'DELETE', url: fsUrl(id, 'entry', { path: 'a.txt' }) })).statusCode).toBe(204);
    expect((await call(daemon, token, { method: 'DELETE', url: fsUrl(id, 'entry', { path: 'vazia' }) })).statusCode).toBe(204);
    const full = await call(daemon, token, { method: 'DELETE', url: fsUrl(id, 'entry', { path: 'cheia' }) });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: 'dir_not_empty' });
    expect(existsSync(join(root, 'cheia', 'x.txt'))).toBe(true);
  });

  it('delete nunca é recursivo nem apaga a raiz; inexistente → 404', async () => {
    const { daemon, id, token } = await start();
    expect((await call(daemon, token, { method: 'DELETE', url: fsUrl(id, 'entry', { path: '' }) })).json()).toEqual({
      error: 'invalid_path',
    });
    expect((await call(daemon, token, { method: 'DELETE', url: fsUrl(id, 'entry', { path: 'nada.txt' }) })).statusCode).toBe(404);
    expect((await call(daemon, token, { method: 'DELETE', url: fsUrl(id, 'entry', { path: '.git' }) })).json()).toEqual({
      error: 'invalid_path',
    });
  });

  it('delete de junction remove só o link: o alvo de fora continua lá', async () => {
    const { daemon, id, token } = await start();
    symlinkSync(outside, join(root, 'atalho'), 'junction');
    const res = await call(daemon, token, { method: 'DELETE', url: fsUrl(id, 'entry', { path: 'atalho' }) });
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(root, 'atalho'))).toBe(false);
    expect(existsSync(join(outside, 'segredo.txt'))).toBe(true);
  });
});

describe('autenticação e limite de escrita', () => {
  it('sem Bearer → 401 em todas as rotas de arquivos', async () => {
    const { daemon, id } = await start();
    const routes: Array<[string, string]> = [
      ['GET', fsUrl(id, 'list')],
      ['GET', fsUrl(id, 'file', { path: 'a.txt' })],
      ['PUT', fsUrl(id, 'file')],
      ['POST', fsUrl(id, 'mkdir')],
      ['POST', fsUrl(id, 'rename')],
      ['DELETE', fsUrl(id, 'entry', { path: 'a.txt' })],
    ];
    for (const [method, url] of routes) {
      const res = await daemon.app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('mais de 120 escritas por minuto do mesmo dispositivo → 429 too_many_writes', async () => {
    const { daemon, id, token } = await start();
    for (let i = 0; i < 120; i++) {
      const res = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'mkdir'), payload: { path: `d${i}` } });
      expect(res.statusCode).toBe(201);
    }
    const blocked = await call(daemon, token, { method: 'POST', url: fsUrl(id, 'mkdir'), payload: { path: 'extra' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'too_many_writes' });
    // Reads do not count toward the write limit.
    expect((await call(daemon, token, { method: 'GET', url: fsUrl(id, 'list') })).statusCode).toBe(200);
  });
});
