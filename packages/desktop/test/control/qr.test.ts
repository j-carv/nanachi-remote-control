import { describe, expect, it } from 'vitest';
import { QUIET_ZONE, qrMatrix, qrPath } from '../../src/control/lib/qr.js';

const LINK = 'https://nanachi-office-pc.tail1234.ts.net/#pair=482915';

describe('qrMatrix', () => {
  it('is a square with the size of a QR version (21 + 4 per version)', () => {
    const { size } = qrMatrix(LINK);
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 21) % 4).toBe(0);
  });

  it('draws the three finder patterns in the corners that have one', () => {
    const matrix = qrMatrix(LINK);
    const last = matrix.size - 1;
    for (const [row, col] of [
      [0, 0],
      [0, last - 6],
      [last - 6, 0],
    ] as const) {
      // Outer ring dark, inner ring light, 3x3 centre dark.
      expect(matrix.dark(row, col), `corner ${row},${col}`).toBe(true);
      expect(matrix.dark(row + 1, col + 1), `ring ${row},${col}`).toBe(false);
      expect(matrix.dark(row + 3, col + 3), `centre ${row},${col}`).toBe(true);
    }
  });

  it('is the same for the same link, and different for another code', () => {
    const same = qrMatrix(LINK);
    const again = qrMatrix(LINK);
    const other = qrMatrix('https://nanachi-office-pc.tail1234.ts.net/#pair=482916');
    const cells = (m: ReturnType<typeof qrMatrix>): string => {
      const rows: string[] = [];
      for (let row = 0; row < m.size; row += 1) {
        let line = '';
        for (let col = 0; col < m.size; col += 1) line += m.dark(row, col) ? '1' : '0';
        rows.push(line);
      }
      return rows.join('\n');
    };
    expect(cells(same)).toBe(cells(again));
    expect(cells(same)).not.toBe(cells(other));
  });
});

describe('qrPath', () => {
  it('sets the symbol inside a quiet zone of four modules on each side', () => {
    const matrix = qrMatrix(LINK);
    const { viewBox } = qrPath(matrix);
    expect(QUIET_ZONE).toBe(4);
    expect(viewBox).toBe(matrix.size + 2 * QUIET_ZONE);
  });

  it('starts the first dark run of the top-left finder pattern at the quiet zone', () => {
    const { d } = qrPath(qrMatrix(LINK));
    // The first finder row is seven dark modules, drawn at (quiet zone, quiet zone).
    expect(d.startsWith('M4 4h7v1h-7z')).toBe(true);
  });

  it('covers exactly the dark modules: one closed run per horizontal run of them', () => {
    const matrix = qrMatrix(LINK);
    let runs = 0;
    let dark = 0;
    for (let row = 0; row < matrix.size; row += 1) {
      let inRun = false;
      for (let col = 0; col < matrix.size; col += 1) {
        const isDark = matrix.dark(row, col);
        if (isDark) dark += 1;
        if (isDark && !inRun) runs += 1;
        inRun = isDark;
      }
    }
    const { d } = qrPath(matrix);
    expect(d.split('M')).toHaveLength(runs + 1);
    expect(runs).toBeGreaterThan(0);
    expect(dark).toBeGreaterThan(runs);
  });
});
