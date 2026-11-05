import { ApiError, type ApiErrorKind } from './api.js';
import { describeError } from './errorMessages.js';
import { t } from './i18n/index.js';

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

/** Error kinds that have their own text in the "Digitar caminho" / "Type a path" field (`workspace:folders.pathError`). */
const TYPED_PATH_ERROR_KINDS = ['outside_roots', 'not_found', 'not_a_directory'] as const satisfies readonly ApiErrorKind[];

/** Text for a failed typed path. The other errors use the general API text. */
export function typedPathErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const { kind } = error;
    const known = TYPED_PATH_ERROR_KINDS.find((candidate) => candidate === kind);
    if (known !== undefined) return t(`workspace:folders.pathError.${known}`);
  }
  return describeError(error);
}
