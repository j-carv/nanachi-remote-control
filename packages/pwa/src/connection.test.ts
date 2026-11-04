import { describe, expect, it } from 'vitest';
import {
  PING_INTERVAL_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  UNAUTHORIZED_CLOSE_CODE,
  buildWsUrl,
  createConnection,
  createConnectionPool,
  type ConnectionStatus,
  type SocketHandler,
  type SocketLike,
  type Timers,
} from './connection.js';
import type { Machine } from './machines.js';

class FakeClock implements Timers {
  now = 0;
  private tasks: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks = this.tasks.filter((task) => task.id !== handle);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((task) => task.at <= target).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      this.now = due.at;
      this.tasks = this.tasks.filter((task) => task.id !== due.id);
      due.fn();
    }
    this.now = target;
  }
}

class FakeSocket implements SocketLike {
  onopen: SocketHandler<{ type: string }> | null = null;
  onmessage: SocketHandler<{ data: unknown }> | null = null;
  onclose: SocketHandler<{ code: number }> | null = null;
  onerror: SocketHandler<{ type: string }> | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({ type: 'open' });
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }

  drop(code: number): void {
    this.onclose?.({ code });
  }
}

const HELLO = JSON.stringify({ type: 'hello', machineId: 'm', machineName: 'PC' });

function setup() {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const connection = createConnection({
    url: 'ws://127.0.0.1:7777/ws?token=t',
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onStatus: (status) => statuses.push(status),
    timers: clock,
  });
  return { clock, sockets, statuses, connection };
}

describe('buildWsUrl', () => {
  it('troca http por ws e monta /ws com o token', () => {
    expect(buildWsUrl('http://127.0.0.1:7777', 'abc')).toBe('ws://127.0.0.1:7777/ws?token=abc');
  });

  it('troca https por wss e ignora barra final', () => {
    expect(buildWsUrl('https://pc.tail1234.ts.net/', 'abc')).toBe(
      'wss://pc.tail1234.ts.net/ws?token=abc',
    );
  });

  it('codifica o token', () => {
    expect(buildWsUrl('http://h:1', 'a b&c')).toBe('ws://h:1/ws?token=a+b%26c');
  });
});

