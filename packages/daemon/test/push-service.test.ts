import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import webpush, { type PushSubscription, type RequestOptions } from 'web-push';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { LiveConnections } from '../src/live-connections.js';
import { createPushNotifier } from '../src/push.js';
import { insertDevice, insertSession, insertWorkspace, upsertPushSubscription } from '../src/repository.js';
import { loadOrCreateVapid } from '../src/vapid.js';
import { removeTempDir } from './temp.js';

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let dir: string;
let db: Database.Database;
let service: Server;
let base: string;
const received: Received[] = [];
/** Status que o serviço de push responde, por caminho. Padrão: 201. */
const statusByPath: Record<string, number> = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-push-service-'));
  db = openDatabase(join(dir, 'data.db'));
  received.length = 0;
  for (const key of Object.keys(statusByPath)) delete statusByPath[key];

  service = createServer((request, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.statusCode = statusByPath[request.url ?? ''] ?? 201;
      response.end();
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => service.close(() => resolve()));
  db.close();
  await removeTempDir(dir);
});

/**
 * web-push só fala HTTPS (https.request). O serviço de teste é HTTP puro: o agente abre um socket TCP simples
 * no lugar do TLS. Só o transporte muda; cabeçalhos e corpo são os do próprio sendNotification.
 */
function plaintextAgent(): https.Agent {
  const agent = new https.Agent();
  agent.createConnection = (options) => net.connect({ host: options.host ?? undefined, port: Number(options.port) });
  return agent;
}

const plainSend = (subscription: PushSubscription, payload: string | undefined, options: RequestOptions | undefined) =>
  webpush.sendNotification(subscription, payload, { ...options, agent: plaintextAgent() });

/** Assinatura real: chave P-256 de verdade e auth de 16 bytes (o web-push cifra o corpo com elas). */
function subscriptionAt(path: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `${base}${path}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

function seedSessionWithSubscription(path: string): { sessionId: string; workspaceId: string } {
  const workspaceId = 'ws-1';
  const sessionId = 's-1';
  insertWorkspace(db, { id: workspaceId, name: 'nanachi', path: join(dir, 'proj'), createdAt: 1, muted: false });
  insertSession(db, { id: sessionId, workspaceId, agent: 'omp', title: 'Refatorar login', status: 'idle', createdAt: 1 });
  insertDevice(db, { id: 'd1', name: 'iPhone', tokenHash: 'h1', createdAt: 1 });
  const sub = subscriptionAt(path);
  upsertPushSubscription(db, { endpoint: sub.endpoint, deviceId: 'd1', keys: sub.keys, createdAt: 1 });
  return { sessionId, workspaceId };
}

describe('Web Push contra um serviço HTTP local', () => {
  it('chega um POST com cabeçalhos de Web Push: VAPID, aes128gcm, TTL e urgência; corpo cifrado', async () => {
    const vapid = loadOrCreateVapid(dir);
    const { sessionId } = seedSessionWithSubscription('/push/ok');
    const notifier = createPushNotifier({
      db,
      machineId: 'machine-1',
      vapid,
      connections: new LiveConnections(),
      send: plainSend,
      warn: () => undefined,
    });

    await notifier.notify(sessionId, 'permission_request', {
      seq: 1,
      sessionId,
      ts: 1,
      kind: 'permission_request',
      requestId: 'r1',
      title: 'Executar comando',
      content: [],
      options: [{ optionId: 'allow', name: 'Permitir', kind: 'allow_once' }],
    });

    expect(received).toHaveLength(1);
    const call = received[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/push/ok');
    expect(call?.headers.authorization).toMatch(/^vapid t=[^,]+, k=/);
    expect(call?.headers.authorization).toContain(`k=${vapid.publicKey}`);
    expect(call?.headers['content-encoding']).toBe('aes128gcm');
    expect(call?.headers.ttl).toBe('3600');
    expect(call?.headers.urgency).toBe('high');
    expect(call?.body.length).toBeGreaterThan(0);
    expect(call?.body.toString('utf8')).not.toContain('Executar comando');
  });

  it('410 do serviço apaga a inscrição', async () => {
    const vapid = loadOrCreateVapid(dir);
    const { sessionId } = seedSessionWithSubscription('/push/gone');
    statusByPath['/push/gone'] = 410;
    const notifier = createPushNotifier({
      db,
      machineId: 'machine-1',
      vapid,
      connections: new LiveConnections(),
      send: plainSend,
      warn: () => undefined,
    });

    await notifier.notify(sessionId, 'turn_end', {
      seq: 2,
      sessionId,
      ts: 1,
      kind: 'turn_end',
      stopReason: 'end_turn',
    });

    expect(received).toHaveLength(1);
    expect(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions').get()?.n).toBe(0);
  });
});
