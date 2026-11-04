/** Campos de uma requisição HTTP que o log precisa. */
export interface LoggableRequest {
  method?: string;
  url?: string;
  socket: { remoteAddress?: string | undefined; remotePort?: number | undefined };
}

/**
 * Serializer do log de requisições. Remove a query string: o WebSocket manda o token em `?token=`
 * e o log padrão do Fastify registraria a URL inteira.
 */
export function serializeRequest(req: LoggableRequest): {
  method: string;
  url: string;
  remoteAddress: string;
  remotePort: number;
} {
  return {
    method: req.method ?? '',
    url: (req.url ?? '').split('?', 1)[0] ?? '',
    remoteAddress: req.socket.remoteAddress ?? 'desconhecido',
    remotePort: req.socket.remotePort ?? 0,
  };
}
