import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PairResponse, PushKeyResponse } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIO } from '../src/cli.js';
import { loadOrCreateVapid } from '../src/vapid.js';
import { listen, WsTestClient } from './agent-support.js';
import { issueCode, setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nanachi-push-routes-'));
});

afterEach(async () => {
  await removeTempDir(home);
});

const env = setupDaemonTests();

const silent: CliIO = { out: () => undefined, err: () => undefined };

/** Assinatura no formato que o navegador entrega: endpoint + chave P-256 (p256dh) e auth de 16 bytes. */
function subscriptionFor(name: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${randomBytes(8).toString('hex')}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

interface PairedDevice extends PairResponse {
  headers: { authorization: string };
}

async function pairDevice(daemon: TestDaemon, deviceName: string): Promise<PairedDevice> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: issueCode(daemon), deviceName },
  });
  const paired = res.json<PairResponse>();
  return { ...paired, headers: { authorization: `Bearer ${paired.token}` } };
}

function rowCount(daemon: TestDaemon, endpoint?: string): number {
  if (endpoint === undefined) {
    return daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions').get()?.n ?? 0;
  }
  return (
    daemon.db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?')
      .get(endpoint)?.n ?? 0
  );
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condição não ocorreu a tempo');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('GET /api/push/key', () => {
  it('devolve a chave pública do vapid.json; sem Bearer → 401', async () => {
    const daemon = await env.start();
    const { headers } = await pairDevice(daemon, 'iPhone');
    const vapid = loadOrCreateVapid(env.home);

    const res = await daemon.app.inject({ method: 'GET', url: '/api/push/key', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json<PushKeyResponse>()).toEqual({ publicKey: vapid.publicKey });

    const anon = await daemon.app.inject({ method: 'GET', url: '/api/push/key' });
    expect(anon.statusCode).toBe(401);
  });
});

describe('POST /api/push/subscribe', () => {
  it('grava a inscrição associada ao device do token; repetir o mesmo endpoint faz upsert', async () => {
    const daemon = await env.start();
    const { headers, deviceId } = await pairDevice(daemon, 'iPhone');
    const sub = subscriptionFor('a');

    const first = await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: sub });
    expect(first.statusCode).toBe(204);

    const renewed = { ...sub, keys: { p256dh: sub.keys.p256dh, auth: randomBytes(16).toString('base64url') } };
    const second = await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: renewed });
    expect(second.statusCode).toBe(204);

    expect(rowCount(daemon, sub.endpoint)).toBe(1);
    expect(rowCount(daemon)).toBe(1);
    const row = daemon.db
      .prepare<[string], { device_id: string; keys: string }>(
        'SELECT device_id, keys FROM push_subscriptions WHERE endpoint = ?',
      )
      .get(sub.endpoint);
    expect(row).toEqual({ device_id: deviceId, keys: JSON.stringify(renewed.keys) });
  });

  it('corpo inválido (sem keys, endpoint não-URL) → 400; sem Bearer → 401', async () => {
    const daemon = await env.start();
    const { headers } = await pairDevice(daemon, 'iPhone');

    const noKeys = await daemon.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers,
      payload: { endpoint: 'https://fcm.googleapis.com/x' },
    });
    expect(noKeys.statusCode).toBe(400);

    const badUrl = await daemon.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers,
      payload: { endpoint: 'nao-e-url', keys: { p256dh: 'a', auth: 'b' } },
    });
    expect(badUrl.statusCode).toBe(400);

    const anon = await daemon.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: subscriptionFor('x'),
    });
    expect(anon.statusCode).toBe(401);
    expect(rowCount(daemon)).toBe(0);
  });
});

