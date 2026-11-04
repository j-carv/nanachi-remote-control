import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushPayloadSchema } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { PushSubscription, RequestOptions } from 'web-push';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifyDetails } from '../src/notify.js';
import { openDatabase } from '../src/db.js';
import { createPushNotifier, type SendNotification } from '../src/push.js';
import {
  insertDevice,
  insertSession,
  insertWorkspace,
  upsertPushSubscription,
} from '../src/repository.js';
import { removeTempDir } from './temp.js';

const MACHINE_ID = 'machine-1';
const VAPID = {
  publicKey: 'B'.repeat(87),
  privateKey: 'x'.repeat(43),
  subject: 'mailto:nanachi@localhost',
};

let dir: string;
let db: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-push-'));
  db = openDatabase(join(dir, 'data.db'));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

interface Sent {
  endpoint: string;
  payload: string;
  options: RequestOptions;
}

/** Fake do sendNotification: grava o envio e responde com o status (ou erro) escolhido por endpoint. */
function fakeSend(outcomes: Record<string, number | Error> = {}): { send: SendNotification; sent: Sent[] } {
  const sent: Sent[] = [];
  const send: SendNotification = (subscription: PushSubscription, payload: string | undefined, options: RequestOptions | undefined) => {
    sent.push({ endpoint: subscription.endpoint, payload: payload ?? '', options: options ?? {} });
    const outcome = outcomes[subscription.endpoint];
    if (outcome instanceof Error) return Promise.reject(outcome);
    if (typeof outcome === 'number' && (outcome < 200 || outcome > 299)) {
      return Promise.reject(Object.assign(new Error('Received unexpected response code'), { statusCode: outcome }));
    }
    return Promise.resolve({ statusCode: 201, body: '', headers: {} });
  };
  return { send, sent };
}

function seedWorkspace(options: { muted?: boolean; name?: string } = {}): string {
  const id = `ws-${Math.random().toString(36).slice(2)}`;
  insertWorkspace(db, {
    id,
    name: options.name ?? 'projeto',
    path: join(dir, id),
    createdAt: 1,
    muted: options.muted ?? false,
  });
  return id;
}

function seedSession(workspaceId: string, title = 'Refatorar login'): string {
  const id = `s-${Math.random().toString(36).slice(2)}`;
  insertSession(db, { id, workspaceId, agent: 'omp', title, status: 'idle', createdAt: 1 });
  return id;
}

function seedSubscription(endpoint: string, deviceId: string): void {
  upsertPushSubscription(db, {
    endpoint,
    deviceId,
    keys: { p256dh: 'p256', auth: 'auth' },
    createdAt: 1,
  });
}

function seedDevice(id: string): void {
  insertDevice(db, { id, name: id, tokenHash: `hash-${id}`, createdAt: 1 });
}

function subscriptionsCount(): number {
  return db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions').get()?.n ?? 0;
}

const meta = { seq: 7, sessionId: 'ignored', ts: 1 } as const;

function turnEnd(): NotifyDetails {
  return { ...meta, kind: 'turn_end', stopReason: 'end_turn' };
}

function permission(title = 'Executar comando'): NotifyDetails {
  return {
    ...meta,
    kind: 'permission_request',
    requestId: 'r1',
    title,
    content: [],
    options: [{ optionId: 'allow', name: 'Permitir', kind: 'allow_once' }],
  };
}

function errorEvent(message: string): NotifyDetails {
  return { ...meta, kind: 'error', message };
}

function fileEvent(name: string): NotifyDetails {
  return {
    ...meta,
    kind: 'file',
    fileId: 'f1',
    name,
    mime: 'image/png',
    size: 3,
    direction: 'to_phone',
  };
}

function notifierWith(
  options: { send?: SendNotification; online?: string[]; warns?: Array<Record<string, unknown>>; now?: () => number } = {},
) {
  const online = new Set(options.online ?? []);
  return createPushNotifier({
    db,
    machineId: MACHINE_ID,
    vapid: VAPID,
    connections: { hasLiveConnection: (deviceId: string) => online.has(deviceId) },
    send: options.send,
    now: options.now,
    warn: (fields) => {
      options.warns?.push(fields);
    },
  });
}

