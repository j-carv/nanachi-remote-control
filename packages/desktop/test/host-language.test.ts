import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../src/common/i18n/index.js';
import { reasonOf, reasonText } from '../src/common/reason.js';
import type { DaemonStatus, TailscaleStatus } from '../src/common/types.js';
import { DaemonHost, RESTRICTED_MESSAGE, type ChildLike, type DaemonHostDeps } from '../src/main/daemon-host.js';
import type { DaemonRuntime } from '../src/main/daemon-runtime.js';
import type { HealthProbe } from '../src/main/system.js';
import { createTsnetHost, type TsnetChild, type TsnetHostDeps } from '../src/main/tsnet-host.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  setLanguage('pt-BR');
});

describe('reasons', () => {
  it('turn into the text of the language asked for, nested reasons first', () => {
    const crash = reasonOf('main.daemon.crashed', { reason: reasonOf('main.reasons.exitCode', { code: 1 }), seconds: 2 });
    expect(reasonText(crash, 'pt-BR')).toBe('O daemon caiu (código 1); tentando de novo em 2 s.');
    expect(reasonText(crash, 'en')).toBe('The daemon crashed (exit code 1); trying again in 2 s.');
    expect(reasonText(crash, 'es')).toBe('El daemon falló (código de salida 1); reintentando en 2 s.');
  });

  it('use the language in effect when none is given, and carry a text nobody translates as it is', () => {
    setLanguage('es');
    expect(reasonText(reasonOf('main.reasons.signal', { signal: 'SIGTERM' }))).toBe('señal SIGTERM');
    expect(reasonText({ text: 'what the sidecar printed' })).toBe('what the sidecar printed');
  });
});

// ---- the daemon host ----

