import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { PairResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIO } from '../src/cli.js';
import { PAIR_CODE_TTL_MS } from '../src/pairing.js';
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

  it('pair --json imprime só {"code","expiresAt"} e o código vale no POST /api/pair', async () => {
    const before = Date.now();
    const cli = captureIO();
    expect(await runCli(['pair', '--json'], { NANACHI_HOME: env.home }, cli.io)).toBe(0);
    const after = Date.now();

    expect(cli.out).toHaveLength(1);
    expect(cli.err).toEqual([]);
    const line = cli.out[0] ?? '';
    const parsed: unknown = JSON.parse(line);
    expect(Object.keys(parsed as object)).toEqual(['code', 'expiresAt']);
    const { code, expiresAt } = parsed as { code: string; expiresAt: number };
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThanOrEqual(before + PAIR_CODE_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + PAIR_CODE_TTL_MS);
    expect(line).toBe(JSON.stringify({ code, expiresAt }));

    const daemon = await env.start();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { code, deviceName: 'Nanachi Desktop (teste)' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('pair com argumento desconhecido sai com 2 e não gera código', async () => {
    const cli = captureIO();
    expect(await runCli(['pair', '--yaml'], { NANACHI_HOME: env.home }, cli.io)).toBe(2);
    expect(cli.out).toEqual([]);
    expect(cli.err.join('\n')).toMatch(/pair \[--json\]/);
  });

  it('device add --name --json imprime só {"deviceId","token"} e o token já autentica no /api/me', async () => {
    const cli = captureIO();
    expect(await runCli(['device', 'add', '--name', 'Nanachi Desktop (PC)', '--json'], { NANACHI_HOME: env.home }, cli.io)).toBe(0);

    expect(cli.err).toEqual([]);
    expect(cli.out).toHaveLength(1);
    const line = cli.out[0] ?? '';
    const parsed: unknown = JSON.parse(line);
    expect(Object.keys(parsed as object)).toEqual(['deviceId', 'token']);
    const { deviceId, token } = parsed as { deviceId: string; token: string };
    expect(deviceId).not.toBe('');
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(line).toBe(JSON.stringify({ deviceId, token }));

    const daemon = await env.start();
    const me = await daemon.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ deviceId, deviceName: 'Nanachi Desktop (PC)' });

    // The database only holds the hash, never the token.
    const hashes = daemon.db.prepare<[], { token_hash: string }>('SELECT token_hash FROM devices').all();
    expect(hashes.map((row) => row.token_hash)).not.toContain(token);
  });

  it('device add não derruba o código de pareamento que ainda vale (é o motivo de ele existir)', async () => {
    // O usuário pediu um código e está digitando no celular.
    expect(await runCli(['pair'], { NANACHI_HOME: env.home }, captureIO().io)).toBe(0);
    const daemon = await env.start();
    const code = latestCode(daemon.db);

    // O Desktop se pareia agora: com `pair --json` isso marcaria o código acima como usado.
    expect(await runCli(['device', 'add', '--name', 'Nanachi Desktop (PC)', '--json'], { NANACHI_HOME: env.home }, captureIO().io)).toBe(0);

    const res = await daemon.app.inject({ method: 'POST', url: '/api/pair', payload: { code, deviceName: 'iPhone' } });
    expect(res.statusCode).toBe(200);
  });

  it('device add sem --json imprime uma linha legível e cria o device', async () => {
    const cli = captureIO();
    expect(await runCli(['device', 'add', '--name', 'Notebook'], { NANACHI_HOME: env.home }, cli.io)).toBe(0);
    expect(cli.out).toHaveLength(1);
    expect(cli.out[0]).toMatch(/Notebook/);

    const list = captureIO();
    expect(await runCli(['devices'], { NANACHI_HOME: env.home }, list.io)).toBe(0);
    expect(list.out.join('\n')).toContain('Notebook');
  });

  it.each([
    ['sem argumentos', ['device']],
    ['sem a ação add', ['device', 'list']],
    ['sem --name', ['device', 'add', '--json']],
    ['--name sem valor', ['device', 'add', '--name']],
    ['nome vazio', ['device', 'add', '--name', '   ', '--json']],
    ['nome com mais de 64 caracteres', ['device', 'add', '--name', 'x'.repeat(65), '--json']],
    ['nome com caractere de controle', ['device', 'add', '--name', 'a\nb', '--json']],
    ['--name repetido', ['device', 'add', '--name', 'a', '--name', 'b']],
    ['argumento desconhecido', ['device', 'add', '--name', 'a', '--yaml']],
  ])('device add %s sai com 2, mostra o uso e não cria nada', async (_label, argv) => {
    const cli = captureIO();
    expect(await runCli(argv, { NANACHI_HOME: env.home }, cli.io)).toBe(2);
    expect(cli.out).toEqual([]);
    expect(cli.err.join('\n')).toMatch(/device add --name/);

    const list = captureIO();
    expect(await runCli(['devices'], { NANACHI_HOME: env.home }, list.io)).toBe(0);
    expect(list.out).toEqual(['Nenhum dispositivo pareado.']);
  });

  it('devices lista os dispositivos sem expor hash ou token', async () => {
    const daemon = await env.start();
    const paired = await pairWithCli(daemon, 'iPhone do José');

    const cli = captureIO();
    expect(await runCli(['devices'], { NANACHI_HOME: env.home }, cli.io)).toBe(0);
    const output = cli.out.join('\n');
    expect(output).toContain(paired.deviceId);
    expect(output).toContain('iPhone do José');
    expect(output).not.toMatch(/[0-9a-f]{64}/);
    expect(output).not.toContain(paired.token);
  });

  it('devices mostra expirado o device parado além de deviceInactivityDays (padrão 90 dias)', async () => {
    const daemon = await env.start();
    const paired = await pairWithCli(daemon, 'iPad antigo');
    daemon.db
      .prepare<[number, string]>('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .run(Date.now() - 91 * 24 * 60 * 60 * 1000, paired.deviceId);

    const cli = captureIO();
    expect(await runCli(['devices'], { NANACHI_HOME: env.home }, cli.io)).toBe(0);
    expect(cli.out.join('\n')).toMatch(new RegExp(`${paired.deviceId}.*expirado`));
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
