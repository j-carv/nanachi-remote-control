import { describe, expect, it } from 'vitest';
import { changesLabel } from './changesLabel.js';

describe('changesLabel', () => {
  it('zero alterações', () => {
    expect(changesLabel(0)).toBe('sem alterações');
  });

  it('uma alteração (singular)', () => {
    expect(changesLabel(1)).toBe('1 alteração');
  });

  it('várias alterações (plural)', () => {
    expect(changesLabel(3)).toBe('3 alterações');
  });
});
