import { describe, expect, it } from 'vitest';
import { envValue, mergeEnv, withEnvValue, withoutEnv } from '../src/agent-env.js';

describe('mergeEnv', () => {
  it('later layers win; keys that appear once keep their spelling', () => {
    const env = mergeEnv([{ A: '1', B: '1' }, { B: '2', C: '3' }], 'linux');
    expect(env).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('Windows: a different case of the same name is the same variable, and the later spelling wins', () => {
    const env = mergeEnv([{ Claude_Config_Dir: 'old', KEEP: 'yes' }, { CLAUDE_CONFIG_DIR: 'new' }], 'win32');
    expect(env).toEqual({ KEEP: 'yes', CLAUDE_CONFIG_DIR: 'new' });
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('other platforms keep names that differ only by case', () => {
    const env = mergeEnv([{ Foo: 'a' }, { FOO: 'b' }], 'linux');
    expect(env).toEqual({ Foo: 'a', FOO: 'b' });
  });

  it('an undefined value removes the variable from every earlier layer', () => {
    const env = mergeEnv([{ CODEX_HOME: 'x', Codex_Home: 'y', KEEP: '1' }, { CODEX_HOME: undefined }], 'win32');
    expect(env).toEqual({ KEEP: '1' });
  });

  it('a variable removed by one layer can be set again by a later one', () => {
    const env = mergeEnv([{ A: '1' }, { A: undefined }, { A: '3' }], 'win32');
    expect(env).toEqual({ A: '3' });
  });

  it('does not change its inputs', () => {
    const first = { Foo: 'a' };
    mergeEnv([first, { FOO: 'b' }], 'win32');
    expect(first).toEqual({ Foo: 'a' });
  });
});

describe('withEnvValue, withoutEnv and envValue', () => {
  it('withEnvValue sets the name and drops variants in another case', () => {
    expect(withEnvValue({ claude_config_dir: 'a', X: '1' }, 'CLAUDE_CONFIG_DIR', 'b', 'win32')).toEqual({
      X: '1',
      CLAUDE_CONFIG_DIR: 'b',
    });
  });

  it('withoutEnv drops every spelling of the name', () => {
    expect(withoutEnv({ Codex_Home: 'a', CODEX_HOME: 'b', X: '1' }, 'CODEX_HOME', 'win32')).toEqual({ X: '1' });
  });

  it('envValue finds the name in any case on Windows and treats empty as absent', () => {
    expect(envValue({ Codex_Home: 'a' }, 'CODEX_HOME', 'win32')).toBe('a');
    expect(envValue({ Codex_Home: 'a' }, 'CODEX_HOME', 'linux')).toBeUndefined();
    expect(envValue({ CODEX_HOME: '' }, 'CODEX_HOME', 'win32')).toBeUndefined();
    expect(envValue({}, 'CODEX_HOME', 'win32')).toBeUndefined();
  });
});
