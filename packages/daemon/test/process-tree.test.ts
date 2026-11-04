import { describe, expect, it } from 'vitest';
import { taskkillArgs } from '../src/process-tree.js';

describe('taskkillArgs', () => {
  it('mata a árvore inteira, à força, pelo pid, sem shell', () => {
    expect(taskkillArgs(4242)).toEqual(['/T', '/F', '/PID', '4242']);
  });
});
