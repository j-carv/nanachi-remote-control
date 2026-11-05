// The helpers that build text from data (relative time, plurals, dates, sizes), read in Spanish. The suite runs in pt-BR
// (`vitest.setup.ts`), so each test switches the language itself and is put back afterwards.
import type { AgentSessionSummary, ResetEntry } from '@nanachi/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { changesLabel } from '../components/changesLabel.js';
import { formatBytes } from '../files/format.js';
import { formatRelativeTime } from '../relativeTime.js';
import { displaySessionTitle, sessionStatusText, sessionTitle } from '../sessionText.js';
import { redeemConfirmText, resetCountsText, resetExpiryText } from '../usage/resetsModel.js';
import { listedSessionTitle } from '../workspace/resumeText.js';
import { formatSize } from '../workspace/paths.js';
import { currentLanguage, setLanguage, t } from './index.js';

beforeEach(() => {
  setLanguage('es');
});

// Dates in the local time zone: the tests do not depend on the machine's zone.
const NOW = new Date(2026, 10, 3, 14, 0, 0).getTime();
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe('formatRelativeTime in Spanish', () => {
  it('uses the Spanish phrases', () => {
    expect(currentLanguage()).toBe('es');
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('ahora');
    expect(formatRelativeTime(NOW + 5 * MINUTE_MS, NOW)).toBe('ahora');
    expect(formatRelativeTime(NOW - 5 * MINUTE_MS, NOW)).toBe('hace 5 min');
    expect(formatRelativeTime(NOW - 2 * HOUR_MS, NOW)).toBe('hace 2 h');
    expect(formatRelativeTime(new Date(2026, 10, 2, 23, 30, 0).getTime(), NOW)).toBe('ayer');
  });

  it('writes older dates day first, with a leading zero', () => {
    expect(formatRelativeTime(new Date(2026, 9, 28, 9, 0, 0).getTime(), NOW)).toBe('28/10/2026');
    expect(formatRelativeTime(new Date(2026, 0, 5, 9, 0, 0).getTime(), NOW)).toBe('05/01/2026');
  });
});

describe('plurals in Spanish', () => {
  it('picks _one for 1 and _other for the rest, zero included', () => {
    expect(t('common:showAll', { count: 1 })).toBe('Mostrar todo (1 línea)');
    expect(t('common:showAll', { count: 0 })).toBe('Mostrar todo (0 líneas)');
    expect(t('common:showAll', { count: 12 })).toBe('Mostrar todo (12 líneas)');
    expect(t('machines:card.workspaces', { count: 1 })).toBe('1 workspace');
    expect(t('machines:card.workspaces', { count: 2 })).toBe('2 workspaces');
    expect(t('machines:card.idle', { count: 1 })).toBe('1 lista');
    expect(t('machines:card.idle', { count: 3 })).toBe('3 listas');
  });

  it('picks _many from one million on, with the "de" Spanish puts before the noun', () => {
    expect(t('common:showAll', { count: 1_000_000 })).toBe('Mostrar todo (1000000 de líneas)');
    expect(t('machines:card.workspaces', { count: 2_000_000 })).toBe('2000000 de workspaces');
    expect(t('chat:loop.summary.upTo', { count: 1_000_000 })).toBe('hasta 1000000 de rondas');
    expect(t('usage:resets.saved', { count: 1_000_000 })).toBe('1000000 guardados');
  });

  it('agrees the participle: guardado/guardados, disponible/disponibles, with zero in the plural', () => {
    expect(t('usage:resets.saved', { count: 0 })).toBe('0 guardados');
    expect(t('usage:resets.saved', { count: 1 })).toBe('1 guardado');
    expect(t('usage:resets.saved', { count: 3 })).toBe('3 guardados');
    expect(t('usage:resets.usable', { count: 0 })).toBe('0 disponibles ahora');
    expect(t('usage:resets.usable', { count: 1 })).toBe('1 disponible ahora');
  });

  it('changesLabel says "sin cambios" for zero, then singular and plural', () => {
    expect(changesLabel(0)).toBe('sin cambios');
    expect(changesLabel(1)).toBe('1 cambio');
    expect(changesLabel(3)).toBe('3 cambios');
    expect(changesLabel(1_000_000)).toBe('1000000 de cambios');
  });

  it('keeps the placeholders in the counted texts', () => {
    expect(t('chat:item.thoughtSize', { count: 1 })).toBe('1 carácter');
    expect(t('chat:item.thoughtSize', { count: 42 })).toBe('42 caracteres');
    expect(t('chat:tool.linesAdded', { count: 1 })).toBe('1 línea agregada');
    expect(t('chat:tool.linesAdded', { count: 7 })).toBe('7 líneas agregadas');
    expect(t('chat:loop.summary.untilDoneOrUpTo', { count: 1 })).toBe('hasta que diga que terminó o llegue a 1 ronda');
    expect(t('chat:loop.summary.untilDoneOrUpTo', { count: 5 })).toBe('hasta que diga que terminó o llegue a 5 rondas');
  });
});

