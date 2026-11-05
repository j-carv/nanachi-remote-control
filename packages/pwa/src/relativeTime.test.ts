import { describe, expect, it } from 'vitest';
import { setLanguage } from './i18n/index.js';
import { formatRelativeTime } from './relativeTime.js';

// Datas no fuso local: o teste não depende do fuso da máquina que roda.
const NOW = new Date(2026, 10, 3, 14, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 3_600_000;

describe('formatRelativeTime', () => {
  it('menos de um minuto é "agora"', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('agora');
  });

  it('timestamp no futuro (relógio do PC adiantado) também é "agora"', () => {
    expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe('agora');
  });

  it('menos de uma hora mostra minutos', () => {
    expect(formatRelativeTime(NOW - 5 * MIN, NOW)).toBe('há 5 min');
    expect(formatRelativeTime(NOW - 59 * MIN, NOW)).toBe('há 59 min');
  });

  it('no mesmo dia, uma hora ou mais mostra horas', () => {
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW)).toBe('há 2 h');
  });

  it('dia anterior no calendário é "ontem", mesmo com menos de 24 h', () => {
    const lateYesterday = new Date(2026, 10, 2, 23, 30, 0).getTime();
    expect(formatRelativeTime(lateYesterday, NOW)).toBe('ontem');
  });

  it('antes de ontem mostra a data dd/mm/aaaa', () => {
    const older = new Date(2026, 9, 28, 9, 0, 0).getTime();
    expect(formatRelativeTime(older, NOW)).toBe('28/10/2026');
  });

  it('dia e mês de um dígito saem com zero à esquerda', () => {
    const early = new Date(2026, 0, 5, 9, 0, 0).getTime();
    expect(formatRelativeTime(early, NOW)).toBe('05/01/2026');
  });
});

describe('formatRelativeTime in English', () => {
  it('uses the English phrases', () => {
    setLanguage('en');
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('now');
    expect(formatRelativeTime(NOW - 5 * MIN, NOW)).toBe('5 min ago');
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW)).toBe('2 h ago');
    expect(formatRelativeTime(new Date(2026, 10, 2, 23, 30, 0).getTime(), NOW)).toBe('yesterday');
  });

  it('writes older dates with the month abbreviated', () => {
    setLanguage('en');
    expect(formatRelativeTime(new Date(2026, 9, 28, 9, 0, 0).getTime(), NOW)).toBe('Oct 28, 2026');
    expect(formatRelativeTime(new Date(2026, 0, 5, 9, 0, 0).getTime(), NOW)).toBe('Jan 5, 2026');
  });
});
