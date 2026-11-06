import { describe, expect, it } from 'vitest';
import { truncateMiddle } from './truncateMiddle.js';

/** A fake measure: every character is one unit wide. */
const within = (units: number) => (candidate: string) => Array.from(candidate).length <= units;

describe('truncateMiddle', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateMiddle('Nanachi-Remote', within(14))).toBe('Nanachi-Remote');
  });

  it('keeps the start and the end and puts one ellipsis in the middle', () => {
    // 9 units: the ellipsis takes one, and the rest splits 4 at the start and 4 at the end.
    expect(truncateMiddle('abcdefghijklmnop', within(9))).toBe('abcd…mnop');
  });

  it('gives the end the extra character when the budget is odd, so the last name stays readable', () => {
    // 8 units: 3 at the start, 4 at the end.
    expect(truncateMiddle('abcdefghijklmnop', within(8))).toBe('abc…mnop');
  });

  it('keeps the whole last folder name when the budget allows it', () => {
    // The name is 14 characters: the end takes half the budget (14 of 28), so a 28-unit budget keeps it whole.
    const path = 'C:\\Users\\alice\\Projects\\Nanachi-Remote';
    const shown = truncateMiddle(path, within(28));
    expect(shown.endsWith('Nanachi-Remote')).toBe(true);
    expect(shown).toContain('…');
    expect(Array.from(shown).length).toBeLessThanOrEqual(28);
  });

  it('never splits a surrogate pair (a code point is one unit)', () => {
    expect(truncateMiddle('ab😀cd', within(4))).toBe('a…cd');
  });

  it('returns only the ellipsis when not even that fits', () => {
    expect(truncateMiddle('Nanachi-Remote', () => false)).toBe('…');
  });

  it('never returns more units than the budget', () => {
    const text = 'workspace · feature/a-very-long-branch-name · a-machine-with-a-long-name';
    for (let budget = 1; budget < text.length; budget += 1) {
      const shown = truncateMiddle(text, within(budget));
      expect(Array.from(shown).length).toBeLessThanOrEqual(budget);
    }
  });
});
