import type { SessionStatus } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { isInputEnabled, isResumable } from './controls.js';

describe('isResumable', () => {
  it.each<[SessionStatus, boolean]>([
    ['stopped', true],
    ['error', true],
    ['idle', false],
    ['running', false],
    ['starting', false],
    ['awaiting_permission', false],
  ])('%s → %s', (status, expected) => {
    expect(isResumable(status)).toBe(expected);
  });
});

describe('isInputEnabled', () => {
  it.each<[SessionStatus, boolean]>([
    ['idle', true],
    ['running', true],
    ['starting', false],
    ['awaiting_permission', false],
    ['stopped', false],
    ['error', false],
  ])('%s → %s', (status, expected) => {
    expect(isInputEnabled(status)).toBe(expected);
  });
});
