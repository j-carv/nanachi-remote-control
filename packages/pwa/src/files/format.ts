const KB = 1024;
const MB = KB * KB;

/** Tamanho legível em pt-BR: "512 B", "2 KB", "5,0 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / MB).toFixed(1).replace('.', ',')} MB`;
}

/** Imagens viram miniatura e tela cheia; o resto vira cartão com botão de baixar. */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}