describe('POST /api/push/subscribe: endpoint de serviço de push conhecido', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/abc',
    'https://xx-1.push.apple.com/abc',
  ])('aceita %s', async (endpoint) => {
    const daemon = await env.start();
    const { headers } = await pairDevice(daemon, 'iPhone');
    const sub = subscriptionFor('ok');

    const res = await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: { ...sub, endpoint } });

    expect(res.statusCode).toBe(204);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://evil.example/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/abc',
    'https://evilnotify.windows.com/abc',
    'https://notify.windows.com/abc',
    'https://push.apple.com/abc',
    'http://127.0.0.1:7777/api/health',
    'file:///etc/passwd',
  ])('recusa %s com 400 bad_push_endpoint e não grava', async (endpoint) => {
    const daemon = await env.start();
    const { headers } = await pairDevice(daemon, 'iPhone');
    const sub = subscriptionFor('bad');

    const res = await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: { ...sub, endpoint } });

    expect(res.statusCode).toBe(400);
    expect(res.json<unknown>()).toEqual({ error: 'bad_push_endpoint' });
    expect(rowCount(daemon)).toBe(0);
  });

  it('endpoint que já pertence a outro device → 409 e a inscrição continua do dono', async () => {
    const daemon = await env.start();
    const owner = await pairDevice(daemon, 'iPhone');
    const intruder = await pairDevice(daemon, 'iPad');
    const sub = subscriptionFor('taken');
    expect((await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: owner.headers, payload: sub })).statusCode).toBe(204);

    const res = await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: intruder.headers, payload: sub });

    expect(res.statusCode).toBe(409);
    expect(res.json<unknown>()).toEqual({ error: 'endpoint_in_use' });
    const row = daemon.db
      .prepare<[string], { device_id: string }>('SELECT device_id FROM push_subscriptions WHERE endpoint = ?')
      .get(sub.endpoint);
    expect(row).toEqual({ device_id: owner.deviceId });
  });
});

describe('DELETE /api/push/subscribe', () => {
  it('apaga a inscrição do próprio device (204)', async () => {
    const daemon = await env.start();
    const { headers } = await pairDevice(daemon, 'iPhone');
    const sub = subscriptionFor('own');
    await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: sub });

    const res = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      headers,
      payload: { endpoint: sub.endpoint },
    });

    expect(res.statusCode).toBe(204);
    expect(rowCount(daemon, sub.endpoint)).toBe(0);
  });

  it('não apaga inscrição de outro device: 404 e a linha continua', async () => {
    const daemon = await env.start();
    const owner = await pairDevice(daemon, 'iPhone');
    const other = await pairDevice(daemon, 'iPad');
    const sub = subscriptionFor('owned');
    await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: owner.headers, payload: sub });

    const res = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      headers: other.headers,
      payload: { endpoint: sub.endpoint },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<unknown>()).toEqual({ error: 'not_found' });
    expect(rowCount(daemon, sub.endpoint)).toBe(1);
  });

  it('endpoint inexistente → 404; corpo inválido → 400; sem Bearer → 401', async () => {
    const daemon = await env.start();
    const { headers } = await pairDevice(daemon, 'iPhone');

    const missing = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      headers,
      payload: { endpoint: 'https://fcm.googleapis.com/nao-existe' },
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      headers,
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);

    const anon = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      payload: { endpoint: 'https://fcm.googleapis.com/x' },
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('revoke apaga as inscrições do device', () => {
  it('revoke remove as inscrições dele e deixa as dos outros devices', async () => {
    const daemon = await env.start();
    const revoked = await pairDevice(daemon, 'iPhone velho');
    const kept = await pairDevice(daemon, 'iPhone novo');
    const gone = subscriptionFor('gone');
    const stays = subscriptionFor('stays');
    await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: revoked.headers, payload: gone });
    await daemon.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: kept.headers, payload: stays });

    expect(await runCli(['revoke', revoked.deviceId], { NANACHI_HOME: env.home }, silent)).toBe(0);

    expect(rowCount(daemon, gone.endpoint)).toBe(0);
    expect(rowCount(daemon, stays.endpoint)).toBe(1);
  });
});

describe('conexões WS vivas por device', () => {
  it('hasLiveConnection é true enquanto o WS do device está aberto', async () => {
    const daemon = await env.start();
    const paired = await pairDevice(daemon, 'iPhone');
    expect(daemon.connections.hasLiveConnection(paired.deviceId)).toBe(false);

    const client = await WsTestClient.connect(await listen(daemon), paired.token);
    expect(daemon.connections.hasLiveConnection(paired.deviceId)).toBe(true);

    await client.close();
    await waitFor(() => !daemon.connections.hasLiveConnection(paired.deviceId));
  });
});
