import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateVapid, VAPID_SUBJECT } from '../src/vapid.js';
import { removeTempDir } from './temp.js';

let home: string;
let file: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nanachi-vapid-'));
  file = join(home, 'vapid.json');
});

afterEach(async () => {
  await removeTempDir(home);
});

function decoded(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

describe('loadOrCreateVapid', () => {
  it('sem vapid.json: gera o par P-256, grava o arquivo e devolve o mesmo conteúdo', async () => {
    const vapid = loadOrCreateVapid(home);

    expect(vapid.subject).toBe('mailto:nanachi@localhost');
    expect(VAPID_SUBJECT).toBe('mailto:nanachi@localhost');
    expect(decoded(vapid.publicKey)).toHaveLength(65);
    expect(decoded(vapid.publicKey)[0]).toBe(0x04);
    expect(decoded(vapid.privateKey)).toHaveLength(32);

    const written: unknown = JSON.parse(await readFile(file, 'utf8'));
    expect(written).toEqual(vapid);
  });

  it('com vapid.json: carrega as mesmas chaves sem gerar outras', async () => {
    const first = loadOrCreateVapid(home);
    const before = await readFile(file, 'utf8');

    const second = loadOrCreateVapid(home);

    expect(second).toEqual(first);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('aceita BOM UTF-8 no começo do arquivo (PowerShell 5.1 grava assim)', async () => {
    const generated = loadOrCreateVapid(home);
    await writeFile(file, `﻿${JSON.stringify(generated, null, 2)}`, 'utf8');

    expect(loadOrCreateVapid(home)).toEqual(generated);
  });

  it('a chave gerada é aceita pelo web-push para montar o cabeçalho VAPID', () => {
    const vapid = loadOrCreateVapid(home);

    const headers = webpush.getVapidHeaders(
      'https://fcm.googleapis.com',
      vapid.subject,
      vapid.publicKey,
      vapid.privateKey,
      'aes128gcm',
    );

    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/);
  });

  it.each([
    ['JSON quebrado', '{ "publicKey": '],
    [
      'chave pública com tamanho errado',
      JSON.stringify({ publicKey: 'AAAA', privateKey: 'x'.repeat(43), subject: VAPID_SUBJECT }),
    ],
    [
      'chave privada com tamanho errado',
      JSON.stringify({ publicKey: 'B'.repeat(87), privateKey: 'AAAA', subject: VAPID_SUBJECT }),
    ],
    [
      'subject sem mailto: ou https:',
      JSON.stringify({ publicKey: 'B'.repeat(87), privateKey: 'x'.repeat(43), subject: 'mmm@x' }),
    ],
    ['campo faltando', JSON.stringify({ publicKey: 'B'.repeat(87), subject: VAPID_SUBJECT })],
  ])('vapid.json inválido (%s) lança erro citando o arquivo e não o sobrescreve', async (_label, content) => {
    await writeFile(file, content, 'utf8');

    expect(() => loadOrCreateVapid(home)).toThrow(/vapid\.json inválido/);
    expect(await readFile(file, 'utf8')).toBe(content);
  });
});