describe('createConnection', () => {
  it('começa em connecting e abre o socket na URL dada', () => {
    const { sockets, statuses, connection } = setup();
    connection.start();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe('ws://127.0.0.1:7777/ws?token=t');
    expect(statuses).toEqual(['connecting']);
    expect(connection.getStatus()).toBe('connecting');
  });

  it('abrir o socket não basta: só o hello deixa online', () => {
    const { sockets, connection } = setup();
    connection.start();
    sockets[0]?.open();
    expect(connection.getStatus()).toBe('connecting');
  });

  it('hello vira online', () => {
    const { sockets, statuses, connection } = setup();
    connection.start();
    sockets[0]?.open();
    sockets[0]?.receive(HELLO);
    expect(connection.getStatus()).toBe('online');
    expect(statuses).toEqual(['connecting', 'online']);
  });

  it('ignora pong, JSON inválido e hello incompleto', () => {
    const { sockets, connection } = setup();
    connection.start();
    sockets[0]?.open();
    sockets[0]?.receive(JSON.stringify({ type: 'pong' }));
    sockets[0]?.receive('não é json');
    sockets[0]?.receive(JSON.stringify({ type: 'hello' }));
    expect(connection.getStatus()).toBe('connecting');
  });

  it('envia ping a cada 25 s depois de aberto', () => {
    const { clock, sockets, connection } = setup();
    connection.start();
    sockets[0]?.open();
    expect(PING_INTERVAL_MS).toBe(25_000);
    clock.advance(PING_INTERVAL_MS - 1);
    expect(sockets[0]?.sent).toEqual([]);
    clock.advance(1);
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    clock.advance(PING_INTERVAL_MS);
    expect(sockets[0]?.sent).toHaveLength(2);
  });

  it('código 4401 vira unauthorized e não reconecta', () => {
    const { clock, sockets, statuses, connection } = setup();
    expect(UNAUTHORIZED_CLOSE_CODE).toBe(4401);
    connection.start();
    sockets[0]?.open();
    sockets[0]?.receive(HELLO);
    sockets[0]?.drop(4401);
    clock.advance(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(connection.getStatus()).toBe('unauthorized');
    expect(statuses.at(-1)).toBe('unauthorized');
  });

  it('queda de rede vira offline e reconecta após 1 s', () => {
    const { clock, sockets, connection } = setup();
    expect(RECONNECT_INITIAL_MS).toBe(1_000);
    connection.start();
    sockets[0]?.open();
    sockets[0]?.receive(HELLO);
    sockets[0]?.drop(1006);
    expect(connection.getStatus()).toBe('offline');
    clock.advance(999);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    expect(connection.getStatus()).toBe('connecting');
  });

  it('backoff dobra a cada falha de 1 s até o teto de 30 s', () => {
    const { clock, sockets, connection } = setup();
    expect(RECONNECT_MAX_MS).toBe(30_000);
    connection.start();
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = clock.now;
      sockets[i]?.drop(1006);
      while (sockets.length <= i + 1) clock.advance(100);
      gaps.push(clock.now - before);
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('hello zera o backoff', () => {
    const { clock, sockets, connection } = setup();
    connection.start();
    sockets[0]?.drop(1006);
    clock.advance(1000);
    sockets[1]?.drop(1006);
    clock.advance(2000);
    sockets[2]?.open();
    sockets[2]?.receive(HELLO);
    sockets[2]?.drop(1006);
    clock.advance(999);
    expect(sockets).toHaveLength(3);
    clock.advance(1);
    expect(sockets).toHaveLength(4);
  });

  it('para de enviar ping quando o socket cai', () => {
    const { clock, sockets, connection } = setup();
    connection.start();
    sockets[0]?.open();
    sockets[0]?.drop(1006);
    clock.advance(PING_INTERVAL_MS * 2);
    expect(sockets[0]?.sent).toEqual([]);
    expect(connection.getStatus()).toBe('connecting');
  });

  it('stop() fecha o socket, cancela timers e não emite mais status', () => {
    const { clock, sockets, statuses, connection } = setup();
    connection.start();
    sockets[0]?.open();
    sockets[0]?.receive(HELLO);
    connection.stop();
    expect(sockets[0]?.closed).toBe(true);
    sockets[0]?.drop(1006);
    clock.advance(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'online']);
  });
});

describe('createConnectionPool', () => {
  const machineA: Machine = { id: 'm-a', name: 'PC A', baseUrl: 'https://a.ts.net', token: 'ta' };
  const machineB: Machine = { id: 'm-b', name: 'PC B', baseUrl: 'http://127.0.0.1:7777', token: 'tb' };

  function setupPool() {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const events: { id: string; status: ConnectionStatus }[] = [];
    const pool = createConnectionPool({
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      timers: clock,
      onStatus: (id, status) => events.push({ id, status }),
    });
    const socketFor = (url: string) => sockets.find((socket) => socket.url === url);
    return { clock, sockets, events, pool, socketFor };
  }

  it('abre uma conexão por máquina, com a URL correta', () => {
    const { sockets, events, pool } = setupPool();
    pool.sync([machineA, machineB]);
    expect(sockets.map((socket) => socket.url)).toEqual([
      'wss://a.ts.net/ws?token=ta',
      'ws://127.0.0.1:7777/ws?token=tb',
    ]);
    expect(events).toEqual([
      { id: 'm-a', status: 'connecting' },
      { id: 'm-b', status: 'connecting' },
    ]);
  });

  it('hello de uma máquina só muda o status dela', () => {
    const { events, pool, socketFor } = setupPool();
    pool.sync([machineA, machineB]);
    events.length = 0;
    const socket = socketFor('wss://a.ts.net/ws?token=ta');
    socket?.open();
    socket?.receive(HELLO);
    expect(events).toEqual([{ id: 'm-a', status: 'online' }]);
  });

  it('sync sem uma máquina fecha a conexão dela e para de emitir eventos', () => {
    const { clock, events, pool, socketFor } = setupPool();
    pool.sync([machineA, machineB]);
    const socketB = socketFor('ws://127.0.0.1:7777/ws?token=tb');
    pool.sync([machineA]);
    expect(socketB?.closed).toBe(true);
    events.length = 0;
    socketB?.drop(1006);
    clock.advance(60_000);
    expect(events).toEqual([]);
  });

  it('troca de token reinicia a conexão da máquina', () => {
    const { sockets, pool } = setupPool();
    pool.sync([machineA]);
    pool.sync([{ ...machineA, token: 'novo' }]);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.url).toBe('wss://a.ts.net/ws?token=novo');
  });

  it('sync com a mesma lista não recria conexões', () => {
    const { sockets, pool } = setupPool();
    pool.sync([machineA]);
    pool.sync([machineA]);
    expect(sockets).toHaveLength(1);
  });

  it('stopAll fecha tudo', () => {
    const { sockets, pool } = setupPool();
    pool.sync([machineA, machineB]);
    pool.stopAll();
    expect(sockets.every((socket) => socket.closed)).toBe(true);
  });

  it('get devolve a conexão da máquina e undefined depois de removida', () => {
    const { pool } = setupPool();
    expect(pool.get('m-a')).toBeUndefined();
    pool.sync([machineA]);
    expect(pool.get('m-a')).toBeDefined();
    pool.sync([]);
    expect(pool.get('m-a')).toBeUndefined();
  });
});

function eventJson(seq: number, sessionId = 's-1'): string {
  return JSON.stringify({
    type: 'event',
    event: { seq, sessionId, ts: 1, kind: 'user_message', text: `m${seq}` },
  });
}

function subscribeJson(sessionId: string, afterSeq: number): string {
  return JSON.stringify({ type: 'subscribe', sessionId, afterSeq });
}

function setupOnline() {
  const ctx = setup();
  ctx.connection.start();
  ctx.sockets[0]?.open();
  ctx.sockets[0]?.receive(HELLO);
  return ctx;
}

describe('mensagens do servidor', () => {
  it('despacha hello, pong, event, session e error para os listeners', () => {
    const { sockets, connection } = setup();
    const received: string[] = [];
    connection.onMessage((message) => received.push(message.type));
    connection.start();
    sockets[0]?.open();
    sockets[0]?.receive(HELLO);
    sockets[0]?.receive(JSON.stringify({ type: 'pong' }));
    sockets[0]?.receive(eventJson(1));
    sockets[0]?.receive(JSON.stringify({ type: 'error', message: 'x' }));
    sockets[0]?.receive('não é json');
    expect(received).toEqual(['hello', 'pong', 'event', 'error']);
  });

  it('listener removido pela função devolvida não recebe mais', () => {
    const { sockets, connection } = setup();
    const received: string[] = [];
    const off = connection.onMessage((message) => received.push(message.type));
    connection.start();
    off();
    sockets[0]?.open();
    sockets[0]?.receive(HELLO);
    expect(received).toEqual([]);
  });

  it('send só envia quando online, e serializa a mensagem', () => {
    const { sockets, connection } = setup();
    connection.start();
    sockets[0]?.open();
    expect(connection.send({ type: 'cancel', sessionId: 's-1' })).toBe(false);
    sockets[0]?.receive(HELLO);
    expect(connection.send({ type: 'cancel', sessionId: 's-1' })).toBe(true);
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: 'cancel', sessionId: 's-1' })]);
  });

  it('send devolve false depois da queda', () => {
    const { sockets, connection } = setupOnline();
    sockets[0]?.drop(1006);
    expect(connection.send({ type: 'cancel', sessionId: 's-1' })).toBe(false);
  });
});

