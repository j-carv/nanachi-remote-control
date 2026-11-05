/**
 * Identidade do Tailscale vinda do `tailscale serve`. O header `Tailscale-User-Login` só vale quando o peer do socket
 * é loopback: o daemon escuta só em loopback (`ConfigSchema.host`), e o `tailscale serve` conecta dali. Qualquer
 * outro peer que mande o header é ignorado. Usado pela checagem global da allowlist e pelo pareamento por Tailscale.
 */

/** Loopback IPv4 (127.0.0.0/8), IPv6 `::1` e IPv6 mapeado em IPv4 (`::ffff:127.x.x.x`). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address.length === 0) return false;
  if (address === '::1') return true;
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Login do header quando o peer é loopback e o header existe (um valor só, não vazio). Undefined em qualquer outro
 * caso. Não confere a allowlist: quem chama decide o que fazer com o login.
 */
export function trustedTailscaleLogin(
  peerAddress: string | undefined,
  header: string | string[] | undefined,
): string | undefined {
  if (!isLoopbackAddress(peerAddress)) return undefined;
  if (typeof header !== 'string' || header.length === 0) return undefined;
  return header;
}
