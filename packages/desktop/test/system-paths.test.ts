import { describe, expect, it } from 'vitest';
import { powershellPath, systemDirectory, windowsRoot } from '../src/common/system-paths.js';

describe('windowsRoot', () => {
  it('reads SystemRoot, whatever the case of the variable name', () => {
    expect(windowsRoot({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows');
    expect(windowsRoot({ SYSTEMROOT: 'E:\\WINNT' })).toBe('E:\\WINNT');
    expect(windowsRoot({ windir: 'C:\\Windows' })).toBe('C:\\Windows');
  });

  it('drops a trailing backslash', () => {
    expect(windowsRoot({ SystemRoot: 'C:\\Windows\\' })).toBe('C:\\Windows');
  });

  it.each([[{}], [{ SystemRoot: '' }], [{ SystemRoot: 'Windows' }], [{ SystemRoot: '.\\Windows' }], [{ SystemRoot: '\\\\servidor\\Windows' }]])(
    'falls back to C:\\Windows for %j (missing or not an absolute drive path)',
    (env) => {
      expect(windowsRoot(env)).toBe('C:\\Windows');
    },
  );
});

describe('systemDirectory and powershellPath', () => {
  it('are absolute paths under the Windows folder, never a bare file name', () => {
    expect(systemDirectory({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32');
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(powershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});
