import { ApiError, type ApiErrorKind } from './api.js';
import { describeError } from './errorMessages.js';

/**
 * Caminho digitado no navegador de pastas, pronto para `/api/fs`: sem espaços nas pontas, sem um par
 * de aspas (o Explorer copia caminhos entre aspas) e com `\` como separador.
 * Vazio quando não sobra nada.
 */
export function normalizeTypedPath(input: string): string {
  let path = input.trim();
  const first = path.charAt(0);
  if (path.length >= 2 && (first === '"' || first === "'") && path.endsWith(first)) {
    path = path.slice(1, -1).trim();
  }
  return path.replaceAll('/', '\\');
}

/** Textos do campo "Digitar caminho". Os demais erros usam o texto geral da API. */
const TYPED_PATH_ERROR_TEXT: Partial<Record<ApiErrorKind, string>> = {
  outside_roots: 'Fora das pastas liberadas no PC',
  not_found: 'Pasta não encontrada',
  not_a_directory: 'Isso não é uma pasta',
};

export function typedPathErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const text = TYPED_PATH_ERROR_TEXT[error.kind];
    if (text !== undefined) return text;
  }
  return describeError(error);
}
