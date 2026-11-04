import { DevicesResponseSchema, type DevicesResponse, type MeResponse, type PairResponse } from '@nanachi/shared';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { listPushSubscriptions, upsertPushSubscription } from '../src/repository.js';
import { listen } from './agent-support.js';
import { issueCode, setupDaemonTests, type TestDaemon } from './support.js';

const env = setupDaemonTests();

/** Pareia um device com o nome dado e devolve o token e o id dele. */
async function pairDevice(daemon: TestDaemon, name: string): Promise<{ token: string; id: string }> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: issueCode(daemon), deviceName: name },
  });
  const token = res.json<PairResponse>().token;
  const me = await daemon.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
  return { token, id: me.json<MeResponse>().deviceId };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Abre o WS com o token e resolve com o código de fechamento quando o servidor fechar. */
function openAndWaitClose(base: string, token: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?token=${token}`);
    const closed = new Promise<number>((done) => ws.once('close', (code) => done(code)));
    ws.once('open', () => resolve({ ws, closed }));
    ws.once('error', reject);
  });
}

describe('GET /api/devices', () => {
  it('lista os devices ativos e marca o que fez a chamada', async () => {
    const daemon = await env.start();
    const mine = await pairDevice(daemon, 'iPhone');
    const other = await pairDevice(daemon, 'iPad');

    const res = await daemon.app.inject({ method: 'GET', url: '/api/devices', headers: bearer(mine.token) });

    expect(res.statusCode).toBe(200);
    const body = DevicesResponseSchema.parse(res.json<unknown>());
    expect(body.devices.map((device) => [device.id, device.current]).sort()).toEqual(
      [
        [mine.id, true],
        [other.id, false],
      ].sort(),
    );
    expect(body.devices.every((device) => device.lastSeenAt === null || typeof device.lastSeenAt === 'number')).toBe(true);
  });

  it('não lista os revogados', async () => {
    const daemon = await env.start();
    const mine = await pairDevice(daemon, 'iPhone');
    const gone = await pairDevice(daemon, 'iPad');
    await daemon.app.inject({ method: 'DELETE', url: `/api/devices/${gone.id}`, headers: bearer(mine.token) });

    const res = await daemon.app.inject({ method: 'GET', url: '/api/devices', headers: bearer(mine.token) });

    expect(res.json<DevicesResponse>().devices.map((device) => device.id)).toEqual([mine.id]);
  });

  it('sem Bearer → 401', async () => {
    const daemon = await env.start();
    expect((await daemon.app.inject({ method: 'GET', url: '/api/devices' })).statusCode).toBe(401);
  });
});

describe('DELETE /api/devices/:id', () => {
  it('revoga: o token do device passa a dar 401 e some da lista', async () => {
    const daemon = await env.start();
    const mine = await pairDevice(daemon, 'iPhone');
    const other = await pairDevice(daemon, 'iPad');

    const res = await daemon.app.inject({ method: 'DELETE', url: `/api/devices/${other.id}`, headers: bearer(mine.token) });

    expect(res.statusCode).toBe(204);
    expect((await daemon.app.inject({ method: 'GET', url: '/api/me', headers: bearer(other.token) })).statusCode).toBe(401);
    const list = await daemon.app.inject({ method: 'GET', url: '/api/devices', headers: bearer(mine.token) });
    expect(list.json<DevicesResponse>().devices.map((device) => device.id)).toEqual([mine.id]);
  });

  it('apaga as inscrições de push do device revogado e deixa as dos outros', async () => {
    const daemon = await env.start();
    const mine = await pairDevice(daemon, 'iPhone');
    const other = await pairDevice(daemon, 'iPad');
    const keys = { p256dh: 'chave', auth: 'segredo' };
    upsertPushSubscription(daemon.db, { endpoint: 'https://push.test/gone', deviceId: other.id, keys, createdAt: 1 });
    upsertPushSubscription(daemon.db, { endpoint: 'https://push.test/stays', deviceId: mine.id, keys, createdAt: 1 });

    await daemon.app.inject({ method: 'DELETE', url: `/api/devices/${other.id}`, headers: bearer(mine.token) });

    expect(listPushSubscriptions(daemon.db).map((row) => row.endpoint)).toEqual(['https://push.test/stays']);
  });

  it('derruba na hora o WS aberto do device revogado (4401), sem mexer nos outros', async () => {
    const daemon = await env.start();
    const base = (await listen(daemon)).replace(/^http/, 'ws');
    const mine = await pairDevice(daemon, 'iPhone');
    const other = await pairDevice(daemon, 'iPad');
    const victim = await openAndWaitClose(base, other.token);
    const bystander = await openAndWaitClose(base, mine.token);

    await daemon.app.inject({ method: 'DELETE', url: `/api/devices/${other.id}`, headers: bearer(mine.token) });

    expect(await victim.closed).toBe(4401);
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN);
    bystander.ws.close();
  });

  it('revogar o próprio device é permitido: 204, e o WS dele cai com 4401', async () => {
    const daemon = await env.start();
    const base = (await listen(daemon)).replace(/^http/, 'ws');
    const mine = await pairDevice(daemon, 'iPhone');
    const socket = await openAndWaitClose(base, mine.token);

    const res = await daemon.app.inject({ method: 'DELETE', url: `/api/devices/${mine.id}`, headers: bearer(mine.token) });

    expect(res.statusCode).toBe(204);
    expect(await socket.closed).toBe(4401);
  });

  it('id inexistente ou já revogado → 404', async () => {
    const daemon = await env.start();
    const mine = await pairDevice(daemon, 'iPhone');
    const other = await pairDevice(daemon, 'iPad');

    expect(
      (await daemon.app.inject({ method: 'DELETE', url: '/api/devices/nao-existe', headers: bearer(mine.token) })).statusCode,
    ).toBe(404);
    await daemon.app.inject({ method: 'DELETE', url: `/api/devices/${other.id}`, headers: bearer(mine.token) });
    const again = await daemon.app.inject({ method: 'DELETE', url: `/api/devices/${other.id}`, headers: bearer(mine.token) });
    expect(again.statusCode).toBe(404);
  });

  it('sem Bearer → 401 e nada é revogado', async () => {
    const daemon = await env.start();
    const mine = await pairDevice(daemon, 'iPhone');

    const res = await daemon.app.inject({ method: 'DELETE', url: `/api/devices/${mine.id}` });

    expect(res.statusCode).toBe(401);
    expect((await daemon.app.inject({ method: 'GET', url: '/api/me', headers: bearer(mine.token) })).statusCode).toBe(200);
  });
});
