/** Campos do upgrade do WS que decidem se a origem do navegador é aceita. */
export interface WsOriginRequest {
  /** Header `Origin`. Ausente em clientes que não são navegador. */
  origin: string | undefined;
  /** Header `Host` como chegou no daemon. */
  host: string | undefined;
  /** `X-Forwarded-Host` (o `tailscale serve` põe aqui o nome público). Pode ter vários valores separados por vírgula. */
  forwardedHost: string | undefined;
  /** `X-Forwarded-Proto`. Mesmo critério do host: o primeiro valor. */
  forwardedProto: string | undefined;
  /** O socket já é TLS (daemon exposto direto com https). */
  encrypted: boolean;
}

/** Primeiro valor de um header que pode vir como lista (`a, b`). Vazio vira undefined. */
function firstValue(value: string | undefined): string | undefined {
  const first = value?.split(',', 1)[0]?.trim();
  return first === undefined || first.length === 0 ? undefined : first;
}

/** `scheme://host[:porta]` normalizado (host em minúsculas, porta padrão omitida), ou undefined se não for http(s). */
function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Origem própria do daemon: esquema e host como o navegador os vê. Atrás do `tailscale serve`, o host público
 * vem em X-Forwarded-Host e o esquema em X-Forwarded-Proto; sem eles, vale o Host e o tipo do socket.
 */
function ownOrigin(request: WsOriginRequest): string | undefined {
  const host = firstValue(request.forwardedHost) ?? request.host;
  if (host === undefined) return undefined;
  const proto = firstValue(request.forwardedProto) ?? (request.encrypted ? 'https' : 'http');
  return originOf(`${proto}://${host}`);
}

/**
 * Checagem de Origin no upgrade do WS (anti sequestro entre sites). Aceita: Origin ausente (cliente que não é
 * navegador), a própria origem do daemon e as de `corsOrigins`. Qualquer outra (inclusive "null") é recusada.
 */
export function isAllowedWsOrigin(request: WsOriginRequest, corsOrigins: readonly string[]): boolean {
  if (request.origin === undefined) return true;

  const origin = originOf(request.origin);
  if (origin === undefined) return false;
  if (origin === ownOrigin(request)) return true;

  return corsOrigins.some((allowed) => originOf(allowed) === origin);
}
