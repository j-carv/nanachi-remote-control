import { describe, expect, it } from 'vitest';
import type { DaemonRuntime } from '../src/main/daemon-runtime.js';
import { createDeviceAddRunner, createPairCliRunner } from '../src/main/pair-cli.js';
import type { ProcessResult } from '../src/main/system.js';

const RUNTIME: DaemonRuntime = {
  nodePath: 'C:\\runtime\\node.exe',
  daemonMain: 'C:\\runtime\\packages\\daemon\\dist\\main.js',
  daemonCli: 'C:\\runtime\\packages\\daemon\\dist\\cli.js',
  cwd: 'C:\\runtime',
  packaged: true,
};

const ok = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

describe('createPairCliRunner', () => {
  it('runs `cli.js pair --json` under the runtime with NANACHI_HOME and returns stdout', async () => {
    const seen: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const run = createPairCliRunner(RUNTIME, 'D:\\home', { PATH: 'p' }, (command, args, options) => {
      seen.push({ command, args, cwd: options.cwd, env: options.env });
      return Promise.resolve(ok('{"code":"123456","expiresAt":1}\n'));
    });

    expect(await run()).toBe('{"code":"123456","expiresAt":1}\n');
    expect(seen).toEqual([
      {
        command: 'C:\\runtime\\node.exe',
        args: ['C:\\runtime\\packages\\daemon\\dist\\cli.js', 'pair', '--json'],
        cwd: 'C:\\runtime',
        env: { PATH: 'p', NANACHI_HOME: 'D:\\home' },
      },
    ]);
  });

  it('turns a non-zero exit into an error carrying the CLI message', async () => {
    const run = createPairCliRunner(RUNTIME, 'h', {}, () =>
      Promise.resolve({ exitCode: 1, stdout: '', stderr: 'não foi possível abrir o banco\n', timedOut: false }),
    );
    await expect(run()).rejects.toMatchObject({ name: 'PairingError', kind: 'cli_failed', message: 'não foi possível abrir o banco' });
  });

  it('names the exit code when the CLI printed nothing', async () => {
    const run = createPairCliRunner(RUNTIME, 'h', {}, () => Promise.resolve({ exitCode: 7, stdout: '', stderr: '', timedOut: false }));
    await expect(run()).rejects.toThrow(/código 7/);
  });

  it('reports a timeout and a command that cannot start', async () => {
    const slow = createPairCliRunner(RUNTIME, 'h', {}, () => Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
    await expect(slow()).rejects.toThrow(/demorou demais/);

    const missing = createPairCliRunner(RUNTIME, 'h', {}, () => Promise.reject(new Error('spawn ENOENT')));
    await expect(missing()).rejects.toMatchObject({ kind: 'cli_failed' });
    await expect(missing()).rejects.toThrow(/ENOENT/);
  });
});

describe('createDeviceAddRunner', () => {
  it('runs `cli.js device add --name <name> --json` with the name as ONE argument, under the runtime and NANACHI_HOME', async () => {
    const seen: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const run = createDeviceAddRunner(RUNTIME, 'D:\\home', { PATH: 'p' }, (command, args, options) => {
      seen.push({ command, args, cwd: options.cwd, env: options.env });
      return Promise.resolve(ok('{"deviceId":"d-1","token":"t"}\n'));
    });

    // A name with spaces, parentheses and a quote: it must reach the CLI untouched (no shell is involved).
    const name = 'Nanachi Desktop (JOAO "PC")';
    expect(await run(name)).toBe('{"deviceId":"d-1","token":"t"}\n');
    expect(seen).toEqual([
      {
        command: 'C:\\runtime\\node.exe',
        args: ['C:\\runtime\\packages\\daemon\\dist\\cli.js', 'device', 'add', '--name', name, '--json'],
        cwd: 'C:\\runtime',
        env: { PATH: 'p', NANACHI_HOME: 'D:\\home' },
      },
    ]);
  });

  it('turns a failure into a PairingError with the CLI message', async () => {
    const run = createDeviceAddRunner(RUNTIME, 'h', {}, () =>
      Promise.resolve({ exitCode: 2, stdout: '', stderr: 'uso: device add --name <nome> [--json]\n', timedOut: false }),
    );
    await expect(run('x')).rejects.toMatchObject({
      name: 'PairingError',
      kind: 'cli_failed',
      message: 'uso: device add --name <nome> [--json]',
    });
  });

  it('reports a timeout and a command that cannot start', async () => {
    const slow = createDeviceAddRunner(RUNTIME, 'h', {}, () => Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
    await expect(slow('x')).rejects.toThrow(/demorou demais/);
    const missing = createDeviceAddRunner(RUNTIME, 'h', {}, () => Promise.reject(new Error('spawn ENOENT')));
    await expect(missing('x')).rejects.toMatchObject({ kind: 'cli_failed' });
  });
});
