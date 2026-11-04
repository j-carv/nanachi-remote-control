import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import {
  autostartStatus,
  defaultAutostartEnv,
  installAutostart,
  startAutostart,
  stopSupervisor,
  uninstallAutostart,
  type AutostartEnv,
  type AutostartResult,
} from './autostart.js';
import { resolveNanachiHome } from './config.js';
import { openDatabase } from './db.js';
import { createPairCode, PAIR_CODE_TTL_MS } from './pairing.js';
import { listDevices, revokeDevice } from './repository.js';
import { loadOrCreateVapid } from './vapid.js';

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = 'uso: pair | devices | revoke <id> | vapid show | autostart install|uninstall|status|start|stop';
const AUTOSTART_USAGE = 'uso: autostart install | uninstall | status | start | stop';

/** Ação do `autostart` -> resultado. Cada uma recebe o ambiente real (ou um falso, nos testes). */
const AUTOSTART_ACTIONS: Record<string, (env: AutostartEnv) => Promise<AutostartResult> | AutostartResult> = {
  install: installAutostart,
  uninstall: uninstallAutostart,
  status: autostartStatus,
  start: startAutostart,
  stop: stopSupervisor,
};

/** `vapid show`: caminho do vapid.json e a chave pública (é o que o PWA usa para inscrever o push). */
function runVapid(args: readonly string[], home: string, io: CliIO): number {
  if (args.length !== 1 || args[0] !== 'show') {
    io.err('uso: vapid show');
    return 2;
  }
  try {
    const vapid = loadOrCreateVapid(home);
    io.out(`Arquivo: ${join(home, 'vapid.json')}`);
    io.out(`Chave pública: ${vapid.publicKey}`);
    return 0;
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
}

/** `autostart install|uninstall|status|start|stop`: atalho na pasta Inicializar que sobe o supervisor ao fazer logon. */
async function runAutostart(args: readonly string[], home: string, appData: string | undefined, io: CliIO): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || rest.length > 0 || !Object.hasOwn(AUTOSTART_ACTIONS, action)) {
    io.err(AUTOSTART_USAGE);
    return 2;
  }

  const run = AUTOSTART_ACTIONS[action];
  if (run === undefined) {
    io.err(AUTOSTART_USAGE);
    return 2;
  }
  let result: AutostartResult;
  try {
    result = await run(defaultAutostartEnv(home, appData));
  } catch (error) {
    io.err(`autostart: ${(error as Error).message}`);
    return 1;
  }
  if (result.ok) io.out(result.message);
  else io.err(result.message);
  return result.ok ? 0 : 1;
}

/** Executa um subcomando e devolve o código de saída. Comandos que mexem no banco abrem e fecham o banco a cada chamada. */
export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIO): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    io.err(USAGE);
    return 2;
  }

  const home = resolveNanachiHome(env);
  if (command === 'vapid') return runVapid(args, home, io);
  if (command === 'autostart') return runAutostart(args, home, env.APPDATA, io);

  let db: Database.Database;
  try {
    db = openDatabase(join(home, 'data.db'));
  } catch (error) {
    io.err(`não foi possível abrir o banco em ${home}: ${(error as Error).message}`);
    return 1;
  }

  try {
    switch (command) {
      case 'pair': {
        const code = createPairCode(db, Date.now());
        io.out(`Código de pareamento: ${code} (uso único, válido por ${PAIR_CODE_TTL_MS / 60_000} min)`);
        return 0;
      }
      case 'devices': {
        const devices = listDevices(db);
        if (devices.length === 0) {
          io.out('Nenhum dispositivo pareado.');
          return 0;
        }
        for (const device of devices) {
          const lastSeen = device.lastSeenAt === null ? 'nunca' : new Date(device.lastSeenAt).toISOString();
          const status = device.revokedAt === null ? 'ativo' : 'revogado';
          io.out(
            `${device.id}  ${device.name}  criado ${new Date(device.createdAt).toISOString()}  último uso ${lastSeen}  ${status}`,
          );
        }
        return 0;
      }
      case 'revoke': {
        const id = args[0];
        if (id === undefined) {
          io.err('uso: revoke <id>  (os ids aparecem em `devices`)');
          return 2;
        }
        if (!revokeDevice(db, id, Date.now())) {
          io.err('dispositivo não encontrado ou já revogado');
          return 1;
        }
        io.out(`dispositivo ${id} revogado`);
        return 0;
      }
      default:
        io.err(`comando desconhecido: ${command}`);
        io.err(USAGE);
        return 2;
    }
  } finally {
    db.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  runCli(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
