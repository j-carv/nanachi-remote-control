import type { FileInfo } from '@nanachi/shared';
import { canShareFiles } from './share.js';

/** Quanto tempo o link de download fica válido: o suficiente para o navegador iniciar o salvamento. */
const OBJECT_URL_TTL_MS = 60_000;

/** Salva um Blob como arquivo: cria um link temporário e dispara o clique. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Compartilhar pela folha nativa quando dá (iOS "Salvar em Arquivos", "Salvar Imagem" etc.);
 * senão, link de download. Fechar a folha sem escolher não é erro.
 */
export async function shareOrDownload(blob: Blob, file: FileInfo): Promise<void> {
  // O tipo do Blob já vem seguro de fetchFileBlob (blobTypeOf); o File herda dele, não do mime do remetente.
  const data = new File([blob], file.name, { type: blob.type });
  if (!canShareFiles(navigator, data)) {
    downloadBlob(blob, file.name);
    return;
  }
  try {
    await navigator.share({ files: [data], title: file.name });
  } catch (error) {
    if (!isAbortError(error)) throw error;
  }
}
