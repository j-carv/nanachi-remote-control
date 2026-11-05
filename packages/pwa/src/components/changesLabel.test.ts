import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
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

describe('changesLabel in English', () => {
  it('zero, one and many changes', () => {
    setLanguage('en');
    expect(changesLabel(0)).toBe('no changes');
    expect(changesLabel(1)).toBe('1 change');
    expect(changesLabel(3)).toBe('3 changes');
  });
});
