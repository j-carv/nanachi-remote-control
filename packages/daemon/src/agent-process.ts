import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentCommand } from './agent-command.js';

export type AgentChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** Processo ACP temporário (sem entrar no mapa de sessões): a conexão, o fim do processo e como matá-lo. */
export interface AcpProcess {
  readonly connection: acp.ClientConnection;
  /** Resolve quando o processo sai, por qualquer motivo. */
  readonly exited: Promise<void>;
  kill(): void;
}

const CLIENT_NAME = 'nanachi-remote';

export interface SpawnAgentOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Linhas do stderr do agente e erros de stream (vão para o log em debug). */
  onDiagnostic(line: string): void;
}

/** Sobe o agente com pipes para ACP. Não lança para erro de execução (vem por evento `error`). */
export function spawnAgent(command: AgentCommand, options: SpawnAgentOptions): AgentChild {
  const child = spawn(command.file, command.args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: command.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Sem listener, escrever num processo morto (EPIPE) derrubaria o daemon.
  child.stdin.on('error', (error) => options.onDiagnostic(`stdin: ${error.message}`));
  child.stdout.on('error', (error) => options.onDiagnostic(`stdout: ${error.message}`));
  createInterface({ input: child.stderr }).on('line', (line) => options.onDiagnostic(line));
  return child;
}

/**
 * Mata a árvore de processos de `pid`. No Windows, `taskkill /T` derruba os filhos (um `.cmd` deixa `node` por
 * baixo); fora do Windows, ou se o taskkill nem sobe, usa `fallback`. Quem chama confere antes que o pid ainda é seu.
 */
export function killProcessTree(pid: number, fallback: () => void): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', fallback);
    return;
  }
  fallback();
}

/** Mata o agente e os filhos (ver `killProcessTree`). Não faz nada se o processo já saiu. */
export function killAgent(child: AgentChild): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  killProcessTree(child.pid, () => child.kill());
}

export interface AcpHandlers {
  onSessionUpdate(notification: acp.SessionNotification): void;
  onPermissionRequest(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
}

/** Conexão ACP longa sobre o stdio do agente. Sem fs nem terminal (o agente trabalha no próprio disco). */
export function connectAcp(child: AgentChild, handlers: AcpHandlers): acp.ClientConnection {
  const app = acp
    .client({ name: CLIENT_NAME })
    .onNotification(acp.methods.client.session.update, ({ params }) => handlers.onSessionUpdate(params))
    .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) =>
      handlers.onPermissionRequest(params, signal),
    );
  return app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
}
