import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCountdown,
  formatDate,
  formatDateTime,
  formatPairingCode,
  formatRelative,
  languageOf,
  remainingFraction,
  secondsLeft,
} from '../../src/control/lib/format.js';
import { controlT } from './translator.js';

const ptBR = controlT('pt-BR');
const en = controlT('en');
const es = controlT('es');

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
    expect(formatBytes(bytes, 'pt-BR')).toBe(text);
  });

  it('rolls over to the next unit instead of showing 1.000', () => {
    expect(formatBytes(1023.9 * 1024, 'pt-BR')).toBe('1 MB');
  });

  it('shows a dash for unknown or invalid sizes', () => {
    expect(formatBytes(null, 'pt-BR')).toBe('—');
    expect(formatBytes(Number.NaN, 'pt-BR')).toBe('—');
    expect(formatBytes(-1, 'pt-BR')).toBe('—');
  });
});

describe('formatBytes follows the language', () => {
  const sizes = [1536, Math.round(12.34 * 1024 ** 3), Math.round(1.82 * 1024 ** 4), Math.round(238.4 * 1024 ** 3), 512];

  it('English uses the decimal point', () => {
    expect(sizes.map((bytes) => formatBytes(bytes, 'en'))).toEqual(['1.5 KB', '12.3 GB', '1.82 TB', '238 GB', '512 B']);
  });

  it('Spanish uses the decimal comma, like Portuguese', () => {
    expect(sizes.map((bytes) => formatBytes(bytes, 'es'))).toEqual(['1,5 KB', '12,3 GB', '1,82 TB', '238 GB', '512 B']);
    expect(sizes.map((bytes) => formatBytes(bytes, 'pt-BR'))).toEqual(['1,5 KB', '12,3 GB', '1,82 TB', '238 GB', '512 B']);
  });

  it('the dash for an unknown size is the same in every language', () => {
    expect(formatBytes(null, 'en')).toBe('—');
    expect(formatBytes(null, 'es')).toBe('—');
  });
});

describe('languageOf', () => {
  it('reads the language of an i18next instance, and falls back to pt-BR for anything else', () => {
    expect(languageOf({ language: 'en' })).toBe('en');
    expect(languageOf({ language: 'es' })).toBe('es');
    expect(languageOf({ language: 'pt-BR' })).toBe('pt-BR');
    expect(languageOf({ language: 'fr' })).toBe('pt-BR');
    expect(languageOf({ language: '' })).toBe('pt-BR');
  });
});

describe('dates', () => {
  const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

  it('formatDate: day, short month, year, no timezone surprises', () => {
    expect(formatDate(at(2026, 11, 5, 14, 32), ptBR)).toBe('5 nov 2026');
    expect(formatDate(at(2025, 3, 21), ptBR)).toBe('21 mar 2025');
  });

  it('formatDateTime adds the 24 h time', () => {
    expect(formatDateTime(at(2026, 11, 5, 9, 4), ptBR)).toBe('5 nov 2026, 09:04');
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
      expect(formatRelative(then, now, ptBR)).toBe(text);
    });

    it('null means never', () => {
      expect(formatRelative(null, now, ptBR)).toBe('Nunca');
    });
  });

  describe('every language has its own words', () => {
    const now = at(2026, 11, 5, 15, 0);
    const cases = [
      ['en', en, '5 Nov 2026', '5 Nov 2026, 09:04', ['just now', '1 min ago', '12 min ago', '3 h ago', 'yesterday', '3 days ago', '20 Oct 2026'], 'Never'],
      ['es', es, '5 nov 2026', '5 nov 2026, 09:04', ['hace un momento', 'hace 1 min', 'hace 12 min', 'hace 3 h', 'ayer', 'hace 3 días', '20 oct 2026'], 'Nunca'],
    ] as const;

    it.each(cases)('%s', (_language, t, date, dateTime, relative, never) => {
      expect(formatDate(at(2026, 11, 5, 14, 32), t)).toBe(date);
      expect(formatDateTime(at(2026, 11, 5, 9, 4), t)).toBe(dateTime);
      const moments = [now - 5_000, now - 60_000, now - 12 * 60_000, now - 3 * 3_600_000, at(2026, 11, 4, 22, 0), at(2026, 11, 2, 9, 0), at(2026, 10, 20, 9, 0)];
      expect(moments.map((then) => formatRelative(then, now, t))).toEqual([relative[0], relative[1], relative[2], relative[3], relative[4], relative[5], relative[6]]);
      expect(formatRelative(null, now, t)).toBe(never);
    });

    it('the twelve months of every language are all different from each other', () => {
      for (const t of [ptBR, en, es]) {
        const months = Array.from({ length: 12 }, (_, month) => formatDate(new Date(2026, month, 1).getTime(), t));
        expect(new Set(months).size).toBe(12);
      }
    });
  });
});

describe('plurals read from the dictionary', () => {
  it('Portuguese: singular only for exactly one (zero is plural, as the screens always wrote it)', () => {
    expect(ptBR('logs.lines', { count: 0 })).toBe('0 linhas');
    expect(ptBR('logs.lines', { count: 1 })).toBe('1 linha');
    expect(ptBR('logs.lines', { count: 2 })).toBe('2 linhas');
    expect(ptBR('accounts.count', { count: 0 })).toBe('0 contas');
    expect(ptBR('restart.busySessions', { count: 1 })).toBe('Há 1 sessão em andamento, que será interrompida.');
    expect(ptBR('restart.busySessions', { count: 2 })).toBe('Há 2 sessões em andamento, que serão interrompidas.');
  });

  it('English and Spanish', () => {
    expect([0, 1, 2].map((count) => en('logs.lines', { count }))).toEqual(['0 lines', '1 line', '2 lines']);
    expect([0, 1, 2].map((count) => es('logs.lines', { count }))).toEqual(['0 líneas', '1 línea', '2 líneas']);
    expect([1, 3].map((count) => en('folders.drive.included', { count }))).toEqual(['1 folder already included', '3 folders already included']);
    expect([1, 3].map((count) => es('folders.drive.allowed', { count }))).toEqual(['1 carpeta permitida en este disco', '3 carpetas permitidas en este disco']);
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
