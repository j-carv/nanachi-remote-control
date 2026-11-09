import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { loadConfig, resolveNanachiHome, startupWarnings } from './config.js';
import { openDatabase } from './db.js';
import { LiveConnections } from './live-connections.js';
import { inactivityLimitMs } from './pairing.js';
import { createPushNotifier } from './push.js';
import { saveIdleSessionsForReload, takeResumeAfterReload } from './reload-resume.js';
import { RELOAD_EXIT_CODE, ReloadWatcher } from './reload-watch.js';
import { countBusySessions, ensureMachine, stopInterruptedSessions } from './repository.js';
import { buildServer } from './server.js';
import { loadOrCreateVapid } from './vapid.js';

/** packages/pwa/dist, relativo a este arquivo (src/ no dev, dist/ no build: mesma profundidade). */
const PWA_DIST = fileURLToPath(new URL('../../pwa/dist/', import.meta.url));
/** Ponteiro do build em watch: `packages/pwa/releases/current.json` (contrato em packages/pwa/build/atomic-output.ts). */
const PWA_RELEASE_POINTER = fileURLToPath(new URL('../../pwa/releases/current.json', import.meta.url));
/** Builds observados pelo `--reload-on-build`: o próprio daemon e o shared (tipos e schemas). */
const DAEMON_DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SHARED_DIST = fileURLToPath(new URL('../../shared/dist/', import.meta.url));

function readVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
    return pkg.version;
  }
  throw new Error('package.json do daemon sem version');
}

async function main(): Promise<void> {
  const home = resolveNanachiHome(process.env);
  const config = loadConfig(home);
  const db = openDatabase(join(home, 'data.db'));
  const machine = ensureMachine(db, config.machineName);
  // Sessões que um reload deixou ociosas: lidas antes de marcar tudo como stopped, retomadas depois de escutar.
  const resumeIds = takeResumeAfterReload(home, Date.now());
  stopInterruptedSessions(db, Date.now());
  const vapid = loadOrCreateVapid(home);
  const connections = new LiveConnections();
  const push = createPushNotifier({
    db,
    machineId: machine.id,
    vapid,
    connections,
    inactivityMs: inactivityLimitMs(config.deviceInactivityDays),
    warn: (fields, message) => app.log.warn(fields, message),
  });
  const app = await buildServer({
    config,
    db,
    machine,
    version: readVersion(),
    home,
    staticDir: PWA_DIST,
    staticPointer: PWA_RELEASE_POINTER,
    vapidPublicKey: vapid.publicKey,
    connections,
    onNotify: push.notify,
    resumeAfterReload: resumeIds,
    onDevicePaired: (device) => {
      void push.notifyDevicePaired(device.id, device.name);
    },
  });
  for (const warning of startupWarnings(config)) app.log.warn(warning);

  let reloadWatcher: ReloadWatcher | undefined;
  let shuttingDown = false;
  /** Caminho único de saída (sinal ou reload): para o watch, fecha os WS, mata os agentes (app.close) e o banco. */
  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    reloadWatcher?.stop();
    // Só o reload deixa recado para o daemon novo: sinal normal (SIGINT/SIGTERM) não grava nada.
    if (reason === 'reload') {
      try {
        const saved = saveIdleSessionsForReload(db, home, Date.now());
        app.log.info({ count: saved.length }, 'sessões ociosas gravadas para retomar após o reload');
      } catch (error) {
        app.log.warn({ err: error }, 'não gravou as sessões para retomar após o reload');
      }
      // Terminais de workspace morrem com o reload: avisa quem está inscrito antes de fechar os WS.
      app.closeShellsForReload();
    }
    app.log.info({ reason }, 'encerrando daemon');
    for (const socket of connections.all()) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1001, 'daemon encerrando');
    }
    app
      .close()
      .then(() => db.close())
      .finally(() => process.exit(exitCode));
  };
  process.once('SIGINT', () => shutdown('SIGINT', 0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));

  await app.listen({ host: config.host, port: config.port });

  if (process.argv.includes('--reload-on-build')) {
    reloadWatcher = new ReloadWatcher({
      dirs: [DAEMON_DIST, SHARED_DIST],
      quietMs: config.reloadQuietMs,
      busyCount: () => countBusySessions(db),
      reload: () => shutdown('reload', RELOAD_EXIT_CODE),
      log: (message) => app.log.info(message),
    });
    reloadWatcher.start();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
