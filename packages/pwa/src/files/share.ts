/** Subconjunto de `navigator` usado para compartilhar arquivos (Web Share Level 2). */
export interface ShareNavigator {
  share?: unknown;
  canShare?: unknown;
}

/**
 * Compartilhar um arquivo pela folha nativa (iOS: "Salvar em Arquivos", "Salvar Imagem" etc.).
 * Sem `share`/`canShare` ou se o navegador recusar o tipo, a UI cai para o link de download.
 */
export function canShareFiles(nav: ShareNavigator, file: File): boolean {
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  const canShare = nav.canShare as (data: ShareData) => boolean;
  return canShare.call(nav, { files: [file] });
}
