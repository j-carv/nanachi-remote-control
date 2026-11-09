import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach } from 'vitest';
import { loadConfig, type LoadedConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { LiveConnections } from '../src/live-connections.js';
import { createPairCode } from '../src/pairing.js';
import { ensureMachine, type Machine } from '../src/repository.js';
import type { NotifyHandler } from '../src/notify.js';
import { buildServer, type DevicePairedHandler, type WorkspaceDeletedHandler } from '../src/server.js';
import type { AgentAccountsService } from '../src/agent-accounts.js';
import type { AccountRuntime } from '../src/accounts/service.js';
import type { WhisperService } from '../src/whisper.js';
import { loadOrCreateVapid } from '../src/vapid.js';
import { removeTempDir } from './temp.js';

export const TEST_VERSION = '0.0.0-test';

export interface TestDaemon {
  app: FastifyInstance;
  db: Database.Database;
  config: LoadedConfig;
  machine: Machine;
  home: string;
  connections: LiveConnections;
}

export interface StartOptions {
  whisper?: WhisperService;
  /** Conteúdo de config.json (escrito antes de loadConfig). */
  config?: Record<string, unknown>;
  /** Cria `<home>/pwa` com index.html e assets/app.js. Sem isso a pasta não existe. */
  pwa?: boolean;
  onWorkspaceDeleted?: WorkspaceDeletedHandler | undefined;
  onNotify?: NotifyHandler | undefined;
  /** Sessões a retomar ao escutar (o que o main lê de resume-after-reload.json). */
  resumeAfterReload?: readonly string[] | undefined;
  /** Intervalo do revalidador de WS (padrão do daemon: 30 s). Testes usam um valor curto. */
  wsRevalidateMs?: number;
  /** Teto da listagem de sessões do agente (padrão: 30 s). Testes do timeout usam um valor curto. */
  agentListTimeoutMs?: number;
  /** Teto da leitura de uso (`POST /api/sessions/:id/usage`). Padrão: 30 s. Testes do timeout usam um valor curto. */
  usageTimeoutMs?: number | undefined;
  /** Cache da leitura de uso (padrão: 30 s). Testes usam 0 ou um valor curto. */
  usageCacheMs?: number | undefined;
  /** Ociosidade do processo de uso (padrão: 2 min). Testes usam um valor curto. */
  usageIdleMs?: number | undefined;
  /** MCP question deadline. Defaults to five minutes; expiry tests use a short value. */
  askUserTimeoutMs?: number | undefined;
  /** MCP file request deadline; expiry tests use a short value. */
  requestFileTimeoutMs?: number | undefined;
  /** Contas dos agentes. Padrão: serviço que não verifica nada (testes não rodam claude/codex de verdade). */
  agentAccounts?: AgentAccountsService;
  /** Ajustes das contas extras (pasta do usuário, `run` falso, relógio). Padrão: os reais. */
  accountRuntime?: AccountRuntime | undefined;
  /** Aviso de pareamento por Tailscale (o main liga o Web Push aqui). */
  onDevicePaired?: DevicePairedHandler | undefined;
}

export async function startDaemon(home: string, options: StartOptions = {}): Promise<TestDaemon> {
  if (options.config !== undefined) {
    await writeFile(join(home, 'config.json'), JSON.stringify(options.config));
  }
  const config = loadConfig(home);
  const db = openDatabase(join(home, 'data.db'));
  const machine = ensureMachine(db, config.machineName);
  const staticDir = join(home, 'pwa');
  const connections = new LiveConnections();
  const vapid = loadOrCreateVapid(home);
  if (options.pwa === true) {
    await mkdir(join(staticDir, 'assets'), { recursive: true });
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
    await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log(1);');
  }
  const app = await buildServer({
    config,
    db,
    machine,
    version: TEST_VERSION,
    home,
    staticDir,
    staticPointer: join(home, 'releases', 'current.json'),
    vapidPublicKey: vapid.publicKey,
    connections,
    logger: false,
    onWorkspaceDeleted: options.onWorkspaceDeleted,
    onNotify: options.onNotify,
    wsRevalidateMs: options.wsRevalidateMs,
    agentListTimeoutMs: options.agentListTimeoutMs,
    usageTimeoutMs: options.usageTimeoutMs,
    usageCacheMs: options.usageCacheMs,
    usageIdleMs: options.usageIdleMs,
    askUserTimeoutMs: options.askUserTimeoutMs,
    requestFileTimeoutMs: options.requestFileTimeoutMs,
    resumeAfterReload: options.resumeAfterReload,
    agentAccounts: options.agentAccounts ?? { list: () => Promise.resolve([]) },
    accountRuntime: options.accountRuntime,
    onDevicePaired: options.onDevicePaired,
    whisper: options.whisper,
  });
  return { app, db, config, machine, home, connections };
}

export async function stopDaemon(daemon: TestDaemon): Promise<void> {
  try {
    await daemon.app.close();
  } finally {
    daemon.db.close();
  }
}

/** Cria um NANACHI_HOME temporário por teste; fecha daemons e remove a pasta no fim. */
export function setupDaemonTests(): { readonly home: string; start(options?: StartOptions): Promise<TestDaemon> } {
  const state: { home: string; daemons: TestDaemon[] } = { home: '', daemons: [] };

  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'nanachi-test-'));
    state.daemons = [];
  });

  // Para todos os daemons mesmo se um falhar, e remove a pasta sempre: um erro aqui não pode deixar lixo em %TEMP%.
  afterEach(async () => {
    const stops = await Promise.allSettled(state.daemons.splice(0).map((daemon) => stopDaemon(daemon)));
    await removeTempDir(state.home);
    const failed = stops.find((stop) => stop.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });

  return {
    get home() {
      return state.home;
    },
    async start(options) {
      const daemon = await startDaemon(state.home, options);
      state.daemons.push(daemon);
      return daemon;
    },
  };
}

/** Código de pareamento válido agora (o mesmo que `npm run pair` geraria). */
export function issueCode(daemon: TestDaemon): string {
  return createPairCode(daemon.db, Date.now());
}

export function differentCode(code: string): string {
  return code === '000000' ? '000001' : '000000';
}
