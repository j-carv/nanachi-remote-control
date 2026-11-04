import pty from '@lydell/node-pty';
import type { AgentCommand } from './agent-command.js';
import { killProcessTree } from './agent-process.js';

/** Terminal do PTY: o que a sessão de terminal usa. Esconde o node-pty para o resto do daemon. */
export interface TerminalProcess {
  /** Chunks de saída: `Buffer` quando o PTY entrega bytes, `string` quando já vem decodificado (Windows). */
  onData(listener: (chunk: string | Buffer) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Mata a árvore do processo. No-op depois que ele saiu. */
  kill(): void;
}

export interface SpawnTerminalOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

/**
 * Forma de chamar o node-pty. Um `.cmd` (shim do npm) não roda direto num PTY do Windows: passa por `cmd.exe /c`,
 * com a linha de comando já montada por `resolveAgentCommand` (`/s` tira só as aspas de fora).
 */
function invocationOf(command: AgentCommand): { file: string; args: string | string[] } {
  if (!command.shell) return { file: command.file, args: command.args };
  return { file: process.env.ComSpec ?? 'cmd.exe', args: `/d /s /c "${command.file}"` };
}

/** Sobe o comando num pseudoterminal. Lança se o executável não puder ser criado (ex.: cwd inexistente). */
export function spawnTerminal(command: AgentCommand, options: SpawnTerminalOptions): TerminalProcess {
  const { file, args } = invocationOf(command);
  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    // Bytes crus: quem decodifica é o OutputBatcher, que não parte caractere UTF-8 entre pedaços.
    encoding: null,
  });

  let exited = false;
  child.onExit(() => {
    exited = true;
  });

  return {
    onData: (listener) => {
      child.onData(listener);
    },
    onExit: (listener) => {
      child.onExit(({ exitCode }) => listener(exitCode));
    },
    write: (data) => {
      child.write(data);
    },
    resize: (cols, rows) => {
      child.resize(cols, rows);
    },
    kill: () => {
      if (exited) return;
      // No Windows o pid só existe depois que o ConPTY conecta (antes é 0): aí vale o kill do próprio node-pty,
      // que espera o processo ficar pronto. Com pid, a árvore inteira vai pelo taskkill.
      if (child.pid > 0) killProcessTree(child.pid, () => child.kill());
      else child.kill();
    },
  };
}
