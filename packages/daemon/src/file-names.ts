/** Limite de um arquivo trocado com o celular (anexo ou `phone-send`): 50 MiB. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const FALLBACK_NAME = 'arquivo';
const NAME_MAX_CHARS = 120;
const EXTENSION_MAX_CHARS = 16;
const DEFAULT_MIME = 'application/octet-stream';
/** Raster que o navegador mostra inline e que é seguro servir com o mime real. SVG, HTML e o resto não entram. */
const INLINE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Caracteres que o Windows não aceita em nome de arquivo, mais os de controle. */
const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Separadores de caminho (Windows e POSIX): o nome enviado pode trazer pastas. */
const PATH_SEPARATORS = /[\\/]/;
/** Nomes reservados do DOS/Windows (com ou sem extensão), inclusive COM¹/LPT² com dígitos sobrescritos. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i;
const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const MIME_MAX_CHARS = 100;
const NON_ASCII = /[^\x20-\x7e]/g;
const HEADER_UNSAFE = /["\\]/g;

/**
 * Nome seguro para gravar e exibir: só o basename, sem caracteres proibidos no Windows, sem nomes reservados,
 * até 120 caracteres (a extensão é preservada quando o nome é cortado). Vazio vira "arquivo".
 */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(PATH_SEPARATORS).pop() ?? '';
  const cleaned = base.replace(FORBIDDEN_CHARS, '_').trim().replace(/[. ]+$/, '');
  if (cleaned.length === 0) return FALLBACK_NAME;

  const named = RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
  return truncateKeepingExtension(named, NAME_MAX_CHARS);
}

function truncateKeepingExtension(name: string, maxChars: number): string {
  if (Array.from(name).length <= maxChars) return name;

  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= EXTENSION_MAX_CHARS ? name.slice(dot) : '';
  const stem = Array.from(name.slice(0, name.length - extension.length));
  return stem.slice(0, maxChars - Array.from(extension).length).join('') + extension;
}

/** Tipo MIME sem parâmetros e em minúsculas. Ausente ou malformado vira application/octet-stream. */
export function normalizeMime(raw: string | undefined): string {
  const type = raw?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return type.length > 0 && type.length <= MIME_MAX_CHARS && MIME_PATTERN.test(type) ? type : DEFAULT_MIME;
}

/** Raster que o navegador mostra na própria página (png, jpeg, gif, webp). */
export function isInlineMime(mime: string): boolean {
  return INLINE_MIMES.has(mime);
}

/**
 * Content-Type do download: o mime real só para raster inline; todo o resto vai como octet-stream, para que
 * nenhum arquivo do agente (HTML, SVG, script) seja interpretado pelo navegador.
 */
export function servedMimeOf(mime: string): string {
  return isInlineMime(mime) ? mime : DEFAULT_MIME;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Content-Disposition: inline para raster inline, attachment para o resto; nome em filename* (RFC 5987). */
export function contentDisposition(name: string, mime: string): string {
  const disposition = isInlineMime(mime) ? 'inline' : 'attachment';
  const ascii = name.replace(NON_ASCII, '_').replace(HEADER_UNSAFE, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
