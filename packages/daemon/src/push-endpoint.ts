/** Hosts exatos dos serviços de push: Chrome/Android (FCM), Firefox (Mozilla) e Windows (WNS). */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);
/**
 * Subdomínios dos serviços de push: WNS (`*.notify.windows.com`) e Safari/iOS (`*.push.apple.com`, que também
 * cobre `web.push.apple.com`). O apex sozinho não entra.
 */
const ALLOWED_SUFFIXES: readonly string[] = ['.notify.windows.com', '.push.apple.com'];

/**
 * Endpoint de Web Push que o daemon aceita: https e host de um serviço de push conhecido. Sem isso, um device
 * poderia fazer o daemon chamar qualquer URL (SSRF) com o payload da notificação.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.has(host) || ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
