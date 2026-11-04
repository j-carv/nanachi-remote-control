import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentImages } from '../src/agent-images.js';
import { openDatabase } from '../src/db.js';
import { MAX_FILE_BYTES } from '../src/file-names.js';
import { findFileById, sessionFileUsage } from '../src/repository.js';
import { removeTempDir } from './temp.js';

/** PNG de 1x1 válido em base64: o conteúdo não é checado, só o mime declarado. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');
const SESSION = 'sessao-1';

let base: string;
let filesRoot: string;
let allowed: string;
let db: Database.Database;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-imgs-')));
  filesRoot = join(base, 'files');
  allowed = join(base, 'projeto');
  await mkdir(allowed);
  db = openDatabase(join(base, 'data.db'));
});

afterEach(async () => {
  db.close();
  await removeTempDir(base);
});

function images(allowedRoots: string[] = [allowed]): AgentImages {
  return new AgentImages({ db, filesRoot, allowedRoots, log: { warn: () => undefined } });
}

function inlinePng(data = PNG_B64): acp.ContentBlock {
  return { type: 'image', data, mimeType: 'image/png' };
}

describe('AgentImages: imagem enviada inline pelo agente', () => {
  it('grava como arquivo to_phone da sessão, nome imagem-1.png, com os bytes certos', () => {
    const info = images().store(SESSION, inlinePng());

    expect(info).toMatchObject({ name: 'imagem-1.png', mime: 'image/png', size: PNG_BYTES.length });
    const record = findFileById(db, info?.fileId ?? '');
    expect(record).toMatchObject({ sessionId: SESSION, direction: 'to_phone', name: 'imagem-1.png' });
  });

  it('o arquivo fica em <files>/<sessão>/ com o conteúdo original', async () => {
    const info = images().store(SESSION, inlinePng());
    const record = findFileById(db, info?.fileId ?? '');

    expect(record?.path.startsWith(join(filesRoot, SESSION))).toBe(true);
    expect(await readFile(record?.path ?? '')).toEqual(PNG_BYTES);
  });

  it('mesmo conteúdo de novo na mesma sessão: devolve o mesmo arquivo, sem linha nova', () => {
    const store = images();
    const first = store.store(SESSION, inlinePng());
    const again = store.store(SESSION, inlinePng());

    expect(again).toEqual(first);
    expect(sessionFileUsage(db, SESSION).count).toBe(1);
  });

  it('conteúdo diferente vira imagem-2', () => {
    const store = images();
    store.store(SESSION, inlinePng());
    const second = store.store(SESSION, inlinePng(Buffer.from('outra imagem').toString('base64')));

    expect(second).toMatchObject({ name: 'imagem-2.png' });
    expect(sessionFileUsage(db, SESSION).count).toBe(2);
  });

  it('o mesmo conteúdo em outra sessão não é deduplicado entre sessões', () => {
    const store = images();
    const first = store.store(SESSION, inlinePng());
    const other = store.store('sessao-2', inlinePng());

    expect(other?.fileId).not.toBe(first?.fileId);
  });

  it('jpeg vira imagem-1.jpg; gif e webp mantêm a extensão', () => {
    const store = images();
    const jpeg = store.store(SESSION, { type: 'image', data: PNG_B64, mimeType: 'image/jpeg' });
    const gif = store.store(SESSION, { type: 'image', data: Buffer.from('gif').toString('base64'), mimeType: 'image/gif' });
    const webp = store.store(SESSION, { type: 'image', data: Buffer.from('webp').toString('base64'), mimeType: 'image/webp' });

    expect([jpeg?.name, gif?.name, webp?.name]).toEqual(['imagem-1.jpg', 'imagem-2.gif', 'imagem-3.webp']);
  });

  it('mime que não é raster (svg, bmp) é recusado e nada é gravado', () => {
    const store = images();
    expect(store.store(SESSION, { type: 'image', data: PNG_B64, mimeType: 'image/svg+xml' })).toBeUndefined();
    expect(store.store(SESSION, { type: 'image', data: PNG_B64, mimeType: 'image/bmp' })).toBeUndefined();
    expect(sessionFileUsage(db, SESSION).count).toBe(0);
  });

  it('imagem acima de 50 MiB é recusada', () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
    expect(images().store(SESSION, inlinePng(big))).toBeUndefined();
    expect(sessionFileUsage(db, SESSION).count).toBe(0);
  });

  it('bloco que não é imagem (áudio, texto) não é gravado', () => {
    const store = images();
    expect(store.store(SESSION, { type: 'audio', data: PNG_B64, mimeType: 'audio/wav' })).toBeUndefined();
    expect(store.store(SESSION, { type: 'text', text: 'oi' })).toBeUndefined();
    expect(sessionFileUsage(db, SESSION).count).toBe(0);
  });
});

describe('AgentImages: resource_link e resource apontando para arquivo', () => {
  it('file:// de imagem dentro das raízes permitidas é copiado para a sessão', async () => {
    const file = join(allowed, 'teste.png');
    await writeFile(file, PNG_BYTES);

    const info = images().store(SESSION, {
      type: 'resource_link',
      name: 'teste.png',
      uri: pathToFileURL(file).href,
      mimeType: 'image/png',
    });

    expect(info).toMatchObject({ name: 'imagem-1.png', mime: 'image/png', size: PNG_BYTES.length });
    expect(await readFile(findFileById(db, info?.fileId ?? '')?.path ?? '')).toEqual(PNG_BYTES);
  });

  it('resource embutido com file:// também vale', async () => {
    const file = join(allowed, 'b.png');
    await writeFile(file, PNG_BYTES);

    const info = images().store(SESSION, {
      type: 'resource',
      resource: { uri: pathToFileURL(file).href, mimeType: 'image/png', text: '' },
    });
    expect(info).toBeDefined();
  });

  it('arquivo fora das raízes permitidas é ignorado (nada copiado)', async () => {
    const outside = join(base, 'segredo.png');
    await writeFile(outside, PNG_BYTES);

    const info = images().store(SESSION, {
      type: 'resource_link',
      name: 'segredo.png',
      uri: pathToFileURL(outside).href,
      mimeType: 'image/png',
    });

    expect(info).toBeUndefined();
    expect(sessionFileUsage(db, SESSION).count).toBe(0);
  });

  it('caminho com .. que sai da raiz é ignorado', async () => {
    const outside = join(base, 'fora.png');
    await writeFile(outside, PNG_BYTES);
    const sneaky = pathToFileURL(join(allowed, '..', 'fora.png')).href;

    expect(images().store(SESSION, { type: 'resource_link', name: 'fora.png', uri: sneaky, mimeType: 'image/png' })).toBeUndefined();
  });

  it('uri que não é file:// (https, caminho solto) é ignorada', () => {
    const store = images();
    expect(store.store(SESSION, { type: 'resource_link', name: 'a', uri: 'https://exemplo.com/a.png', mimeType: 'image/png' })).toBeUndefined();
    expect(store.store(SESSION, { type: 'resource_link', name: 'a', uri: 'C:\\x\\a.png', mimeType: 'image/png' })).toBeUndefined();
  });

  it('file:// de mime não-raster ou sem mime é ignorado', async () => {
    const file = join(allowed, 'doc.pdf');
    await writeFile(file, PNG_BYTES);
    const store = images();
    expect(store.store(SESSION, { type: 'resource_link', name: 'doc.pdf', uri: pathToFileURL(file).href, mimeType: 'application/pdf' })).toBeUndefined();
    expect(store.store(SESSION, { type: 'resource_link', name: 'doc.pdf', uri: pathToFileURL(file).href })).toBeUndefined();
  });

  it('arquivo que não existe é ignorado sem lançar', () => {
    const missing = pathToFileURL(join(allowed, 'nao-existe.png')).href;
    expect(images().store(SESSION, { type: 'resource_link', name: 'x', uri: missing, mimeType: 'image/png' })).toBeUndefined();
  });

  it('mesmo arquivo copiado duas vezes na sessão não duplica', async () => {
    const file = join(allowed, 'teste.png');
    await writeFile(file, PNG_BYTES);
    const link: acp.ContentBlock = { type: 'resource_link', name: 'teste.png', uri: pathToFileURL(file).href, mimeType: 'image/png' };

    const store = images();
    const first = store.store(SESSION, link);
    expect(store.store(SESSION, link)).toEqual(first);
    expect(sessionFileUsage(db, SESSION).count).toBe(1);
    expect(await readdir(join(filesRoot, SESSION))).toHaveLength(1);
  });
});
