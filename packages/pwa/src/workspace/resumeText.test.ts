import type { AgentSessionSummary } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { listedSessionTitle } from './resumeText.js';

function local(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function summary(title: string | null, updatedAt: number | null): AgentSessionSummary {
  return { acpSessionId: 'a', title, updatedAt, linkedSessionId: null };
}

describe('listedSessionTitle', () => {
  it('keeps the agent title as it is, in any language', () => {
    expect(listedSessionTitle(summary('Refatorar o parser', local(2026, 11, 2, 8, 0)))).toBe('Refatorar o parser');
    setLanguage('en');
    expect(listedSessionTitle(summary('Refatorar o parser', local(2026, 11, 2, 8, 0)))).toBe('Refatorar o parser');
  });

  it('writes the date and time the Portuguese way', () => {
    expect(listedSessionTitle(summary(null, local(2026, 11, 3, 9, 5)))).toBe('Sessão de 03/11/2026 às 09:05');
    expect(listedSessionTitle(summary(null, local(2026, 11, 2, 18, 40)))).toBe('Sessão de 02/11/2026 às 18:40');
    expect(listedSessionTitle(summary(null, null))).toBe('Sessão sem título');
  });

  it('writes the date and time the English way', () => {
    setLanguage('en');
    // Newer ICU puts a narrow no-break space before AM/PM; compare with plain spaces.
    const text = listedSessionTitle(summary(null, local(2026, 11, 3, 18, 40))).replace(/\s/g, ' ');
    expect(text).toBe('Session from Nov 3, 2026 at 6:40 PM');
    expect(listedSessionTitle(summary(null, null))).toBe('Untitled session');
  });
});
