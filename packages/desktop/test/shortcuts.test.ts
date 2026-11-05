import { describe, expect, it } from 'vitest';
import { sectionForInput, type InputLike } from '../src/common/shortcuts.js';

const input = (key: string, extra: Partial<InputLike> = {}): InputLike => ({
  type: 'keyDown',
  key,
  control: true,
  alt: false,
  shift: false,
  meta: false,
  ...extra,
});

describe('shortcuts read from an Electron input event (the sessions view holds the focus)', () => {
  it('Ctrl+1..8 select the sections, including the sessions on Ctrl+8', () => {
    expect(sectionForInput(input('1'))).toBe('overview');
    expect(sectionForInput(input('7'))).toBe('settings');
    expect(sectionForInput(input('8'))).toBe('sessions');
  });

  it('ignores a key release, a held key, other digits and modified combinations', () => {
    expect(sectionForInput(input('1', { type: 'keyUp' }))).toBeNull();
    expect(sectionForInput(input('1', { isAutoRepeat: true }))).toBeNull();
    expect(sectionForInput(input('9'))).toBeNull();
    expect(sectionForInput(input('1', { control: false }))).toBeNull();
    expect(sectionForInput(input('1', { alt: true }))).toBeNull();
    expect(sectionForInput(input('1', { shift: true }))).toBeNull();
    expect(sectionForInput(input('1', { meta: true }))).toBeNull();
    expect(sectionForInput(input('k'))).toBeNull();
  });
});
