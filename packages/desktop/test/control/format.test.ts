import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCountdown,
  formatDate,
  formatDateTime,
  formatPairingCode,
  formatRelative,
  pluralize,
  remainingFraction,
  secondsLeft,
} from '../../src/control/lib/format.js';

describe('formatBytes (pt-BR, binary units)', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1 KB'],
    [1536, '1,5 KB'],
    [10 * 1024 ** 2, '10 MB'],
    [Math.round(1.234 * 1024 ** 3), '1,23 GB'],
    [Math.round(12.34 * 1024 ** 3), '12,3 GB'],
    [Math.round(238.4 * 1024 ** 3), '238 GB'],
    [Math.round(1.82 * 1024 ** 4), '1,82 TB'],
  ])('%d bytes -> %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it('rolls over to the next unit instead of showing 1.000', () => {
    expect(formatBytes(1023.9 * 1024)).toBe('1 MB');
  });

  it('shows a dash for unknown or invalid sizes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('dates', () => {
  const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

  it('formatDate: day, short month, year, no timezone surprises', () => {
    expect(formatDate(at(2026, 11, 5, 14, 32))).toBe('5 nov 2026');
    expect(formatDate(at(2025, 3, 21))).toBe('21 mar 2025');
  });

  it('formatDateTime adds the 24 h time', () => {
    expect(formatDateTime(at(2026, 11, 5, 9, 4))).toBe('5 nov 2026, 09:04');
  });

  describe('formatRelative', () => {
    const now = at(2026, 11, 5, 15, 0);
    it.each([
      [now - 5_000, 'agora há pouco'],
      [now + 60_000, 'agora há pouco'],
      [now - 60_000, 'há 1 min'],
      [now - 12 * 60_000, 'há 12 min'],
      [now - 3 * 3_600_000, 'há 3 h'],
      [at(2026, 11, 4, 22, 0), 'ontem'],
      [at(2026, 11, 2, 9, 0), 'há 3 dias'],
      [at(2026, 10, 20, 9, 0), '20 out 2026'],
    ])('%d -> %s', (then, text) => {
      expect(formatRelative(then, now)).toBe(text);
    });

    it('null means never', () => {
      expect(formatRelative(null, now)).toBe('Nunca');
    });
  });
});

describe('pluralize', () => {
  it('uses the singular only for exactly one', () => {
    expect(pluralize(0, 'sessão', 'sessões')).toBe('0 sessões');
    expect(pluralize(1, 'sessão', 'sessões')).toBe('1 sessão');
    expect(pluralize(2, 'sessão', 'sessões')).toBe('2 sessões');
  });
});

describe('pairing countdown', () => {
  it('formats m:ss and clamps at zero', () => {
    expect(formatCountdown(272_000)).toBe('4:32');
    expect(formatCountdown(299_100)).toBe('5:00');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5_000)).toBe('0:00');
  });

  it('secondsLeft rounds up and never goes negative', () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1);
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(9_000, 10_000)).toBe(0);
  });

  it('remainingFraction is clamped to 0..1 and survives a zero-length window', () => {
    expect(remainingFraction(2_000, 1_000, 1_500)).toBeCloseTo(0.5);
    expect(remainingFraction(2_000, 1_000, 3_000)).toBe(0);
    expect(remainingFraction(2_000, 1_000, 0)).toBe(1);
    expect(remainingFraction(1_000, 1_000, 1_000)).toBe(0);
  });

  it('groups the six digits in two blocks', () => {
    expect(formatPairingCode('482915')).toBe('482 915');
    expect(formatPairingCode('1234')).toBe('1234');
  });
});
