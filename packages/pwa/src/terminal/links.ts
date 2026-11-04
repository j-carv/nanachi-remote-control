/**
 * Link de saída do terminal que o app abre. Só http e https: `javascript:`, `file:`, `data:`, `blob:` e caminhos
 * relativos são ignorados. Devolve a URL normalizada, ou undefined.
 */
export function webLinkOf(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
}