describe('createPushNotifier: arquivos agrupados', () => {
  it('no máximo 1 push de arquivo por sessão a cada 60 s; os demais não geram push', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://fcm.googleapis.com/d1', 'd1');
    const { send, sent } = fakeSend();
    let clock = 1_000_000;
    const notifier = notifierWith({ send, now: () => clock });

    await notifier.notify(sessionId, 'file', fileEvent('a.png'));
    clock += 10_000;
    await notifier.notify(sessionId, 'file', fileEvent('b.png'));
    clock += 10_000;
    await notifier.notify(sessionId, 'file', fileEvent('c.png'));
    expect(sent).toHaveLength(1);

    clock += 60_000;
    await notifier.notify(sessionId, 'file', fileEvent('d.png'));
    expect(sent).toHaveLength(2);
  });

  it('a janela é por sessão: outra sessão não é segurada pela primeira', async () => {
    const workspaceId = seedWorkspace();
    const first = seedSession(workspaceId);
    const second = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://fcm.googleapis.com/d1', 'd1');
    const { send, sent } = fakeSend();
    const notifier = notifierWith({ send, now: () => 5 });

    await notifier.notify(first, 'file', fileEvent('a.png'));
    await notifier.notify(second, 'file', fileEvent('b.png'));

    expect(sent).toHaveLength(2);
  });

  it('turn_end não é afetado pela janela de arquivos', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://fcm.googleapis.com/d1', 'd1');
    const { send, sent } = fakeSend();
    const notifier = notifierWith({ send, now: () => 5 });

    await notifier.notify(sessionId, 'file', fileEvent('a.png'));
    await notifier.notify(sessionId, 'turn_end', turnEnd());

    expect(sent).toHaveLength(2);
  });
});

function parsedPayload(sent: Sent): unknown {
  return JSON.parse(sent.payload);
}

describe('createPushNotifier: payload', () => {
  it('turn_end: título = nome do workspace, body "Terminou: <título da sessão>", payload válido', async () => {
    const workspaceId = seedWorkspace({ name: 'nanachi' });
    const sessionId = seedSession(workspaceId, 'Refatorar login');
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'turn_end', turnEnd());

    expect(sent).toHaveLength(1);
    const payload = PushPayloadSchema.parse(parsedPayload(sent[0] as Sent));
    expect(payload).toEqual({
      title: 'nanachi',
      body: 'Terminou: Refatorar login',
      machineId: MACHINE_ID,
      workspaceId,
      sessionId,
      kind: 'turn_end',
    });
  });

  it('terminal_exit (sessão PTY que terminou): body "Terminal encerrado", avisado como turn_end', async () => {
    const workspaceId = seedWorkspace({ name: 'nanachi' });
    const sessionId = seedSession(workspaceId, 'Terminal agy');
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();
    const exit: NotifyDetails = { ...meta, kind: 'terminal_exit', exitCode: 0 };

    await notifierWith({ send }).notify(sessionId, 'turn_end', exit);

    expect(PushPayloadSchema.parse(parsedPayload(sent[0] as Sent))).toMatchObject({
      body: 'Terminal encerrado',
      kind: 'turn_end',
    });
  });

  it('permission_request: body "Pede aprovação: <título da permissão>"', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'permission_request', permission('Editar src/a.ts'));

    expect(PushPayloadSchema.parse(parsedPayload(sent[0] as Sent)).body).toBe('Pede aprovação: Editar src/a.ts');
  });

  it('error: body "Erro: <mensagem>" com no máximo 120 caracteres', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'error', errorEvent(`falhou\n${'x'.repeat(400)}`));

    const body = PushPayloadSchema.parse(parsedPayload(sent[0] as Sent)).body;
    expect(body.startsWith('Erro: falhou x')).toBe(true);
    expect(Array.from(body.slice('Erro: '.length)).length).toBeLessThanOrEqual(120);
  });

  it('file: body "Arquivo: <nome>"', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'file', fileEvent('print.png'));

    expect(PushPayloadSchema.parse(parsedPayload(sent[0] as Sent)).body).toBe('Arquivo: print.png');
  });
});

