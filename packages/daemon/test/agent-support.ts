import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import {
  ConfigOptionsResponseSchema,
  parseServerMessage,
  SessionSchema,
  WorkspaceSchema,
  type AgentConfig,
  type ClientMessage,
  type PairResponse,
  type ServerMessage,
  type Session,
  type SessionConfigOption,
  type SessionEvent,
} from '@nanachi/shared';
import { WebSocket } from 'ws';
import { issueCode, type TestDaemon } from './support.js';

const require = createRequire(import.meta.url);
const FAKE_AGENT_PATH = fileURLToPath(new URL('./fixtures/fake-agent.ts', import.meta.url));
/** Loader do tsx como URL absoluta: o agente roda no cwd do workspace, onde `tsx` não resolve. */
const TSX_ESM_URL = pathToFileURL(require.resolve('tsx/esm')).href;

/** Agente falso (test/fixtures/fake-agent.ts) com env extra. */
export function fakeAgent(env: Record<string, string> = {}): AgentConfig {
  return {
    label: 'Fake',
    command: process.execPath,
    args: ['--import', TSX_ESM_URL, FAKE_AGENT_PATH],
    env,
    kind: 'acp',
  };
}

/** Agente que encerra logo ao iniciar. */
export function crashingAgent(): AgentConfig {
  return { label: 'Morre', command: process.execPath, args: ['-e', 'process.exit(3)'], env: {}, kind: 'acp' };
}

/** Sessão do arquivo FAKE_AGENT_STORE (ver test/fixtures/fake-agent.ts). */
export interface StoredAgentSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  history: Array<{ role: 'user' | 'agent'; text: string }>;
}

/** Grava as sessões que o fake agent vai listar e carregar. */
export async function writeAgentStore(path: string, sessions: StoredAgentSession[]): Promise<void> {
  await writeFile(path, JSON.stringify(sessions));
}

/** Cria o workspace pela API e devolve o id. */
export async function createWorkspace(daemon: TestDaemon, path: string): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

export function isEvent(kind: SessionEvent['kind']): (message: ServerMessage) => boolean {
  return (message) => message.type === 'event' && message.event.kind === kind;
}

/**
 * Cliente WS de teste. Guarda todas as mensagens; `waitFor` espera a próxima que casa com o predicado
 * (a busca começa de onde a última espera parou, então esperas em sequência seguem a ordem do fluxo).
 */
export class WsTestClient {
  readonly messages: ServerMessage[] = [];
  private cursor = 0;
  private arrivals = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const parsed = parseServerMessage(data.toString());
      if (!parsed.ok) throw new Error(`mensagem inválida do daemon: ${parsed.error}`);
      this.messages.push(parsed.value);
      for (const notify of this.arrivals) notify();
    });
  }

  static async connect(base: string, token: string): Promise<WsTestClient> {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${token}`);
    const client = new WsTestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(match: (message: ServerMessage) => boolean, timeoutMs = 10_000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.messages.length) {
        const message = this.messages[this.cursor];
        this.cursor += 1;
        if (message !== undefined && match(message)) return message;
      }
      await this.nextArrival(deadline);
    }
  }

  /** Garante que tudo que o daemon mandou antes do pong já chegou. */
  async sync(): Promise<void> {
    this.send({ type: 'ping' });
    await this.waitFor((message) => message.type === 'pong');
  }

  eventsOf(sessionId: string): SessionEvent[] {
    return this.messages.flatMap((message) =>
      message.type === 'event' && message.event.sessionId === sessionId ? [message.event] : [],
    );
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }

  private nextArrival(deadline: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const notify = (): void => {
        clearTimeout(timer);
        this.arrivals.delete(notify);
        resolve();
      };
      const timer = setTimeout(() => {
        this.arrivals.delete(notify);
        reject(new Error('timeout esperando mensagem do daemon'));
      }, Math.max(0, deadline - Date.now()));
      this.arrivals.add(notify);
    });
  }
}

/** Sobe o daemon numa porta efêmera e devolve a URL base. */
export async function listen(daemon: TestDaemon): Promise<string> {
  return daemon.app.listen({ host: '127.0.0.1', port: 0 });
}

export async function pairToken(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: issueCode(daemon), deviceName: 'iPhone' },
  });
  return res.json<PairResponse>().token;
}

export async function authHeader(daemon: TestDaemon): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await pairToken(daemon)}` };
}

/** Cria sessão via HTTP e devolve o Session. Espera a resposta (o agente já subiu). */
export async function createSession(
  daemon: TestDaemon,
  body: { workspaceId: string; agent: string; config?: Record<string, string | boolean>; worktree?: boolean },
  expectedStatus = 201,
): Promise<Session> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: await authHeader(daemon),
    payload: body,
  });
  if (res.statusCode !== expectedStatus) {
    throw new Error(`POST /api/sessions → ${res.statusCode}: ${res.body}`);
  }
  return SessionSchema.parse(res.json<unknown>());
}

/** Opções de configuração que valem agora (GET /api/sessions/:id/config). */
export async function fetchConfigOptions(daemon: TestDaemon, sessionId: string): Promise<SessionConfigOption[]> {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/config`,
    headers: await authHeader(daemon),
  });
  if (res.statusCode !== 200) throw new Error(`GET /config → ${res.statusCode}: ${res.body}`);
  return ConfigOptionsResponseSchema.parse(res.json<unknown>()).configOptions;
}

/** Env que o agente de teste recebeu (gravado pelo fake em `<pidDir>/<sessionId>.env.json`). */
export interface AgentEnv {
  AGENT_SESSION_ID: string;
  NANACHI_URL: string;
  NANACHI_AGENT_TOKEN: string;
  PATH: string;
}

export async function readAgentEnv(pidDir: string, sessionId: string): Promise<AgentEnv> {
  const raw: unknown = JSON.parse(await readFile(join(pidDir, `${sessionId}.env.json`), 'utf8'));
  const fields = ['AGENT_SESSION_ID', 'NANACHI_URL', 'NANACHI_AGENT_TOKEN', 'PATH'] as const;
  if (typeof raw !== 'object' || raw === null) throw new Error('env do agente inválido');
  const record: Record<string, unknown> = { ...raw };
  for (const field of fields) {
    if (typeof record[field] !== 'string') throw new Error(`env do agente sem ${field}`);
  }
  return {
    AGENT_SESSION_ID: String(record.AGENT_SESSION_ID),
    NANACHI_URL: String(record.NANACHI_URL),
    NANACHI_AGENT_TOKEN: String(record.NANACHI_AGENT_TOKEN),
    PATH: String(record.PATH),
  };
}

/** Blocos de cada `session/prompt` que o agente de teste recebeu (uma linha JSON por prompt). */
export async function promptsReceived(pidDir: string, sessionId: string): Promise<acp.ContentBlock[][]> {
  const text = await readFile(join(pidDir, `${sessionId}.prompts.jsonl`), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as acp.ContentBlock[]);
}
