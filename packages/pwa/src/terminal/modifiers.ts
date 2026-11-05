/** Travas da barra: Ctrl e Alt valem para a próxima entrada e depois se desligam sozinhas. */
export interface StickyKeys {
  readonly ctrl: boolean;
  readonly alt: boolean;
}

export const NO_STICKY_KEYS: StickyKeys = { ctrl: false, alt: false };

export function hasSticky(keys: StickyKeys): boolean {
  return keys.ctrl || keys.alt;
}

/** Letras e os símbolos da faixa de controle (@ [ \ ] ^ _): Ctrl+X vira o byte X & 0x1f. */
const CONTROL_RANGE = /^[@A-Za-z[\\\]^_]$/;

/**
 * Aplica as travas a uma entrada. Ctrl converte só o primeiro caractere, se ele estiver na faixa de controle;
 * setas e outras sequências de escape passam sem mudança. Alt põe ESC na frente do que sobrou.
 */
export function applySticky(data: string, keys: StickyKeys): string {
  if (!hasSticky(keys) || data === '') return data;

  let out = data;
  if (keys.ctrl) {
    const first = Array.from(out)[0];
    if (first !== undefined && CONTROL_RANGE.test(first)) {
      const control = String.fromCharCode(first.toUpperCase().charCodeAt(0) & 0x1f);
      out = control + out.slice(first.length);
    }
  }
  if (keys.alt) out = `\x1b${out}`;
  return out;
}

/** Relatórios de foco que o próprio xterm envia ao receber/perder o foco. Não são digitação: não gastam a trava. */
const TERMINAL_REPORTS: ReadonlySet<string> = new Set(['\x1b[I', '\x1b[O']);

export function isUserKey(data: string): boolean {
  return !TERMINAL_REPORTS.has(data);
}
