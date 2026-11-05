import type { FileInfo } from '@nanachi/shared';
import { t } from '../i18n/index.js';

/** Extensão do nome de cada raster que o daemon grava (mesma tabela de `agent-images.ts`). */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Imagem de tool call vem só com fileId e mime (`ToolContent` image). Para mostrar e salvar pelo visualizador,
 * monta o FileInfo com um nome genérico ("imagem" / "image"); o tamanho não é conhecido e não é mostrado.
 */
export function toolImageInfo(fileId: string, mime: string): FileInfo {
  const extension = EXTENSION_BY_MIME[mime];
  const base = t('files:toolImage.name');
  return { fileId, name: extension === undefined ? base : `${base}.${extension}`, mime, size: 0 };
}
