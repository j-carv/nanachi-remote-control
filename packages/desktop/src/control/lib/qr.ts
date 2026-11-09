import { create } from 'qrcode';

/** Light modules around the symbol, in module units. The QR code specification asks for four. */
export const QUIET_ZONE = 4;

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  readonly size: number;
  /** True for a dark module. */
  dark(row: number, col: number): boolean;
}

/** The modules of `text` at medium error correction, the level the desktop already uses for its pairing window. */
export function qrMatrix(text: string): QrMatrix {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  return { size: modules.size, dark: (row, col) => modules.get(row, col) === 1 };
}

/**
 * The dark modules as one SVG path in module units, offset by the quiet zone. Each horizontal run of dark modules is one
 * closed rectangle of height one. `viewBox` is the side of the whole drawing, quiet zone included.
 */
export function qrPath(matrix: QrMatrix): { viewBox: number; d: string } {
  let d = '';
  for (let row = 0; row < matrix.size; row += 1) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.dark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < matrix.size && matrix.dark(row, col)) col += 1;
      const length = col - start;
      d += `M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${length}v1h-${length}z`;
    }
  }
  return { viewBox: matrix.size + 2 * QUIET_ZONE, d };
}