describe('createPushNotifier: quem recebe', () => {
  it('workspace mudo: nada é enviado para ninguém', async () => {
    const workspaceId = seedWorkspace({ muted: true });
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'turn_end', turnEnd());

    expect(sent).toEqual([]);
  });

  it('device com WS aberto não recebe push; os demais recebem', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('online');
    seedDevice('offline');
    seedSubscription('https://push.example.test/online', 'online');
    seedSubscription('https://push.example.test/offline', 'offline');
    const { send, sent } = fakeSend();

    await notifierWith({ send, online: ['online'] }).notify(sessionId, 'turn_end', turnEnd());

    expect(sent.map((call) => call.endpoint)).toEqual(['https://push.example.test/offline']);
  });

  it('sessão inexistente: não envia nem lança', async () => {
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await expect(notifierWith({ send }).notify('nao-existe', 'turn_end', turnEnd())).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe('createPushNotifier: opções do envio', () => {
  it('TTL de 1 h, aes128gcm, VAPID do arquivo; urgency high só para permission_request', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();
    const notifier = notifierWith({ send });

    await notifier.notify(sessionId, 'turn_end', turnEnd());
    await notifier.notify(sessionId, 'permission_request', permission());

    expect(sent[0]?.options).toMatchObject({
      TTL: 3600,
      urgency: 'normal',
      contentEncoding: 'aes128gcm',
      vapidDetails: { subject: VAPID.subject, publicKey: VAPID.publicKey, privateKey: VAPID.privateKey },
    });
    expect(sent[1]?.options).toMatchObject({ TTL: 3600, urgency: 'high' });
  });
});

describe('createPushNotifier: falhas do serviço de push', () => {
  it('404 e 410 apagam a inscrição', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/gone', 'd1');
    seedSubscription('https://push.example.test/missing', 'd1');
    const { send } = fakeSend({ 'https://push.example.test/gone': 410, 'https://push.example.test/missing': 404 });

    await notifierWith({ send }).notify(sessionId, 'turn_end', turnEnd());

    expect(subscriptionsCount()).toBe(0);
  });

  it('outros status (500) mantêm a inscrição e viram warn sem expor endpoint nem payload', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/flaky', 'd1');
    const { send } = fakeSend({ 'https://push.example.test/flaky': 500 });
    const warns: Array<Record<string, unknown>> = [];

    await notifierWith({ send, warns }).notify(sessionId, 'turn_end', turnEnd());

    expect(subscriptionsCount()).toBe(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ statusCode: 500 });
    expect(JSON.stringify(warns)).not.toContain('flaky');
  });

  it('erro de rede (sem statusCode) não propaga e não apaga a inscrição', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/down', 'd1');
    const { send } = fakeSend({ 'https://push.example.test/down': new Error('ECONNREFUSED') });
    const warns: Array<Record<string, unknown>> = [];

    await expect(
      notifierWith({ send, warns }).notify(sessionId, 'turn_end', turnEnd()),
    ).resolves.toBeUndefined();
    expect(subscriptionsCount()).toBe(1);
    expect(warns).toHaveLength(1);
  });

  it('uma falha não impede o envio para os outros devices', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedDevice('d2');
    seedSubscription('https://push.example.test/broken', 'd1');
    seedSubscription('https://push.example.test/fine', 'd2');
    const { send, sent } = fakeSend({ 'https://push.example.test/broken': new Error('boom') });

    await notifierWith({ send }).notify(sessionId, 'turn_end', turnEnd());

    expect(sent.map((call) => call.endpoint).sort()).toEqual([
      'https://push.example.test/broken',
      'https://push.example.test/fine',
    ]);
  });
});

