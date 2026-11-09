import { WebSocket } from 'ws';

/** What the registry uses from a socket: its state (open or not) and closing. Tests pass an object with just that. */
export type LiveSocket = Pick<WebSocket, 'readyState' | 'close'>;

/**
 * Open WS sockets, grouped by device, and the sessions each socket follows (it sent `subscribe` and not `unsubscribe`
 * yet). The server adds, subscribes and removes; the Web Push notifier asks `hasLiveSubscription` so it does not send a
 * session's push to someone already watching it in the app (the WS delivers it there).
 */
export class LiveConnections<S extends LiveSocket = WebSocket> {
  private readonly byDevice = new Map<string, Set<S>>();
  /** Sessions each socket follows. Dropped together with the socket in `remove`. */
  private readonly subscribed = new Map<S, Set<string>>();

  add(deviceId: string, socket: S): void {
    const sockets = this.byDevice.get(deviceId) ?? new Set<S>();
    sockets.add(socket);
    this.byDevice.set(deviceId, sockets);
  }

  /** Removes the socket from the device and releases the sessions it followed. */
  remove(deviceId: string, socket: S): void {
    this.subscribed.delete(socket);
    const sockets = this.byDevice.get(deviceId);
    if (sockets === undefined) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.byDevice.delete(deviceId);
  }

  /** The socket starts following the session (a `subscribe` message). */
  subscribe(socket: S, sessionId: string): void {
    const sessions = this.subscribed.get(socket) ?? new Set<string>();
    sessions.add(sessionId);
    this.subscribed.set(socket, sessions);
  }

  /** The socket stops following the session (an `unsubscribe` message, or a new subscribe that replaces it). */
  unsubscribe(socket: S, sessionId: string): void {
    this.subscribed.get(socket)?.delete(sessionId);
  }

  /**
   * An open WS of this device follows the session: the app already shows what happens there, so no push is sent for it.
   * Other sessions and other screens do not count; a socket that is closing does not count.
   */
  hasLiveSubscription(deviceId: string, sessionId: string): boolean {
    for (const socket of this.byDevice.get(deviceId) ?? []) {
      if (socket.readyState === WebSocket.OPEN && this.subscribed.get(socket)?.has(sessionId) === true) return true;
    }
    return false;
  }

  /** Fecha todos os sockets do device com o código dado (ex.: 4401 quando o device é revogado). */
  closeDevice(deviceId: string, code: number, reason: string): void {
    for (const socket of this.byDevice.get(deviceId) ?? []) {
      socket.close(code, reason);
    }
  }

  /** Todos os sockets registrados (para broadcast). */
  all(): S[] {
    return [...this.byDevice.values()].flatMap((sockets) => [...sockets]);
  }
}
