import { currentLanguage } from '../i18n/index.js';

const KB = 1024;
const MB = KB * KB;

/** Tamanho legível no idioma atual: "512 B", "2 KB", "5,0 MB" em português e "5.0 MB" em inglês. */
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  const megabytes = new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${megabytes.format(bytes / MB)} MB`;
}

/** Imagens viram miniatura e tela cheia; o resto vira cartão com botão de baixar. */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}
