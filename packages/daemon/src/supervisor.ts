/*
 * Supervisor do Nanachi Remote (`npm run supervise`, ou o início automático). Sobe os builds em modo watch (shared,
 * daemon, pwa) e o daemon com `--reload-on-build`, e mantém tudo vivo. Uma instância só (`supervisor.lock`).
 * Logs em `<NANACHI_HOME>/supervisor.log`. Encerra a árvore de todos os filhos ao receber sinal ou ao sair.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNanachiHome } from './config.js';
import { killProcessTree } from './process-tree.js';
import { ManagedChild, spawnChildProcess, type ChildLog } from './supervisor-children.js';
import { createRotatingLog } from './supervisor-log.js';
import { acquireLock, defaultLockDeps, releaseLock } from './supervisor-lock.js';
import { buildSupervisorPlan } from './supervisor-plan.js';

/** Raiz do projeto, a partir de dist/ (ou src/ no dev): mesma profundidade nos dois. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOCK_FILE_NAME = 'supervisor.lock';
const LOG_FILE_NAME = 'supervisor.log';

/** Arquivo JS de um pacote instalado (typescript, vite), resolvido a partir do pacote que o usa. */
function packageBin(fromPackageJson: string, pkg: string, binRelative: string): string {
  const pkgJson = createRequire(fromPackageJson).resolve(`${pkg}/package.json`);
  return join(dirname(pkgJson), binRelative);
}

async function main(): Promise<void> {
  const home = resolveNanachiHome(process.env);
  mkdirSync(home, { recursive: true });
  const log = createRotatingLog({
    file: join(home, LOG_FILE_NAME),
    maxBytes: LOG_MAX_BYTES,
    echo: process.stdout.isTTY ? (line) => console.log(line) : undefined,
  });

  const lockFile = join(home, LOCK_FILE_NAME);
  const lock = acquireLock(lockFile, process.pid, defaultLockDeps());
  if (!lock.ok) {
    log.write('supervisor', `já está rodando (pid ${lock.owner.pid}); saindo`);
    process.exitCode = 1;
    return;
  }

  const plan = buildSupervisorPlan({
    root: ROOT,
    home,
    nodeExe: process.execPath,
    tscJs: packageBin(join(ROOT, 'packages', 'daemon', 'package.json'), 'typescript', join('bin', 'tsc')),
    viteJs: packageBin(join(ROOT, 'packages', 'pwa', 'package.json'), 'vite', join('bin', 'vite.js')),
    baseEnv: process.env,
  });
  const childLog: ChildLog = log;
  const children = [...plan.watchers, plan.daemon].map(
    (spec) => new ManagedChild(spec, { spawn: spawnChildProcess, log: childLog, killTree: killProcessTree }),
  );

  let cleaned = false;
  const cleanup = (reason: string): void => {
    if (cleaned) return;
    cleaned = true;
    log.write('supervisor', `encerrando (${reason}): matando a árvore de todos os filhos`);
    for (const child of children) child.stop();
    releaseLock(lockFile, process.pid);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      cleanup(signal);
      process.exit(0);
    });
  }
  process.on('exit', () => cleanup('saída'));

  log.write('supervisor', `iniciado (pid ${process.pid}); home ${home}`);
  for (const child of children) child.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
