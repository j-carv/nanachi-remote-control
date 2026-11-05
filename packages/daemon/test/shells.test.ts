import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseShell, defaultShellOf, findShells, shellEnvironment } from '../src/shells.js';

const SYSTEM_ROOT = 'C:\\Windows';
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WINPS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const WSL_BASH = 'C:\\Windows\\System32\\bash.exe';

/** Sistema de arquivos falso: só existe o que está na lista. */
function probeOf(existing: readonly string[]): (path: string) => boolean {
  const set = new Set(existing.map((path) => win32.normalize(path).toLowerCase()));
  return (path) => set.has(win32.normalize(path).toLowerCase());
}

const BASE_ENV = {
  SystemRoot: SYSTEM_ROOT,
  ComSpec: COMSPEC,
  PATH: 'C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7',
  ProgramFiles: 'C:\\Program Files',
};

describe('findShells', () => {
  it('pwsh no PATH: é o padrão, e powershell e cmd também aparecem, nessa ordem', () => {
    const shells = findShells({
      env: BASE_ENV,
      exists: probeOf([COMSPEC, PWSH, WINPS]),
    });
    expect(shells.map((shell) => shell.id)).toEqual(['pwsh', 'powershell', 'cmd']);
    expect(shells.find((shell) => shell.id === 'pwsh')).toEqual({
      id: 'pwsh',
      label: 'PowerShell 7',
      file: PWSH,
      args: ['-NoLogo'],
    });
  });

  it('sem pwsh: powershell do Windows (achado em System32 mesmo fora do PATH) vira o padrão', () => {
    const shells = findShells({ env: { ...BASE_ENV, PATH: 'C:\\Windows\\System32' }, exists: probeOf([COMSPEC, WINPS]) });
    expect(shells.map((shell) => shell.id)).toEqual(['powershell', 'cmd']);
    expect(shells[0]?.file).toBe(WINPS);
  });

  it('cmd usa ComSpec; sem ComSpec, cai no System32', () => {
    const fromComspec = findShells({ env: { ...BASE_ENV, ComSpec: 'D:\\tools\\cmd.exe' }, exists: probeOf(['D:\\tools\\cmd.exe']) });
    expect(fromComspec.find((shell) => shell.id === 'cmd')?.file).toBe('D:\\tools\\cmd.exe');

    const fromSystem32 = findShells({ env: { ...BASE_ENV, ComSpec: undefined }, exists: probeOf([COMSPEC]) });
    expect(fromSystem32.find((shell) => shell.id === 'cmd')?.file).toBe(COMSPEC);
  });

  it('bash só do Git for Windows: nunca o bash.exe do WSL em System32', () => {
    const shells = findShells({
      env: { ...BASE_ENV, PATH: `${BASE_ENV.PATH};C:\\Windows\\System32` },
      exists: probeOf([COMSPEC, WSL_BASH]),
    });
    expect(shells.some((shell) => shell.id === 'bash')).toBe(false);
  });

  it('bash do Git instalado em Program Files é achado, com --login -i', () => {
    const shells = findShells({ env: BASE_ENV, exists: probeOf([COMSPEC, GIT_BASH]) });
    expect(shells.find((shell) => shell.id === 'bash')).toEqual({
      id: 'bash',
      label: 'Git Bash',
      file: GIT_BASH,
      args: ['--login', '-i'],
    });
  });

  it('bash do Git no PATH: sobe dois níveis a partir de git.exe (…\\Git\\cmd\\git.exe → …\\Git\\bin\\bash.exe)', () => {
    const gitRoot = 'D:\\Apps\\PortableGit';
    const shells = findShells({
      env: { ...BASE_ENV, PATH: `${gitRoot}\\cmd;C:\\Windows\\System32`, ProgramFiles: undefined },
      exists: probeOf([COMSPEC, `${gitRoot}\\cmd\\git.exe`, `${gitRoot}\\bin\\bash.exe`]),
    });
    expect(shells.find((shell) => shell.id === 'bash')?.file).toBe(`${gitRoot}\\bin\\bash.exe`);
  });

  it('nada instalado além do cmd: lista só o cmd e não há padrão de PowerShell', () => {
    const shells = findShells({ env: { ...BASE_ENV, PATH: '' }, exists: probeOf([COMSPEC]) });
    expect(shells.map((shell) => shell.id)).toEqual(['cmd']);
    expect(defaultShellOf(shells)?.id).toBe('cmd');
  });
});

describe('defaultShellOf', () => {
  it('pwsh antes de powershell; sem nenhum dos dois, cmd (o terminal sempre tem um padrão)', () => {
    const withPwsh = findShells({ env: BASE_ENV, exists: probeOf([COMSPEC, PWSH, WINPS]) });
    expect(defaultShellOf(withPwsh)?.id).toBe('pwsh');
    const withoutPwsh = findShells({ env: { ...BASE_ENV, PATH: '' }, exists: probeOf([COMSPEC, WINPS]) });
    expect(defaultShellOf(withoutPwsh)?.id).toBe('powershell');
    const onlyCmd = findShells({ env: { ...BASE_ENV, PATH: '' }, exists: probeOf([COMSPEC]) });
    expect(defaultShellOf(onlyCmd)?.id).toBe('cmd');
  });
});

describe('chooseShell', () => {
  const shells = findShells({ env: BASE_ENV, exists: probeOf([COMSPEC, PWSH, WINPS]) });

  it('sem pedido, usa o padrão (pwsh)', () => {
    expect(chooseShell(shells, undefined)?.id).toBe('pwsh');
  });

  it('pedido de um shell encontrado vence o padrão', () => {
    expect(chooseShell(shells, 'cmd')?.id).toBe('cmd');
  });

  it('pedido de um shell que não existe no PC: undefined (vira shell_unavailable)', () => {
    expect(chooseShell(shells, 'bash')).toBeUndefined();
  });

  it('lista vazia não escolhe nada (vira shell_unavailable)', () => {
    expect(chooseShell([], undefined)).toBeUndefined();
  });
});

describe('shellEnvironment', () => {
  it('tira todas as variáveis NANACHI_* (sem tokens do daemon nem de agente), sem diferenciar maiúsculas', () => {
    const env = shellEnvironment({
      PATH: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\joao',
      NANACHI_HOME: 'D:\\dados',
      NANACHI_AGENT_TOKEN: 'segredo',
      nanachi_url: 'http://127.0.0.1:7777',
      AGENT_SESSION_ID: 'sessao',
    });
    expect(env).toEqual({
      PATH: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\joao',
      AGENT_SESSION_ID: 'sessao',
    });
  });

  it('não altera o objeto de entrada e descarta valores indefinidos', () => {
    const input = { PATH: 'x', NANACHI_URL: 'u', EMPTY: undefined };
    expect(shellEnvironment(input)).toEqual({ PATH: 'x' });
    expect(input.NANACHI_URL).toBe('u');
  });
});
