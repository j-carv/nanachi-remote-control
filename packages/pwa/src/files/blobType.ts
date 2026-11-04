/** Raster que o navegador mostra inline (mesma lista do daemon). SVG e HTML ficam de fora. */
const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const OCTET_STREAM = 'application/octet-stream';

/** Imagem que pode ser mostrada inline (miniatura e tela cheia). */
export function isInlineImageMime(mime: string): boolean {
  return INLINE_IMAGE_MIMES.has(mime);
}

/**
 * Tipo do Blob de um arquivo vindo do PC: o mime real só para raster inline; o resto é octet-stream, para que
 * nenhum conteúdo do agente seja aberto pelo navegador como página (HTML, SVG).
 */
export function blobTypeOf(mime: string): string {
  return isInlineImageMime(mime) ? mime : OCTET_STREAM;
}
