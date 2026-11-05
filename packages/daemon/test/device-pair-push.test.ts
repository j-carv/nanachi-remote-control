import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { PushSubscription, RequestOptions } from 'web-push';
import { DevicePairedPushPayloadSchema } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createPushNotifier, type SendNotification } from '../src/push.js';
import { insertDevice, listPushSubscriptions, upsertPushSubscription } from '../src/repository.js';
import { loadOrCreateVapid } from '../src/vapid.js';
import { removeTempDir } from './temp.js';

let dir: string;
let db: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-device-push-'));
  db = openDatabase(join(dir, 'data.db'));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

/** Device com uma inscrição de push. `endpoint` identifica o aparelho nas asserções. */
function device(id: string, name: string): void {
  insertDevice(db, { id, name, tokenHash: `hash-${id}`, createdAt: 1 });
  upsertPushSubscription(db, {
    endpoint: `https://web.push.apple.com/${id}`,
    deviceId: id,
    keys: { p256dh: 'p', auth: 'a' },
    createdAt: 1,
  });
}

function notifier(options: { send?: SendNotification; live?: string[]; warn?: (...args: unknown[]) => void } = {}) {
  const vapid = loadOrCreateVapid(dir);
  const warn = vi.fn((fields: Record<string, unknown>, message: string) => options.warn?.(fields, message));
  return {
    warn,
    notifier: createPushNotifier({
      db,
      machineId: 'm-1',
      vapid,
      connections: { hasLiveConnection: (deviceId: string) => (options.live ?? []).includes(deviceId) },
      send: options.send,
      warn,
    }),
  };
}

describe('aviso de pareamento por Tailscale (Web Push)', () => {
  it('manda a todos os outros devices com inscrição, não ao novo', async () => {
    device('a', 'iPad');
    device('b', 'Mac');
    device('new', 'iPhone');
    const sent: { endpoint: string; payload: string }[] = [];
    const send: SendNotification = async (subscription: PushSubscription, payload: string, _o: RequestOptions) => {
      sent.push({ endpoint: subscription.endpoint, payload });
    };

    await notifier({ send }).notifier.notifyDevicePaired('new', 'iPhone');

    expect(sent.map((item) => item.endpoint).sort()).toEqual([
      'https://web.push.apple.com/a',
      'https://web.push.apple.com/b',
    ]);
    const payload = DevicePairedPushPayloadSchema.parse(JSON.parse(sent[0]?.payload ?? '{}'));
    expect(payload).toEqual({
      title: 'Nanachi Remote',
      body: 'Novo aparelho entrou com Tailscale: iPhone',
      machineId: 'm-1',
      kind: 'device_paired',
    });
  });

  it('manda mesmo para device com WS aberto (o app não mostra pareamento)', async () => {
    device('a', 'iPad');
    device('new', 'iPhone');
    const send = vi.fn<SendNotification>(() => Promise.resolve());

    await notifier({ send, live: ['a'] }).notifier.notifyDevicePaired('new', 'iPhone');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('falha de entrega vira aviso no log e não lança', async () => {
    device('a', 'iPad');
    device('new', 'iPhone');
    const send: SendNotification = () => Promise.reject(Object.assign(new Error('boom'), { statusCode: 500 }));
    const { notifier: push, warn } = notifier({ send });

    await expect(push.notifyDevicePaired('new', 'iPhone')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(listPushSubscriptions(db)).toHaveLength(2);
  });

  it('inscrição que o serviço devolve como 410 é apagada', async () => {
    device('a', 'iPad');
    device('new', 'iPhone');
    const send: SendNotification = () => Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 }));

    await notifier({ send }).notifier.notifyDevicePaired('new', 'iPhone');

    expect(listPushSubscriptions(db).map((row) => row.deviceId)).toEqual(['new']);
  });
});
