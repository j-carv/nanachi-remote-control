import type { FileInfo } from '@nanachi/shared';

/** Máximo de anexos por mensagem (o schema do `prompt` aceita até 10 fileIds). */
export const ATTACHMENT_LIMIT = 10;

/** Quantos dos `incoming` novos cabem depois de `current` anexos já na prévia. */
export function acceptedCount(current: number, incoming: number): number {
  return Math.max(0, Math.min(incoming, ATTACHMENT_LIMIT - current));
}

/**
 * Envia os arquivos um por vez, na ordem. O progresso é a média: cada arquivo pesa 1/n,
 * então a barra anda de forma contínua mesmo com vários anexos. Erro no meio interrompe o envio.
 */
export async function uploadFiles<T extends File>(
  files: readonly T[],
  upload: (file: T, onProgress: (fraction: number) => void) => Promise<FileInfo>,
  onProgress: (fraction: number) => void,
): Promise<FileInfo[]> {
  const infos: FileInfo[] = [];
  for (const [index, file] of files.entries()) {
    const info = await upload(file, (fraction) => onProgress((index + fraction) / files.length));
    infos.push(info);
  }
  return infos;
}
