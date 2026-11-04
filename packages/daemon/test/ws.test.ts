import { parseServerMessage } from '@nanachi/shared';
import type { PairResponse } from '@nanachi/shared';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { revokeDevice } from '../src/repository.js';
import { setupDaemonTests, issueCode, type TestDaemon } from './support.js';

const env = setupDaemonTests();

interface TestSocket {
  ws: WebSocket;
  closed: Promise<number>;
  nextMessage(): Promise<string>;
}

/**
 * Sobe o daemon numa porta efêmera e conecta com o cliente `ws` de verdade.
 * (app.injectWS perde frames que chegam junto do 101, então não serve para close codes.)
 */
async function openSocket(daemon: TestDaemon, path: string): Promise<TestSocket> {
  const base = (await daemon.app.listen({ host: '127.0.0.1', port: 0 })).replace(/^http/, 'ws');
  const ws = new WebSocket(`${base}${path}`);

  const queue: string[] = [];
  const waiters: Array<(message: string) => void> = [];
  ws.on('message', (data) => {
    const text = data.toString();
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(text);
    else queue.push(text);
  });

  const closed = new Promise<number>((resolve) => {
    ws.on('close', (code) => resolve(code));
  });

  return {
    ws,
    closed,
    nextMessage: () => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function pairToken(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: issueCode(daemon), deviceName: 'iPhone' },
  });
  return res.json<PairResponse>().token;
}

async function deviceIdOf(daemon: TestDaemon, token: string): Promise<string> {
  const res = await daemon.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
  return res.json<{ deviceId: string }>().deviceId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WS /ws', () => {
  it('com token válido envia hello com a identidade da máquina ao conectar', async () => {
    const daemon = await env.start();
    const token = await pairToken(daemon);
    const socket = await openSocket(daemon, `/ws?token=${token}`);

    const hello = parseServerMessage(await socket.nextMessage());
    expect(hello).toEqual({
      ok: true,
      value: { type: 'hello', machineId: daemon.machine.id, machineName: daemon.config.machineName },
    });
    socket.ws.close();
  });

  it('ping → pong', async () => {
    const daemon = await env.start();
    const token = await pairToken(daemon);
    const socket = await openSocket(daemon, `/ws?token=${token}`);

    await socket.nextMessage(); // hello
    socket.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await socket.nextMessage()).toBe(JSON.stringify({ type: 'pong' }));
    socket.ws.close();
  });

  it('mensagem inválida é ignorada e a conexão continua funcionando', async () => {
    const daemon = await env.start();
    const token = await pairToken(daemon);
    const socket = await openSocket(daemon, `/ws?token=${token}`);

    await socket.nextMessage(); // hello
    socket.ws.send('isto não é json');
    socket.ws.send(JSON.stringify({ type: 'nao-existe' }));
    socket.ws.send(JSON.stringify({ type: 'ping' }));

    expect(await socket.nextMessage()).toBe(JSON.stringify({ type: 'pong' }));
    socket.ws.close();
  });

  it('token inválido fecha com code 4401', async () => {
    const daemon = await env.start();
    const socket = await openSocket(daemon, '/ws?token=nao-existe');
    expect(await socket.closed).toBe(4401);
  });

  it('sem token fecha com code 4401', async () => {
    const daemon = await env.start();
    const socket = await openSocket(daemon, '/ws');
    expect(await socket.closed).toBe(4401);
  });

  it('token de dispositivo revogado fecha com code 4401', async () => {
    const daemon = await env.start();
    const token = await pairToken(daemon);
    const me = await daemon.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    const deviceId = me.json<{ deviceId: string }>().deviceId;
    daemon.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), deviceId);

    const socket = await openSocket(daemon, `/ws?token=${token}`);
    expect(await socket.closed).toBe(4401);
  });

  it('revogar o dispositivo com o WS aberto fecha com 4401 na próxima mensagem, sem pong', async () => {
    const daemon = await env.start();
    const token = await pairToken(daemon);
    const socket = await openSocket(daemon, `/ws?token=${token}`);
    await socket.nextMessage(); // hello

    revokeDevice(daemon.db, await deviceIdOf(daemon, token), Date.now());
    socket.ws.send(JSON.stringify({ type: 'ping' }));

    expect(await socket.closed).toBe(4401);
  });

  it('revogação derruba o WS sem nenhuma mensagem, pelo revalidador periódico', async () => {
    const daemon = await env.start({ wsRevalidateMs: 50 });
    const token = await pairToken(daemon);
    const socket = await openSocket(daemon, `/ws?token=${token}`);
    await socket.nextMessage(); // hello

    revokeDevice(daemon.db, await deviceIdOf(daemon, token), Date.now());

    expect(await socket.closed).toBe(4401);
  });

  it('dispositivo ativo continua conectado enquanto o revalidador roda', async () => {
    const daemon = await env.start({ wsRevalidateMs: 20 });
    const token = await pairToken(daemon);
    const socket = await openSocket(daemon, `/ws?token=${token}`);
    await socket.nextMessage(); // hello

    await delay(150);
    socket.ws.send(JSON.stringify({ type: 'ping' }));

    expect(await socket.nextMessage()).toBe(JSON.stringify({ type: 'pong' }));
    socket.ws.close();
  });

  it('mensagem até 1 MiB passa; acima disso o socket cai (maxPayload)', async () => {
    const daemon = await env.start();
    const token = await pairToken(daemon);
    const socket = await openSocket(daemon, `/ws?token=${token}`);
    await socket.nextMessage(); // hello

    socket.ws.send(JSON.stringify({ type: 'ping', padding: 'x'.repeat(900_000) }));
    expect(await socket.nextMessage()).toBe(JSON.stringify({ type: 'pong' }));

    socket.ws.send('x'.repeat(1_048_577));
    // O ws derruba a conexão ao estourar maxPayload; o cliente pode ver 1009 ou 1006 (queda antes do close frame).
    const outcome = await Promise.race([socket.closed, delay(3_000).then(() => 'aberta')]);
    expect([1006, 1009]).toContain(outcome);
  });

  it('checagem Tailscale recusa o upgrade com 403 antes de abrir o socket', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: ['joao@exemplo.com'] } });
    const token = await pairToken(daemon);

    await expect(daemon.app.injectWS(`/ws?token=${token}`, { headers: { host: 'localhost' } })).rejects.toThrow('403');

    const accepted = await daemon.app.injectWS(`/ws?token=${token}`, {
      headers: { host: 'localhost', 'tailscale-user-login': 'joao@exemplo.com' },
    });
    accepted.close();
  });
});