describe('the reset texts in Spanish', () => {
  const entry = (overrides: Partial<ResetEntry> = {}): ResetEntry => ({
    target: 'anthropic/1',
    accountLabel: 'fake@example.com',
    providerLabel: 'Anthropic',
    available: 2,
    usable: 1,
    expiresAt: null,
    note: null,
    active: true,
    ...overrides,
  });
  const NOW_RESET = new Date(2026, 10, 5, 12, 0).getTime();

  it('resetCountsText says saved and available now, in the right number', () => {
    expect(resetCountsText(entry({ available: 2, usable: 1 }))).toBe('2 guardados · 1 disponible ahora');
    expect(resetCountsText(entry({ available: 1, usable: 0 }))).toBe('1 guardado · 0 disponibles ahora');
    expect(resetCountsText(entry({ available: 0, usable: 0 }))).toBe('0 guardados · 0 disponibles ahora');
  });

  it('resetExpiryText keeps the text omp prints and words the ISO dates of codex', () => {
    expect(resetExpiryText('in 3 days', NOW_RESET)).toBe('vence in 3 days');
    expect(resetExpiryText(new Date(NOW_RESET + 45 * MINUTE_MS).toISOString(), NOW_RESET)).toBe('vence en 45 min');
    expect(resetExpiryText(new Date(NOW_RESET + 5 * HOUR_MS + 30 * MINUTE_MS).toISOString(), NOW_RESET)).toBe('vence en 5 h');
    expect(resetExpiryText(new Date(NOW_RESET + 30 * HOUR_MS).toISOString(), NOW_RESET)).toBe('vence en 1 día');
    expect(resetExpiryText(new Date(NOW_RESET + 3 * DAY_MS + HOUR_MS).toISOString(), NOW_RESET)).toBe('vence en 3 días');
    expect(resetExpiryText(new Date(NOW_RESET - MINUTE_MS).toISOString(), NOW_RESET)).toBe('venció');
  });

  it('resetExpiryText writes a far date day first', () => {
    expect(resetExpiryText(new Date(2026, 10, 20, 9, 0).toISOString(), NOW_RESET)).toBe('vence el 20/11/2026');
  });

  it('redeemConfirmText', () => {
    expect(redeemConfirmText(entry())).toEqual({
      title: '¿Usar 1 reset?',
      body: 'fake@example.com · Anthropic. Gasta un reset guardado y libera el límite ahora. No se puede deshacer.',
    });
  });
});

describe('session texts in Spanish', () => {
  it('translates the placeholder title of the daemon and the terminal title, and keeps any other title', () => {
    expect(displaySessionTitle('Nova sessão')).toBe('Nueva sesión');
    expect(displaySessionTitle('Corrigir build')).toBe('Corrigir build');
    expect(sessionTitle({ title: 'Nova sessão', kind: 'pty' }, 'PowerShell')).toBe('PowerShell · terminal');
    expect(sessionTitle({ title: 'Nova sessão', kind: 'acp' }, 'Claude')).toBe('Nueva sesión');
  });

  it('writes the status of a conversation and of a terminal', () => {
    expect(sessionStatusText('running', 'acp')).toBe('Trabajando');
    expect(sessionStatusText('running', 'pty')).toBe('En ejecución');
    expect(sessionStatusText('awaiting_permission', 'acp')).toBe('Esperando permiso');
    expect(sessionStatusText('stopped', 'acp')).toBe('Finalizada');
    expect(sessionStatusText('stopped', 'pty')).toBe('Finalizada');
  });

  it('listedSessionTitle keeps the agent title and writes the date and time of an untitled one', () => {
    const summary = (title: string | null, updatedAt: number | null): AgentSessionSummary => ({
      acpSessionId: 'a',
      title,
      updatedAt,
      linkedSessionId: null,
    });
    expect(listedSessionTitle(summary('Refactor del parser', new Date(2026, 10, 2, 8, 0).getTime()))).toBe('Refactor del parser');
    expect(listedSessionTitle(summary(null, new Date(2026, 10, 3, 9, 5).getTime()))).toBe('Sesión del 03/11/2026 a las 09:05');
    expect(listedSessionTitle(summary(null, new Date(2026, 10, 2, 18, 40).getTime()))).toBe('Sesión del 02/11/2026 a las 18:40');
    expect(listedSessionTitle(summary(null, null))).toBe('Sesión sin título');
  });
});

describe('sizes in Spanish', () => {
  it('write the decimal with a comma', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5,0 MB');
    expect(formatSize(1536)).toBe('1,5 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3,0 MB');
  });
});
