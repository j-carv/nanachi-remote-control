import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { powershellPath, systemDirectory } from '../src/common/system-paths.js';
import { UNINSTALL_ARG } from '../src/install/constants.js';
import { launchUninstaller, UNINSTALL_LAUNCH_SCRIPT, UNINSTALL_EXE_ENV, type LaunchSpawn } from '../src/main/uninstall-launch.js';
import { removeDir } from './remove-dir.js';

const EXE = 'C:\\Users\\José da Silva\\AppData\\Local\\Programs\\Nanachi\\Nanachi.exe';

function fakeSpawn(): { spawn: LaunchSpawn; calls: Array<{ command: string; args: string[]; options: Parameters<LaunchSpawn>[2] }>; child: EventEmitter & { unref: ReturnType<typeof vi.fn> } } {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const calls: Array<{ command: string; args: string[]; options: Parameters<LaunchSpawn>[2] }> = [];
  const spawn: LaunchSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { spawn, calls, child };
}

describe('launchUninstaller', () => {
  it('starts Nanachi.exe --uninstall through PowerShell, so it is not a child of the running app', () => {
    const { spawn, calls, child } = fakeSpawn();
    launchUninstaller({ execPath: EXE, spawn, env: { PATH: 'x' }, onError: () => undefined });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // Absolute, and from a folder normal users cannot write to: a bare name is looked up in the cwd before PATH.
    expect(call?.command).toBe(powershellPath({}));
    expect(call?.options.cwd).toBe(systemDirectory({}));
    expect(call?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(call?.args[3]).toBe(UNINSTALL_LAUNCH_SCRIPT);
    expect(UNINSTALL_LAUNCH_SCRIPT).toContain('Start-Process');
    expect(UNINSTALL_LAUNCH_SCRIPT).toContain(`$env:${UNINSTALL_EXE_ENV}`);
    expect(UNINSTALL_LAUNCH_SCRIPT).toContain(UNINSTALL_ARG);
    expect(call?.options).toMatchObject({ windowsHide: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('hands the path of the exe over in the environment, never on the command line (spaces and accents)', () => {
    const { spawn, calls } = fakeSpawn();
    launchUninstaller({ execPath: EXE, spawn, env: { PATH: 'x' }, onError: () => undefined });
    const [call] = calls;
    expect(call?.options.env).toMatchObject({ PATH: 'x', [UNINSTALL_EXE_ENV]: EXE });
    expect(JSON.stringify(call?.args)).not.toContain('José');
    expect(UNINSTALL_LAUNCH_SCRIPT).not.toContain('Nanachi.exe');
  });

  it('reports a launch that fails later (the process could not start) instead of staying silent', () => {
    const { spawn, child } = fakeSpawn();
    const onError = vi.fn();
    launchUninstaller({ execPath: EXE, spawn, env: {}, onError });
    child.emit('error', new Error('spawn powershell.exe ENOENT'));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('reports a PowerShell that exits with an error code, once', () => {
    const { spawn, child } = fakeSpawn();
    const onError = vi.fn();
    launchUninstaller({ execPath: EXE, spawn, env: {}, onError });
    child.emit('exit', 1, null);
    child.emit('exit', 1, null);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/PowerShell.*1/));
  });

  it('says nothing when PowerShell exits cleanly after starting the uninstaller', () => {
    const { spawn, child } = fakeSpawn();
    const onError = vi.fn();
    launchUninstaller({ execPath: EXE, spawn, env: {}, onError });
    child.emit('exit', 0, null);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not report twice when a start error is followed by an exit', () => {
    const { spawn, child } = fakeSpawn();
    const onError = vi.fn();
    launchUninstaller({ execPath: EXE, spawn, env: {}, onError });
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('exit', null, null);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a spawn that throws right away', () => {
    const onError = vi.fn();
    launchUninstaller({
      execPath: EXE,
      env: {},
      onError,
      spawn: () => {
        throw new Error('EPERM');
      },
    });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
  });
});

describe.runIf(process.platform === 'win32')('launchUninstaller with the real PowerShell', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanachi-uninstall-launch-'));
  });
  afterEach(() => {
    removeDir(dir);
  });

  it('starts a program whose path has spaces and accents, with --uninstall as its only argument', async () => {
    const folder = join(dir, 'Pasta com espaço e acentuação');
    mkdirSync(folder);
    const marker = join(folder, 'argumentos.txt');
    // A stand-in for Nanachi.exe: it records what it was started with, where it was started.
    const program = join(folder, 'Nanachi desinstalar.cmd');
    writeFileSync(program, ['@echo off', 'echo %*> "%~dp0argumentos.txt"', ''].join('\r\n'), 'ascii');

    const errors: string[] = [];
    launchUninstaller({ execPath: program, onError: (message) => errors.push(message) });

    const deadline = Date.now() + 20_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8').trim()).toBe(UNINSTALL_ARG);
    expect(errors).toEqual([]);
  }, 30_000);

  it('reports a PowerShell that fails: a program that does not exist is an error, not silence', async () => {
    const errors: string[] = [];
    launchUninstaller({ execPath: join(dir, 'não existe.exe'), onError: (message) => errors.push(message) });
    const deadline = Date.now() + 20_000;
    while (errors.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('desinstalador');
  }, 30_000);
});
