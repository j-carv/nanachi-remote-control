import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type SessionEvent,
} from '@nanachi/shared';
import type { Machine } from './machines.js';

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'unauthorized';

export const PING_INTERVAL_MS = 25_000;
export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** Código de fechamento do daemon quando o token é inválido ou revogado. */
export const UNAUTHORIZED_CLOSE_CODE = 4401;

/**
 * Handler com assinatura bivariante (truque do React). Assim um `WebSocket` nativo
 * satisfaz `SocketLike` sem precisar de adaptador, e os fakes dos testes também.
 */
export type SocketHandler<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

/** Subconjunto de `WebSocket` usado pela conexão. */
export interface SocketLike {
  onopen: SocketHandler<{ type: string }> | null;
  onmessage: SocketHandler<{ data: unknown }> | null;
  onclose: SocketHandler<{ code: number }> | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** setTimeout/clearTimeout injetáveis; a conexão não depende do relógio global. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserTimers: Timers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/** `http(s)://host/base` + token → `ws(s)://host/base/ws?token=...`. */
export function buildWsUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
  url.search = new URLSearchParams({ token }).toString();
  url.hash = '';
  return url.toString();
}

export type MessageListener = (message: ServerMessage) => void;

export interface ConnectionOptions {
  url: string;
  createSocket: SocketFactory;
  onStatus: (status: ConnectionStatus) => void;
  timers?: Timers;
}

export interface Connection {
  /** Abre o socket. Sem efeito se já iniciada. */
  start(): void;
  /** Fecha tudo e para de reconectar. Não emite status. */
  stop(): void;
  getStatus(): ConnectionStatus;
  /** Envia uma mensagem. Só funciona online; devolve `false` se não enviou. */
  send(message: ClientMessage): boolean;
  /**
   * Assina uma sessão a partir de `afterSeq`. Se ainda não estiver online, a assinatura
   * vai no `hello`. Em toda reconexão a assinatura é reenviada com o último seq visto.
   */
  subscribe(sessionId: string, afterSeq: number): void;
  unsubscribe(sessionId: string): void;
  /** Último seq recebido da sessão assinada, ou `undefined` se não está assinada. */
  getCursor(sessionId: string): number | undefined;
  /** Recebe toda mensagem do servidor já validada. Devolve a função para remover. */
  onMessage(listener: MessageListener): () => void;
}

/**
 * Conexão com uma máquina. `online` só depois do `hello`.
 * Queda vira `offline` e reconecta com backoff 1 s → 2 s → … → 30 s (zerado no hello).
 * Close 4401 vira `unauthorized` e não reconecta.
 */
