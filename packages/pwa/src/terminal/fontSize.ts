import type { StorageLike } from '../machines.js';

/** Tamanho da fonte do terminal, por aparelho (localStorage). É preferência de tela, não estado do daemon. */
export const FONT_SIZE_KEY = 'nanachi.terminalFontSize';
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 22;

/** Limita a faixa e arredonda. Valor que não é número finito volta ao padrão. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

/** Lê o tamanho salvo. Sem valor, valor inválido ou storage que lança: o padrão. */
export function readFontSize(storage: StorageLike): number {
  try {
    const raw = storage.getItem(FONT_SIZE_KEY);
    if (raw === null) return DEFAULT_FONT_SIZE;
    return clampFontSize(Number(raw));
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

/** Grava o tamanho. Falha de storage não é erro para o usuário: a fonte só não fica salva. */
export function writeFontSize(storage: StorageLike, size: number): void {
  try {
    storage.setItem(FONT_SIZE_KEY, String(clampFontSize(size)));
  } catch {
    // Sem persistência, o tamanho volta ao padrão na próxima abertura.
  }
}