const RUNTIME: DaemonRuntime = {
  nodePath: 'C:\\Nanachi\\resources\\runtime\\node.exe',
  daemonMain: 'C:\\Nanachi\\resources\\runtime\\packages\\daemon\\dist\\main.js',
  daemonCli: 'C:\\Nanachi\\resources\\runtime\\packages\\daemon\\dist\\cli.js',
  cwd: 'C:\\Nanachi\\resources\\runtime',
  packaged: true,
};
const HOME = 'C:\\Users\\user\\.nanachi-desktop';

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  constructor(readonly pid: number | undefined) {
    super();
  }
  kill(): boolean {
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

function hostHarness(overrides: Partial<DaemonHostDeps> = {}, health: HealthProbe = { kind: 'none' }) {
  const children: FakeChild[] = [];
  const logged: string[] = [];
  let current = health;
  const host = new DaemonHost({
    home: HOME,
    runtime: RUNTIME,
    readPort: () => 7811,
    ensureConfig: () => undefined,
    health: () => Promise.resolve(current),
    spawn: () => {
      const child = new FakeChild(4000 + children.length);
      children.push(child);
      return child;
    },
    killTree: () => Promise.resolve(),
    log: { append: (text) => void logged.push(text), tail: () => ['last line'] },
    missingFile: () => null,
    env: {},
    startupTimeoutMs: 30_000,
    pollIntervalMs: 250,
    ...overrides,
  });
  return { host, children, logged, setHealth: (next: HealthProbe) => void (current = next) };
}

const message = (status: DaemonStatus): string => status.message ?? '';

describe('the daemon status follows the language it is read in', () => {
  it('a port held by another program: the same status, three languages, and back', async () => {
    const h = hostHarness({ portFree: () => Promise.resolve(false), portRecheckMs: 10 });
    const started = h.host.start();
    await vi.advanceTimersByTimeAsync(100);
    await started;

    expect(message(h.host.status())).toBe(
      'A porta 7811 está ocupada por outro programa, que não é um daemon do Nanachi. ' +
        `Feche esse programa ou mude "port" no config.json de ${HOME}; o Nanachi tenta de novo sozinho.`,
    );
    setLanguage('en');
    expect(h.host.status()).toMatchObject({ state: 'error', mode: 'none' });
    expect(message(h.host.status())).toBe(
      'Port 7811 is in use by another program, which is not a Nanachi daemon. ' + `Close that program or change "port" in the config.json of ${HOME}; Nanachi retries on its own.`,
    );
    setLanguage('es');
    expect(message(h.host.status())).toContain('El puerto 7811 está ocupado por otro programa');
    setLanguage('pt-BR');
    expect(message(h.host.status())).toContain('A porta 7811 está ocupada por outro programa');
  });

  it('a status event carries the message in the language of the moment it was sent', async () => {
    setLanguage('en');
    const h = hostHarness({ missingFile: () => 'C:\\Nanachi\\resources\\runtime\\node.exe' });
    const seen: DaemonStatus[] = [];
    h.host.onStatus((status) => seen.push(status));
    await h.host.start();
    expect(seen.at(-1)?.message).toBe('Runtime file missing: C:\\Nanachi\\resources\\runtime\\node.exe');
    setLanguage('es');
    expect(h.host.status().message).toBe('Falta un archivo del runtime: C:\\Nanachi\\resources\\runtime\\node.exe');
    expect(seen.at(-1)?.message).toBe('Runtime file missing: C:\\Nanachi\\resources\\runtime\\node.exe');
  });

  it('the restricted explanation is a status message too', async () => {
    const h = hostHarness({}, { kind: 'restricted' });
    await h.host.start();
    expect(h.host.status()).toMatchObject({ state: 'attached', restricted: true, message: RESTRICTED_MESSAGE });
    setLanguage('en');
    expect(message(h.host.status())).toMatch(/^The daemon answers, but it only accepts access through Tailscale \(allowedTailscaleLogins/);
    expect(message(h.host.status())).toContain('.nanachi-desktop');
    setLanguage('es');
    expect(message(h.host.status())).toMatch(/^El daemon responde, pero solo acepta accesos por Tailscale \(allowedTailscaleLogins/);
    expect(message(h.host.status())).toContain('.nanachi-desktop');
    // The constant the older tests compare with stays the Portuguese text.
    expect(RESTRICTED_MESSAGE).toMatch(/vazio/);
  });

  it('a config.json that cannot be prepared names the folder and the cause in each language', async () => {
    const h = hostHarness({
      ensureConfig: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    await h.host.start();
    expect(message(h.host.status())).toBe(`Não foi possível preparar o config.json em ${HOME}: EACCES: permission denied`);
    setLanguage('en');
    expect(message(h.host.status())).toBe(`Could not prepare config.json in ${HOME}: EACCES: permission denied`);
    setLanguage('es');
    expect(message(h.host.status())).toBe(`No se pudo preparar config.json en ${HOME}: EACCES: permission denied`);
  });

  it('a crash says why it crashed, in the language; the support log stays in Portuguese', async () => {
    const h = hostHarness();
    await h.host.start();
    h.children[0]?.exit(1);
    expect(h.host.status()).toMatchObject({ state: 'starting', mode: 'spawned' });
    expect(message(h.host.status())).toBe('O daemon caiu (código 1); tentando de novo em 1 s.');
    setLanguage('en');
    expect(message(h.host.status())).toBe('The daemon crashed (exit code 1); trying again in 1 s.');
    setLanguage('es');
    expect(message(h.host.status())).toBe('El daemon falló (código de salida 1); reintentando en 1 s.');
    expect(h.logged.join('')).toContain('[desktop] o daemon caiu (código 1)');
  });

  it('a signal and a process error are reasons of their own', async () => {
    const h = hostHarness();
    await h.host.start();
    h.children[0]?.exit(null, 'SIGTERM');
    setLanguage('en');
    expect(message(h.host.status())).toBe('The daemon crashed (signal SIGTERM); trying again in 1 s.');
    await vi.advanceTimersByTimeAsync(1_000);
    h.children[1]?.emit('error', new Error('spawn node ENOENT'));
    expect(message(h.host.status())).toBe('The daemon crashed (process error: spawn node ENOENT); trying again in 2 s.');
    setLanguage('es');
    expect(message(h.host.status())).toBe('El daemon falló (error del proceso: spawn node ENOENT); reintentando en 2 s.');
  });

  it('giving up after repeated crashes keeps the last reason, in the language, with the log tail', async () => {
    const h = hostHarness();
    await h.host.start();
    const waits = [1_000, 2_000, 5_000, 10_000, 10_000];
    for (let index = 0; index < 5; index += 1) {
      h.setHealth({ kind: 'ok', info: { machineId: 'm', machineName: 'PC', version: '1.0.0' } });
      h.children[index]?.exit(1);
      h.setHealth({ kind: 'none' });
      await vi.advanceTimersByTimeAsync(waits[index] ?? 10_000);
    }
    h.children[5]?.exit(null, 'SIGKILL');
    expect(h.host.status()).toMatchObject({ state: 'error', logTail: ['last line'] });
    expect(message(h.host.status())).toBe('O daemon caiu 6 vezes em 2 minutos; o Nanachi parou de tentar. Último motivo: sinal SIGKILL.');
    setLanguage('en');
    expect(message(h.host.status())).toBe('The daemon crashed 6 times in 2 min; Nanachi stopped trying. Last reason: signal SIGKILL.');
    setLanguage('es');
    expect(message(h.host.status())).toBe('El daemon falló 6 veces en 2 min; Nanachi dejó de intentarlo. Último motivo: señal SIGKILL.');
  });

  it('a spawn that throws is a crash with its own reason', async () => {
    const h = hostHarness({
      spawn: () => {
        throw new Error('EINVAL');
      },
    });
    await h.host.start();
    setLanguage('en');
    expect(message(h.host.status())).toBe('The daemon crashed (could not start: EINVAL); trying again in 1 s.');
  });

  it('a status without a message stays without one, whatever the language', async () => {
    const h = hostHarness({}, { kind: 'ok', info: { machineId: 'm', machineName: 'PC', version: '1.0.0' } });
    setLanguage('es');
    await h.host.start();
    expect(h.host.status().message).toBeNull();
    await h.host.stop();
    expect(h.host.status().message).toBeNull();
  });
});

// ---- the Tailscale host ----

class FakeStdin extends EventEmitter {
  end(): void {
    return undefined;
  }
}

class FakeSidecar extends EventEmitter implements TsnetChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new FakeStdin();
  constructor(readonly pid: number | undefined) {
    super();
  }
  kill(): boolean {
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
  say(event: unknown): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
  }
}

const EXE = 'C:\\Nanachi\\resources\\bin\\nanachi-tsnet.exe';

function tsnetHarness(overrides: Partial<TsnetHostDeps> = {}) {
  const children: FakeSidecar[] = [];
  const logged: string[] = [];
  const host = createTsnetHost({
    exePath: () => EXE,
    exists: () => true,
    stateDir: 'C:\\Users\\user\\.nanachi-desktop\\tsnet',
    hostname: 'nanachi-pc',
    target: () => 'http://127.0.0.1:7811',
    spawn: () => {
      const child = new FakeSidecar(5000 + children.length);
      children.push(child);
      return child;
    },
    killTree: () => Promise.resolve(),
    log: { append: (text) => void logged.push(text) },
    env: {},
    ...overrides,
  });
  const statuses: TailscaleStatus[] = [];
  host.onStatus((status) => statuses.push(status));
  return { host, children, logged, statuses };
}

const errorText = (status: TailscaleStatus): string => (status.state === 'error' ? status.message : '');

describe('the Tailscale status follows the language it is read in', () => {
  it('a sidecar that exits is reported with its reason and the retry delay', async () => {
    const h = tsnetHarness();
    await h.host.start();
    h.children[0]?.exit(1);
    expect(h.host.status()).toMatchObject({ state: 'error' });
    expect(errorText(h.host.status())).toBe('O Tailscale embutido parou (código 1). Tentando de novo em 1 s.');
    setLanguage('en');
    expect(errorText(h.host.status())).toBe('The built-in Tailscale stopped (exit code 1). Trying again in 1 s.');
    setLanguage('es');
    expect(errorText(h.host.status())).toBe('El Tailscale integrado se detuvo (código de salida 1). Reintentando en 1 s.');
    expect(h.logged.join('')).toContain('[tsnet] processo encerrado (código 1)');
  });

  it('what the sidecar printed is shown as it was, only the retry sentence is translated', async () => {
    const h = tsnetHarness();
    await h.host.start();
    h.children[0]?.say({ type: 'error', message: 'HTTPS is not enabled on the tailnet' });
    expect(h.host.status()).toEqual({ state: 'error', message: 'HTTPS is not enabled on the tailnet' });
    h.children[0]?.exit(1);
    expect(errorText(h.host.status())).toBe('HTTPS is not enabled on the tailnet. Tentando de novo em 1 s.');
    setLanguage('en');
    expect(errorText(h.host.status())).toBe('HTTPS is not enabled on the tailnet. Trying again in 1 s.');
    setLanguage('es');
    expect(errorText(h.host.status())).toBe('HTTPS is not enabled on the tailnet. Reintentando en 1 s.');
  });

  it('a missing sidecar program is an error that follows the language', async () => {
    const h = tsnetHarness({ exists: () => false });
    const status = await h.host.start();
    expect(errorText(status)).toBe(`Não achei o programa do Tailscale embutido (nanachi-tsnet.exe) em ${EXE}.`);
    setLanguage('en');
    expect(errorText(h.host.status())).toBe(`The built-in Tailscale program (nanachi-tsnet.exe) was not found at ${EXE}.`);
    setLanguage('es');
    expect(errorText(h.host.status())).toBe(`No se encontró el programa del Tailscale integrado (nanachi-tsnet.exe) en ${EXE}.`);
  });

  it('a path that cannot be resolved names the cause', async () => {
    const h = tsnetHarness({
      exePath: () => {
        throw new Error('caminho absoluto exigido');
      },
    });
    setLanguage('en');
    const status = await h.host.start();
    expect(errorText(status)).toBe('Could not locate the built-in Tailscale: caminho absoluto exigido');
    setLanguage('es');
    expect(errorText(h.host.status())).toBe('No se pudo localizar el Tailscale integrado: caminho absoluto exigido');
  });

  it('invalid flags are not retried and say why in the language', async () => {
    const h = tsnetHarness();
    await h.host.start();
    setLanguage('en');
    h.children[0]?.exit(2);
    expect(errorText(h.host.status())).toBe('The built-in Tailscale stopped (exit code 2).');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.children).toHaveLength(1);
  });

  it('the status that listeners receive is the one of the moment, and a switch alone does not emit', async () => {
    const h = tsnetHarness({ exists: () => false });
    setLanguage('en');
    await h.host.start();
    const emitted = h.statuses.length;
    expect(errorText(h.statuses.at(-1) ?? { state: 'off' })).toContain('was not found');
    setLanguage('es');
    expect(h.statuses).toHaveLength(emitted);
    expect(errorText(h.host.status())).toContain('No se encontró');
  });

  it('turning it off clears the reason', async () => {
    const h = tsnetHarness({ exists: () => false });
    await h.host.start();
    await h.host.stop();
    setLanguage('es');
    expect(h.host.status()).toEqual({ state: 'off' });
  });
});
