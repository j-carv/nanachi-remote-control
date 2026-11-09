import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushPayloadSchema } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { PushSubscription, RequestOptions } from 'web-push';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifyDetails } from '../src/notify.js';
import { openDatabase } from '../src/db.js';
import { LiveConnections, type LiveSocket } from '../src/live-connections.js';
import { createPushNotifier, type SendNotification } from '../src/push.js';
import {
  insertDevice,
  insertSession,
  insertWorkspace,
  upsertPushSubscription,
} from '../src/repository.js';
import type { AppLanguage } from '@nanachi/shared';
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

function seedSubscription(endpoint: string, deviceId: string, language?: AppLanguage): void {
  upsertPushSubscription(db, {
    endpoint,
    deviceId,
    keys: { p256dh: 'p256', auth: 'auth' },
    language,
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

function loopPaused(sessionId: string, message: string): NotifyDetails {
  return { kind: 'loop_paused', sessionId, message };
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

/** An open socket: what a real WS has while the app is connected. */
function openSocket(): LiveSocket {
  return { readyState: WebSocket.OPEN, close: () => undefined };
}

function notifierWith(
  options: {
    send?: SendNotification;
    connections?: Pick<LiveConnections, 'hasLiveSubscription'>;
    warns?: Array<Record<string, unknown>>;
    now?: () => number;
    inactivityMs?: number | null;
  } = {},
) {
  return createPushNotifier({
    db,
    machineId: MACHINE_ID,
    vapid: VAPID,
    connections: options.connections ?? new LiveConnections(),
    send: options.send,
    now: options.now,
    inactivityMs: options.inactivityMs,
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

  it('permission_request com título longo: body encurtado e payload abaixo de 4 KB (limite do Web Push)', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'permission_request', permission(`Executar ${'x'.repeat(5000)}`));

    expect(sent).toHaveLength(1);
    expect(Buffer.byteLength(sent[0]?.payload ?? '', 'utf8')).toBeLessThan(4096);
    const body = PushPayloadSchema.parse(parsedPayload(sent[0] as Sent)).body;
    expect(body.startsWith('Pede aprovação: Executar xxx')).toBe(true);
    expect(Array.from(body.slice('Pede aprovação: '.length)).length).toBeLessThanOrEqual(120);
  });

  it('permission_request sem título: body "Pede aprovação", sem dois-pontos sobrando', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'permission_request', permission('   '));

    expect(PushPayloadSchema.parse(parsedPayload(sent[0] as Sent)).body).toBe('Pede aprovação');
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

  it('loop_paused: título "Loop pausado", body "<título da sessão>: <mensagem>", kind loop_paused', async () => {
    const workspaceId = seedWorkspace({ name: 'nanachi' });
    const sessionId = seedSession(workspaceId, 'Refatorar login');
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'loop_paused', loopPaused(sessionId, 'agente caiu'));

    expect(PushPayloadSchema.parse(parsedPayload(sent[0] as Sent))).toEqual({
      title: 'Loop pausado',
      body: 'Refatorar login: agente caiu',
      machineId: MACHINE_ID,
      workspaceId,
      sessionId,
      kind: 'loop_paused',
    });
  });

  it('loop_paused: a mensagem do erro vai encurtada (120 caracteres no total do trecho)', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId, 'Refatorar login');
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'loop_paused', loopPaused(sessionId, `falhou
${'x'.repeat(400)}`));

    const body = PushPayloadSchema.parse(parsedPayload(sent[0] as Sent)).body;
    expect(body.startsWith('Refatorar login: falhou x')).toBe(true);
    expect(Array.from(body.slice('Refatorar login: '.length)).length).toBeLessThanOrEqual(120);
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

  it('loop pausado em workspace mudo também não avisa', async () => {
    const workspaceId = seedWorkspace({ muted: true });
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'loop_paused', loopPaused(sessionId, 'falhou'));

    expect(sent).toEqual([]);
  });

  it('a device with an open socket following the session does not get its push; the others do', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('watching');
    seedDevice('offline');
    seedSubscription('https://push.example.test/watching', 'watching');
    seedSubscription('https://push.example.test/offline', 'offline');
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('watching', socket);
    connections.subscribe(socket, sessionId);
    const { send, sent } = fakeSend();

    await notifierWith({ send, connections }).notify(sessionId, 'turn_end', turnEnd());

    expect(sent.map((call) => call.endpoint)).toEqual(['https://push.example.test/offline']);
  });

  it('an open socket on another session (or another screen) does not suppress this session push', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    const otherSessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('d1', socket);
    connections.subscribe(socket, otherSessionId);
    const { send, sent } = fakeSend();

    const notifier = notifierWith({ send, connections });

    await notifier.notify(sessionId, 'turn_end', turnEnd());
    await notifier.notify(otherSessionId, 'turn_end', turnEnd());

    expect(sent).toHaveLength(1);
  });

  it('leaving the session (unsubscribe) gives its push back; closing the socket does too', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('d1', socket);
    connections.subscribe(socket, sessionId);
    const { send, sent } = fakeSend();
    const notifier = notifierWith({ send, connections });

    await notifier.notify(sessionId, 'turn_end', turnEnd());
    expect(sent).toHaveLength(0);

    connections.unsubscribe(socket, sessionId);
    await notifier.notify(sessionId, 'turn_end', turnEnd());
    expect(sent).toHaveLength(1);

    connections.subscribe(socket, sessionId);
    connections.remove('d1', socket);
    await notifier.notify(sessionId, 'turn_end', turnEnd());
    expect(sent).toHaveLength(2);
  });

  it('sessão inexistente: não envia nem lança', async () => {
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1');
    const { send, sent } = fakeSend();

    await expect(notifierWith({ send }).notify('nao-existe', 'turn_end', turnEnd())).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('device expirado (sem uso além de deviceInactivityDays) não recebe push; o ativo recebe', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = 1_700_000_000_000;
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('active');
    seedDevice('expired');
    db.prepare<[number, string]>('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(NOW - DAY, 'active');
    db.prepare<[number, string]>('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(NOW - 91 * DAY, 'expired');
    seedSubscription('https://push.example.test/active', 'active');
    seedSubscription('https://push.example.test/expired', 'expired');
    const { send, sent } = fakeSend();

    await notifierWith({ send, now: () => NOW, inactivityMs: 90 * DAY }).notify(sessionId, 'turn_end', turnEnd());

    expect(sent.map((call) => call.endpoint)).toEqual(['https://push.example.test/active']);
  });

  it('o aviso de pareamento também não vai para device expirado', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = 1_700_000_000_000;
    seedDevice('active');
    seedDevice('expired');
    db.prepare<[number, string]>('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(NOW - DAY, 'active');
    db.prepare<[number, string]>('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(NOW - 91 * DAY, 'expired');
    seedSubscription('https://push.example.test/active', 'active');
    seedSubscription('https://push.example.test/expired', 'expired');
    const { send, sent } = fakeSend();

    await notifierWith({ send, now: () => NOW, inactivityMs: 90 * DAY }).notifyDevicePaired('new-device', 'iPad');

    expect(sent.map((call) => call.endpoint)).toEqual(['https://push.example.test/active']);
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

describe('createPushNotifier: device language', () => {
  it('an English subscription gets English text; the title is still the workspace name', async () => {
    const workspaceId = seedWorkspace({ name: 'nanachi' });
    const sessionId = seedSession(workspaceId, 'Refactor login');
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1', 'en');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'turn_end', turnEnd());

    expect(PushPayloadSchema.parse(parsedPayload(sent[0] as Sent))).toEqual({
      title: 'nanachi',
      body: 'Finished: Refactor login',
      machineId: MACHINE_ID,
      workspaceId,
      sessionId,
      kind: 'turn_end',
    });
  });

  it('each device gets its own language in the same notice: en, es and pt-BR', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('en');
    seedDevice('es');
    seedDevice('pt');
    seedSubscription('https://push.example.test/en', 'en', 'en');
    seedSubscription('https://push.example.test/es', 'es', 'es');
    seedSubscription('https://push.example.test/pt', 'pt', 'pt-BR');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'permission_request', permission(''));

    const bodies = Object.fromEntries(sent.map((call) => [call.endpoint, PushPayloadSchema.parse(parsedPayload(call)).body]));
    expect(bodies).toEqual({
      'https://push.example.test/en': 'Needs approval',
      'https://push.example.test/es': 'Necesita aprobación',
      'https://push.example.test/pt': 'Pede aprovação',
    });
  });

  it('loop paused in English: title "Loop paused" and body with the session title', async () => {
    const workspaceId = seedWorkspace({ name: 'nanachi' });
    const sessionId = seedSession(workspaceId, 'Refactor login');
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1', 'en');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'loop_paused', loopPaused(sessionId, 'agent crashed'));

    expect(PushPayloadSchema.parse(parsedPayload(sent[0] as Sent))).toMatchObject({
      title: 'Loop paused',
      body: 'Refactor login: agent crashed',
    });
  });

  it('the payload stays under 4 KB in any language with a long message', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('d1');
    seedSubscription('https://push.example.test/d1', 'd1', 'es');
    const { send, sent } = fakeSend();

    await notifierWith({ send }).notify(sessionId, 'error', errorEvent(`falló\n${'x'.repeat(5000)}`));

    expect(sent).toHaveLength(1);
    expect(Buffer.byteLength(sent[0]?.payload ?? '', 'utf8')).toBeLessThan(4096);
    expect(PushPayloadSchema.parse(parsedPayload(sent[0] as Sent)).body.startsWith('Error: falló x')).toBe(true);
  });
});

describe('createPushNotifier: user decisions', () => {
  it('alerts a phone outside the chat with the correct session and bounded question, but not a phone already reading it', async () => {
    const workspaceId = seedWorkspace();
    const sessionId = seedSession(workspaceId);
    seedDevice('watching');
    seedDevice('away');
    seedSubscription('https://push.example.test/watching', 'watching', 'en');
    seedSubscription('https://push.example.test/away', 'away', 'en');
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('watching', socket);
    connections.subscribe(socket, sessionId);
    const { send, sent } = fakeSend();
    const question: NotifyDetails = {
      ...meta,
      sessionId,
      kind: 'user_question',
      requestId: '00000000-0000-4000-8000-000000000001',
      question: `Preserve data? ${'Long question '.repeat(100)}`,
      options: [{ id: 'yes', label: 'Preserve' }, { id: 'no', label: 'Recreate' }],
      expiresAt: Date.now() + 300_000,
    };

    await notifierWith({ send, connections }).notify(sessionId, 'user_question', question);

    expect(sent.map((call) => call.endpoint)).toEqual(['https://push.example.test/away']);
    const delivery = sent[0] as Sent;
    expect(delivery.options.urgency).toBe('high');
    const payload = PushPayloadSchema.parse(parsedPayload(delivery));
    expect(payload.kind).toBe('user_question');
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.body).toContain('Preserve data?');
    expect(payload.body).not.toContain(question.question);
    expect(Buffer.byteLength(delivery.payload, 'utf8')).toBeLessThan(4096);
  });
});


describe('file-request and preview notifications', () => {
  it.each([
    { language: 'pt-BR', file: 'Precisa de um arquivo: Documento', preview: 'Pré-visualização disponível: Aplicativo' },
    { language: 'en', file: 'Needs a file: Documento', preview: 'Preview available: Aplicativo' },
    { language: 'es', file: 'Necesita un archivo: Documento', preview: 'Vista previa disponible: Aplicativo' },
  ] as const)('delivers both new kinds in $language without request paths or preview connection data', async (sample) => {
    const sessionId = seedSession(seedWorkspace({ name: 'Synthetic workspace' }));
    seedDevice('device');
    seedSubscription('https://fcm.googleapis.com/device', 'device', sample.language);
    const { send, sent } = fakeSend();
    const notifier = notifierWith({ send });
    const requestId = '50efca7a-6ceb-4bd5-8c38-d6ab7f317ce9';
    await notifier.notify(sessionId, 'file_request', {
      ...meta, kind: 'file_request', requestId, prompt: 'Documento', accept: ['.pdf'], expiresAt: 300_000,
    });
    await notifier.notify(sessionId, 'preview', {
      ...meta, kind: 'preview', previewId: requestId, title: 'Aplicativo', port: 54321, path: '/private-page', expiresAt: 300_000,
    });
    expect(sent).toHaveLength(2);
    expect(sent.map((item) => PushPayloadSchema.parse(JSON.parse(item.payload) as unknown))).toEqual([
      expect.objectContaining({ kind: 'file_request', body: sample.file }),
      expect.objectContaining({ kind: 'preview', body: sample.preview }),
    ]);
    expect(sent.map((item) => item.options.urgency)).toEqual(['high', 'normal']);
    expect(sent.some((item) => item.payload.includes(requestId) || item.payload.includes('54321') || item.payload.includes('/private-page'))).toBe(false);
  });
});
