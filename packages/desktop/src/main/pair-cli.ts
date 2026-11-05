import { t } from '../common/i18n/index.js';
import { messageOf } from '../common/message.js';
import type { DaemonRuntime } from './daemon-runtime.js';
import { PairingError } from './pairing.js';
import { runProcess, type ProcessResult } from './system.js';
import type { SpawnOptions } from './daemon-host.js';

const PAIR_CLI_TIMEOUT_MS = 20_000;

type RunProcess = (command: string, args: string[], options: SpawnOptions, timeoutMs: number) => Promise<ProcessResult>;

/**
 * Runs `node cli.js <args>` under the same runtime and NANACHI_HOME as the daemon and returns what it printed. Every
 * failure becomes a `PairingError` with a message fit for the user.
 */
async function runDaemonCli(
  runtime: DaemonRuntime,
  home: string,
  env: NodeJS.ProcessEnv,
  run: RunProcess,
  args: string[],
): Promise<string> {
  let result: ProcessResult;
  try {
    result = await run(
      runtime.nodePath,
      [runtime.daemonCli, ...args],
      { cwd: runtime.cwd, env: { ...env, NANACHI_HOME: home } },
      PAIR_CLI_TIMEOUT_MS,
    );
  } catch (error) {
    throw new PairingError('cli_failed', t('main.pairing.cliFailed', { detail: messageOf(error) }));
  }
  if (result.timedOut) throw new PairingError('cli_failed', t('main.pairing.cliTimeout'));
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new PairingError('cli_failed', detail !== '' ? detail : t('main.pairing.cliExit', { code: String(result.exitCode) }));
  }
  return result.stdout;
}

/**
 * `node cli.js pair --json`: a fresh 6-digit code for a phone ("Gerar código de pareamento"). The daemon marks every
 * code still valid as used when it makes a new one, so this is only for a code a person is going to type.
 */
export function createPairCliRunner(
  runtime: DaemonRuntime,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  run: RunProcess = runProcess,
): () => Promise<string> {
  return () => runDaemonCli(runtime, home, env, run, ['pair', '--json']);
}

/**
 * `node cli.js device add --name <name> --json`: Desktop's own device and token, made without a pairing code so a code the
 * user is typing on the phone at that moment stays valid. The name travels as one argument, never through a shell.
 */
export function createDeviceAddRunner(
  runtime: DaemonRuntime,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  run: RunProcess = runProcess,
): (name: string) => Promise<string> {
  return (name) => runDaemonCli(runtime, home, env, run, ['device', 'add', '--name', name, '--json']);
}