describe('assinaturas de sessão', () => {
  it('subscribe com conexão online envia na hora', () => {
    const { sockets, connection } = setupOnline();
    connection.subscribe('s-1', 7);
    expect(sockets[0]?.sent).toEqual([subscribeJson('s-1', 7)]);
  });

  it('subscribe antes do hello fica pendente e vai no hello', () => {
    const { sockets, connection } = setup();
    connection.start();
    connection.subscribe('s-1', 4);
    sockets[0]?.open();
    expect(sockets[0]?.sent).toEqual([]);
    sockets[0]?.receive(HELLO);
    expect(sockets[0]?.sent).toEqual([subscribeJson('s-1', 4)]);
  });

  it('evento de sessão assinada avança o cursor; seq antigo não recua', () => {
    const { sockets, connection } = setupOnline();
    connection.subscribe('s-1', 0);
    sockets[0]?.receive(eventJson(5));
    sockets[0]?.receive(eventJson(3));
    expect(connection.getCursor('s-1')).toBe(5);
  });

  it('eventos de sessão não assinada não criam cursor', () => {
    const { sockets, connection } = setupOnline();
    sockets[0]?.receive(eventJson(9, 's-outra'));
    expect(connection.getCursor('s-outra')).toBeUndefined();
  });

  it('listeners veem o cursor já atualizado pelo evento', () => {
    const { sockets, connection } = setupOnline();
    connection.subscribe('s-1', 0);
    const seen: (number | undefined)[] = [];
    connection.onMessage(() => seen.push(connection.getCursor('s-1')));
    sockets[0]?.receive(eventJson(2));
    expect(seen).toEqual([2]);
  });

  it('ao reconectar reenvia subscribe com o último afterSeq', () => {
    const { clock, sockets, connection } = setupOnline();
    connection.subscribe('s-1', 0);
    sockets[0]?.receive(eventJson(5));
    sockets[0]?.receive(eventJson(8));
    sockets[0]?.drop(1006);
    clock.advance(1_000);
    sockets[1]?.open();
    sockets[1]?.receive(HELLO);
    expect(sockets[1]?.sent).toEqual([subscribeJson('s-1', 8)]);
  });

  it('reconecta com todas as sessões assinadas', () => {
    const { clock, sockets, connection } = setupOnline();
    connection.subscribe('s-1', 1);
    connection.subscribe('s-2', 4);
    sockets[0]?.drop(1006);
    clock.advance(1_000);
    sockets[1]?.open();
    sockets[1]?.receive(HELLO);
    expect(sockets[1]?.sent).toEqual([subscribeJson('s-1', 1), subscribeJson('s-2', 4)]);
  });

  it('unsubscribe para de reenviar na reconexão e avisa o servidor quando online', () => {
    const { clock, sockets, connection } = setupOnline();
    connection.subscribe('s-1', 1);
    connection.unsubscribe('s-1');
    expect(sockets[0]?.sent.at(-1)).toBe(JSON.stringify({ type: 'unsubscribe', sessionId: 's-1' }));
    expect(connection.getCursor('s-1')).toBeUndefined();
    sockets[0]?.drop(1006);
    clock.advance(1_000);
    sockets[1]?.open();
    sockets[1]?.receive(HELLO);
    expect(sockets[1]?.sent).toEqual([]);
  });

  it('subscribe com novo afterSeq substitui o cursor da sessão', () => {
    const { sockets, connection } = setupOnline();
    connection.subscribe('s-1', 2);
    sockets[0]?.receive(eventJson(6));
    connection.subscribe('s-1', 10);
    expect(connection.getCursor('s-1')).toBe(10);
  });
});