export function createConnection(options: ConnectionOptions): Connection {
  const timers = options.timers ?? browserTimers;
  let status: ConnectionStatus = 'connecting';
  let running = false;
  let socket: SocketLike | null = null;
  let retryHandle: unknown = null;
  let pingHandle: unknown = null;
  let backoffMs = RECONNECT_INITIAL_MS;
  /** sessionId -> último seq recebido (ou o afterSeq da assinatura, antes de receber nada). */
  const subscriptions = new Map<string, number>();
  const listeners = new Set<MessageListener>();

  function setStatus(next: ConnectionStatus): void {
    status = next;
    options.onStatus(next);
  }

  function stopPing(): void {
    if (pingHandle !== null) timers.clearTimeout(pingHandle);
    pingHandle = null;
  }

  function schedulePing(current: SocketLike): void {
    pingHandle = timers.setTimeout(() => {
      const message: ClientMessage = { type: 'ping' };
      current.send(JSON.stringify(message));
      schedulePing(current);
    }, PING_INTERVAL_MS);
  }

  function scheduleRetry(): void {
    retryHandle = timers.setTimeout(() => {
      retryHandle = null;
      connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }

  function sendIfOnline(message: ClientMessage): boolean {
    if (socket === null || status !== 'online') return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  /** Reenvia as assinaturas no socket recém-online, do último seq conhecido. */
  function resubscribeAll(current: SocketLike): void {
    for (const [sessionId, afterSeq] of subscriptions) {
      const message: ClientMessage = { type: 'subscribe', sessionId, afterSeq };
      current.send(JSON.stringify(message));
    }
  }

  function advanceCursor(event: SessionEvent): void {
    const cursor = subscriptions.get(event.sessionId);
    if (cursor !== undefined && event.seq > cursor) subscriptions.set(event.sessionId, event.seq);
  }

  function dispatch(message: ServerMessage): void {
    for (const listener of [...listeners]) listener(message);
  }

  function connect(): void {
    setStatus('connecting');
    const current = options.createSocket(options.url);
    socket = current;

    current.onopen = () => {
      if (socket === current) schedulePing(current);
    };

    current.onmessage = (event) => {
      if (socket !== current || typeof event.data !== 'string') return;
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) return;
      const message = parsed.value;

      if (message.type === 'hello') {
        backoffMs = RECONNECT_INITIAL_MS;
        setStatus('online');
        resubscribeAll(current);
      } else if (message.type === 'event') {
        advanceCursor(message.event);
      }
      dispatch(message);
    };

    current.onclose = (event) => {
      if (socket !== current) return;
      socket = null;
      stopPing();
      if (event.code === UNAUTHORIZED_CLOSE_CODE) {
        setStatus('unauthorized');
        return;
      }
      setStatus('offline');
      scheduleRetry();
    };
  }

  return {
    start() {
      if (running) return;
      running = true;
      backoffMs = RECONNECT_INITIAL_MS;
      connect();
    },

    stop() {
      running = false;
      if (retryHandle !== null) timers.clearTimeout(retryHandle);
      retryHandle = null;
      stopPing();
      const current = socket;
      socket = null;
      current?.close();
    },

    getStatus() {
      return status;
    },

    send(message) {
      return sendIfOnline(message);
    },

    subscribe(sessionId, afterSeq) {
      subscriptions.set(sessionId, afterSeq);
      sendIfOnline({ type: 'subscribe', sessionId, afterSeq });
    },

    unsubscribe(sessionId) {
      if (!subscriptions.delete(sessionId)) return;
      sendIfOnline({ type: 'unsubscribe', sessionId });
    },

    getCursor(sessionId) {
      return subscriptions.get(sessionId);
    },

    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface ConnectionPoolOptions {
  createSocket: SocketFactory;
  timers?: Timers;
  onStatus: (machineId: string, status: ConnectionStatus) => void;
}

export interface ConnectionPool {
  /** Deixa exatamente uma conexão ativa por máquina da lista. */
  sync(machines: readonly Machine[]): void;
  /** Conexão ativa da máquina, ou `undefined` se ela não está na lista sincronizada. */
  get(machineId: string): Connection | undefined;
  stopAll(): void;
}

/** Uma conexão por máquina; recria só quando a URL (baseUrl ou token) muda. */
export function createConnectionPool(options: ConnectionPoolOptions): ConnectionPool {
  const entries = new Map<string, { url: string; connection: Connection }>();

  function stopAll(): void {
    for (const entry of entries.values()) entry.connection.stop();
    entries.clear();
  }

  return {
    sync(machines) {
      const wanted = new Set(machines.map((machine) => machine.id));
      for (const [id, entry] of entries) {
        if (wanted.has(id)) continue;
        entry.connection.stop();
        entries.delete(id);
      }

      for (const machine of machines) {
        const url = buildWsUrl(machine.baseUrl, machine.token);
        const existing = entries.get(machine.id);
        if (existing?.url === url) continue;
        existing?.connection.stop();

        const connection = createConnection({
          url,
          createSocket: options.createSocket,
          timers: options.timers ?? browserTimers,
          onStatus: (status) => options.onStatus(machine.id, status),
        });
        entries.set(machine.id, { url, connection });
        connection.start();
      }
    },

    get(machineId) {
      return entries.get(machineId)?.connection;
    },

    stopAll,
  };
}
