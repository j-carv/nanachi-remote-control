import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentCommand } from '../src/agent-command.js';
import { removeTempDir } from './temp.js';

let base: string;
let dirA: string;
let dirB: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nanachi-cmd-'));
  dirA = join(base, 'a');
  dirB = join(base, 'b');
  await mkdir(dirA);
  await mkdir(dirB);
});

afterEach(async () => {
  await removeTempDir(base);
});

const WIN_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function winEnv(...dirs: string[]): NodeJS.ProcessEnv {
  return { PATH: dirs.join(';'), PATHEXT: WIN_PATHEXT };
}

describe('resolveAgentCommand (win32)', () => {
  it('acha .exe no PATH: spawn direto, sem shell', async () => {
    await writeFile(join(dirA, 'omp.exe'), '');
    const resolved = resolveAgentCommand('omp', ['acp'], winEnv(dirA), 'win32');

    expect(resolved).toEqual({ file: join(dirA, 'omp.exe'), args: ['acp'], shell: false });
  });

  it('acha .cmd (shim do npm): usa shell, aspa caminho com espaço e argumentos com espaço', async () => {
    const dirComEspaco = join(base, 'pasta com espaço');
    await mkdir(dirComEspaco);
    await writeFile(join(dirComEspaco, 'claude.cmd'), '');
    const resolved = resolveAgentCommand('claude', ['acp', 'com espaço'], winEnv(dirComEspaco), 'win32');

    expect(resolved.shell).toBe(true);
    expect(resolved.args).toEqual([]);
    expect(resolved.file).toBe(`"${join(dirComEspaco, 'claude.cmd')}" acp "com espaço"`);
  });

  it('ignora o shim sem extensão (script sh do npm) e pega o .cmd', async () => {
    await writeFile(join(dirA, 'omp'), '#!/bin/sh');
    await writeFile(join(dirA, 'omp.cmd'), '');
    const resolved = resolveAgentCommand('omp', ['acp'], winEnv(dirA), 'win32');

    expect(resolved.file).toBe(`${join(dirA, 'omp.cmd')} acp`);
    expect(resolved.shell).toBe(true);
  });

  it('respeita a ordem do PATH', async () => {
    await writeFile(join(dirA, 'omp.cmd'), '');
    await writeFile(join(dirB, 'omp.exe'), '');
    const resolved = resolveAgentCommand('omp', [], winEnv(dirA, dirB), 'win32');

    expect(resolved.file).toBe(join(dirA, 'omp.cmd'));
  });

  it('aceita comando já com extensão', async () => {
    await writeFile(join(dirB, 'omp.exe'), '');
    const resolved = resolveAgentCommand('omp.exe', ['acp'], winEnv(dirB), 'win32');

    expect(resolved).toEqual({ file: join(dirB, 'omp.exe'), args: ['acp'], shell: false });
  });

  it('comando com caminho absoluto não passa pelo PATH', async () => {
    const exe = join(dirB, 'agente.exe');
    await writeFile(exe, '');
    const resolved = resolveAgentCommand(exe, [], { PATH: '', PATHEXT: WIN_PATHEXT }, 'win32');

    expect(resolved).toEqual({ file: exe, args: [], shell: false });
  });

  it('comando inexistente lança erro citando o nome', () => {
    expect(() => resolveAgentCommand('nao-existe', [], winEnv(dirA), 'win32')).toThrow(/nao-existe/);
  });
});

describe.skipIf(process.platform === 'win32')('resolveAgentCommand (posix)', () => {
  it('acha o arquivo no PATH sem shell', async () => {
    await writeFile(join(dirA, 'omp'), '');
    const resolved = resolveAgentCommand('omp', ['acp'], { PATH: [dirA, dirB].join(delimiter) }, 'linux');

    expect(resolved).toEqual({ file: join(dirA, 'omp'), args: ['acp'], shell: false });
  });
});
