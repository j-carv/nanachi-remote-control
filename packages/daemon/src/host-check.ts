/**
 * Checagem do header `Host` (anti DNS rebinding). Um site malicioso pode apontar um nome dele para 127.0.0.1 e
 * fazer o navegador da vítima chamar o daemon com `Host: evil.com`. Só o nome muda essa resposta, então a porta
 * não entra na regra: qualquer porta vale para os nomes aceitos.
 */

/** Forma aceita de um header Host: nome ou IPv6 entre colchetes, com porta opcional. Espaços e `@`/`/` ficam de fora. */
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i;
/** Nomes de loopback que o daemon atende (o `tailscale serve` e os testes via inject usam `localhost`). */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Qualquer máquina da tailnet (MagicDNS): `<nome>.<tailnet>.ts.net`. */
const TAILSCALE_SUFFIX = '.ts.net';
const MAX_PORT = 65535;

export interface HostHeaders {
  /** Header `Host` como chegou. Ausente → recusado. */
  host: string | undefined;
  /** Header `X-Forwarded-Host`. Pode ter vários valores separados por vírgula; todos precisam passar. */
  forwardedHost: string | undefined;
}

/** Nome do host sem porta, em minúsculas. Undefined se o texto não tem a forma de um Host. */
function hostnameOf(value: string): string | undefined {
  const match = HOST_PATTERN.exec(value);
  if (match === null) return undefined;
  const port = match[2];
  if (port !== undefined && Number(port) > MAX_PORT) return undefined;
  return match[1]?.toLowerCase();
}

/** Hostnames das origens de `corsOrigins` (PC principal, para o PWA em outro PC). Entradas inválidas são ignoradas. */
function corsHostnamesOf(origins: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const origin of origins) {
    try {
      names.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // Config já validada no load; se chegou aqui uma entrada ruim, ela simplesmente não casa.
    }
  }
  return names;
}

/** Cria a checagem com os hosts de `corsOrigins` já calculados. */
export function createHostCheck(corsOrigins: readonly string[]): (headers: HostHeaders) => boolean {
  const corsHostnames = corsHostnamesOf(corsOrigins);

  function isAllowedValue(value: string): boolean {
    const hostname = hostnameOf(value);
    if (hostname === undefined) return false;
    if (LOOPBACK_HOSTNAMES.has(hostname) || corsHostnames.has(hostname)) return true;
    return hostname.endsWith(TAILSCALE_SUFFIX) && hostname.length > TAILSCALE_SUFFIX.length;
  }

  return ({ host, forwardedHost }) => {
    if (host === undefined || !isAllowedValue(host)) return false;
    if (forwardedHost === undefined) return true;
    return forwardedHost.split(',').every((value) => isAllowedValue(value.trim()));
  };
}
