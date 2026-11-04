import { WebSocket } from 'ws';

/**
 * Sockets WS abertos, agrupados por dispositivo. O server registra e remove; o notificador de Web Push consulta
 * `hasLiveConnection` para não mandar push a quem já está com o app aberto (o WS já entrega ali).
 */
export class LiveConnections {
  private readonly byDevice = new Map<string, Set<WebSocket>>();

  add(deviceId: string, socket: WebSocket): void {
    const sockets = this.byDevice.get(deviceId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.byDevice.set(deviceId, sockets);
  }

  remove(deviceId: string, socket: WebSocket): void {
    const sockets = this.byDevice.get(deviceId);
    if (sockets === undefined) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.byDevice.delete(deviceId);
  }

  /** Há pelo menos um WS desse dispositivo ainda aberto (não em fechamento). */
  hasLiveConnection(deviceId: string): boolean {
    for (const socket of this.byDevice.get(deviceId) ?? []) {
      if (socket.readyState === WebSocket.OPEN) return true;
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
  all(): WebSocket[] {
    return [...this.byDevice.values()].flatMap((sockets) => [...sockets]);
  }
}
