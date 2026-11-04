import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { PairResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIO } from '../src/cli.js';
import { loadOrCreateVapid } from '../src/vapid.js';
import { setupDaemonTests, type TestDaemon } from './support.js';

const env = setupDaemonTests();

function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

/** Código gravado pelo último `pair`, lido do banco para não depender do texto impresso. */
function latestCode(db: Database.Database): string {
  const row = db.prepare<[], { code: string }>('SELECT code FROM pair_codes ORDER BY expires_at DESC LIMIT 1').get();
  if (row === undefined) throw new Error('nenhum código de pareamento');
  return row.code;
}

async function pairWithCli(daemon: TestDaemon, deviceName: string): Promise<PairResponse> {
  expect(await runCli(['pair'], { NANACHI_HOME: env.home }, captureIO().io)).toBe(0);
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: latestCode(daemon.db), deviceName },
  });
  expect(res.statusCode).toBe(200);
  return res.json<PairResponse>();
}

describe('CLI', () => {
  it('pair imprime um código de 6 dígitos que o POST /api/pair aceita', async () => {
    const cli = captureIO();
    expect(await runCli(['pair'], { NANACHI_HOME: env.home }, cli.io)).toBe(0);

    const code = cli.out.join('\n').match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeDefined();

    const daemon = await env.start();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { code, deviceName: 'iPhone' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('devices lista os dispositivos sem expor hash ou token', async () => {
    const daemon = await env.start();
    const paired = await pairWithCli(daemon, 'iPhone do João');

    const cli = captureIO();
    expect(await runCli(['devices'], { NANACHI_HOME: env.home }, cli.io)).toBe(0);
    const output = cli.out.join('\n');
    expect(output).toContain(paired.deviceId);
    expect(output).toContain('iPhone do João');
    expect(output).not.toMatch(/[0-9a-f]{64}/);
    expect(output).not.toContain(paired.token);
  });

  it('revoke <id> invalida o token do dispositivo', async () => {
    const daemon = await env.start();
    const paired = await pairWithCli(daemon, 'iPhone');
    const headers = { authorization: `Bearer ${paired.token}` };
    expect((await daemon.app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(200);

    expect(await runCli(['revoke', paired.deviceId], { NANACHI_HOME: env.home }, captureIO().io)).toBe(0);

    expect((await daemon.app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(401);
  });

  it('revoke de id inexistente sai com 1; sem id sai com 2', async () => {
    expect(await runCli(['revoke', 'nao-existe'], { NANACHI_HOME: env.home }, captureIO().io)).toBe(1);
    expect(await runCli(['revoke'], { NANACHI_HOME: env.home }, captureIO().io)).toBe(2);
  });

  it('comando desconhecido sai com 2 e mostra o uso', async () => {
    const cli = captureIO();
    expect(await runCli(['nope'], { NANACHI_HOME: env.home }, cli.io)).toBe(2);
    expect(cli.err.join('\n')).toMatch(/pair/);
  });

  it('vapid show imprime o caminho do vapid.json e a chave pública que o PWA usa', async () => {
    const cli = captureIO();
    expect(await runCli(['vapid', 'show'], { NANACHI_HOME: env.home }, cli.io)).toBe(0);

    const publicKey = loadOrCreateVapid(env.home).publicKey;
    expect(cli.out).toEqual([`Arquivo: ${join(env.home, 'vapid.json')}`, `Chave pública: ${publicKey}`]);
  });

  it('vapid sem "show" sai com 2 e mostra o uso', async () => {
    const cli = captureIO();
    expect(await runCli(['vapid'], { NANACHI_HOME: env.home }, cli.io)).toBe(2);
    expect(cli.err.join('\n')).toMatch(/vapid show/);
  });

  it('autostart sem ação ou com ação desconhecida sai com 2', async () => {
    const cli = captureIO();
    expect(await runCli(['autostart'], { NANACHI_HOME: env.home }, cli.io)).toBe(2);
    expect(await runCli(['autostart', 'reiniciar'], { NANACHI_HOME: env.home }, cli.io)).toBe(2);
    expect(cli.err.join('\n')).toMatch(/autostart install/);
  });

  it('autostart status é só leitura: sai com 0 e diz se o atalho da pasta Inicializar existe', async () => {
    const cli = captureIO();
    const appData = join(env.home, 'appdata');
    expect(await runCli(['autostart', 'status'], { NANACHI_HOME: env.home, APPDATA: appData }, cli.io)).toBe(0);
    expect(cli.out.join('\n')).toMatch(/Início automático.*não instalado/);
    expect(cli.out.join('\n')).toMatch(/Supervisor: parado/);
  });
});
