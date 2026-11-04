import { join } from 'node:path';
import type { ChildSpec } from './supervisor-children.js';

export interface PlanInput {
  /** Raiz do projeto (onde fica `packages/`). */
  root: string;
  /** `<NANACHI_HOME>`: vai para o env do daemon. */
  home: string;
  nodeExe: string;
  /** `typescript/bin/tsc` (JS, rodado pelo node). */
  tscJs: string;
  /** `vite/bin/vite.js`. */
  viteJs: string;
  /** Ambiente do supervisor, herdado pelos filhos. */
  baseEnv: NodeJS.ProcessEnv;
}

export interface SupervisorPlan {
  /** Builds em modo watch, sobem antes do daemon. */
  watchers: ChildSpec[];
  daemon: ChildSpec;
}

/** Quais processos o supervisor sobe e com quais argumentos. Função pura: os caminhos vêm de fora. */
export function buildSupervisorPlan(input: PlanInput): SupervisorPlan {
  const sharedDir = join(input.root, 'packages', 'shared');
  const daemonDir = join(input.root, 'packages', 'daemon');
  const pwaDir = join(input.root, 'packages', 'pwa');

  return {
    watchers: [
      {
        name: 'shared-tsc',
        command: input.nodeExe,
        args: [input.tscJs, '-p', join(sharedDir, 'tsconfig.build.json'), '--watch', '--preserveWatchOutput', '--noEmitOnError'],
        cwd: input.root,
        env: input.baseEnv,
      },
      {
        name: 'daemon-tsc',
        command: input.nodeExe,
        args: [input.tscJs, '-p', join(daemonDir, 'tsconfig.build.json'), '--watch', '--preserveWatchOutput', '--noEmitOnError'],
        cwd: input.root,
        env: input.baseEnv,
      },
      {
        name: 'pwa-vite',
        command: input.nodeExe,
        args: [input.viteJs, 'build', '--watch'],
        cwd: pwaDir,
        env: input.baseEnv,
      },
    ],
    daemon: {
      name: 'daemon',
      command: input.nodeExe,
      args: ['dist/main.js', '--reload-on-build'],
      cwd: daemonDir,
      env: { ...input.baseEnv, NANACHI_HOME: input.home },
    },
  };
}
