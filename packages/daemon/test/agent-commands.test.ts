import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHONE_SEND_HINT } from '../src/acp-mapping.js';
import {
  CommandsResponseSchema,
  WorkspaceSchema,
  type AvailableCommand,
  type ServerMessage,
  type Session,
  type SessionEvent,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  fakeAgent,
  isEvent,
  listen,
  pairToken,
  promptsReceived,
  WsTestClient,
} from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Comandos que o agente anuncia (available_commands_update). Ficam na sessão (coluna `commands`) e saem por
 * GET /api/sessions/:id/commands. Nunca vão na Session (listagem e broadcast `session`). Vão na mensagem `commands`
 * só para os clientes inscritos na sessão: no subscribe (depois do replay, se houver lista) e quando a lista muda.
 * Um prompt de comando não leva o aviso do phone-send.
 */

const ANNOUNCED: AvailableCommand[] = [
  { name: 'loop', description: 'Repete um prompt em intervalo', hint: '[intervalo] [prompt]' },
  { name: 'mcp', description: 'Mostra os servidores MCP', hint: null },
  { name: 'skill:brainstorming', description: 'Use antes de criar algo novo', hint: 'argumentos' },
  { name: 'eco', description: 'Devolve o texto informado', hint: 'texto' },
];

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-cmd-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

const env = setupDaemonTests();

interface Started {
  daemon: TestDaemon;
  /** URL base do daemon (listen só pode ser chamado uma vez por daemon). */
  url: string;
  workspaceId: string;
  session: Session;
  client: WsTestClient;
}

async function start(agentEnv: Record<string, string> = { FAKE_AGENT_COMMANDS: '1' }): Promise<Started> {
  const daemon = await env.start({
    config: {
      allowedRoots: [workspace],
      agents: { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir, ...agentEnv }) },
      phoneSendHint: true,
    },
  });
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  const workspaceId = WorkspaceSchema.parse(res.json<unknown>()).id;
  const session = await createSession(daemon, { workspaceId, agent: 'fake' });
  const url = await listen(daemon);
  const client = await WsTestClient.connect(url, await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return { daemon, url, workspaceId, session, client };
}

async function fetchCommands(daemon: TestDaemon, sessionId: string): Promise<AvailableCommand[]> {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/commands`,
    headers: await authHeader(daemon),
  });
  expect(res.statusCode).toBe(200);
  return CommandsResponseSchema.parse(res.json<unknown>()).commands;
}

type CommandsMessage = Extract<ServerMessage, { type: 'commands' }>;

function commandsMessagesOf(client: WsTestClient, sessionId: string): CommandsMessage[] {
  return client.messages.filter(
    (message): message is CommandsMessage => message.type === 'commands' && message.sessionId === sessionId,
  );
}

async function resumeSession(daemon: TestDaemon, sessionId: string): Promise<void> {
  await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}`, headers: await authHeader(daemon) });
  const res = await daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/resume`,
    headers: await authHeader(daemon),
  });
  expect(res.statusCode).toBe(200);
}

describe('comandos anunciados pelo agente', () => {
  it('GET /api/sessions/:id/commands devolve a lista que o agente anunciou', async () => {
    const { daemon, session } = await start();
    expect(await fetchCommands(daemon, session.id)).toEqual(ANNOUNCED);
  });

  it('sessão sem anúncio: GET devolve lista vazia', async () => {
    const { daemon, session } = await start({});
    expect(await fetchCommands(daemon, session.id)).toEqual([]);
  });

  it('GET de sessão inexistente dá 404', async () => {
    const { daemon } = await start();
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/sessions/nao-existe/commands',
      headers: await authHeader(daemon),
    });
    expect(res.statusCode).toBe(404);
  });

  it('sessão parada continua com os comandos da última vez', async () => {
    const { daemon, session } = await start();
    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });
    expect(await fetchCommands(daemon, session.id)).toEqual(ANNOUNCED);
  });

  it('a Session da listagem da pasta não traz commands', async () => {
    const { daemon, workspaceId, session } = await start();
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers: await authHeader(daemon),
    });
    const listed = res.json<{ sessions: Array<Record<string, unknown>> }>().sessions.find((item) => item.id === session.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('commands');
  });

  it('o subscribe manda a lista logo depois do replay, só para a sessão inscrita', async () => {
    const { daemon, url, session } = await start();
    const late = await WsTestClient.connect(url, await pairToken(daemon));
    late.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
    await late.waitFor((message) => message.type === 'commands');
    await late.sync();

    const messages = late.messages;
    const commandsAt = messages.findIndex((message) => message.type === 'commands');
    const lastEventAt = messages.reduce((at, message, index) => (message.type === 'event' ? index : at), -1);
    expect(lastEventAt).toBeGreaterThan(-1);
    expect(commandsAt).toBeGreaterThan(lastEventAt);
    expect(commandsMessagesOf(late, session.id)).toEqual([{ type: 'commands', sessionId: session.id, commands: ANNOUNCED }]);
    await late.close();
  });

  it('subscribe em sessão sem lista não manda commands', async () => {
    const { daemon, url, workspaceId } = await start({});
    const plain = await createSession(daemon, { workspaceId, agent: 'fake' });
    const client = await WsTestClient.connect(url, await pairToken(daemon));
    client.send({ type: 'subscribe', sessionId: plain.id, afterSeq: 0 });
    await client.waitFor(isEvent('status'));
    await client.sync();
    expect(commandsMessagesOf(client, plain.id)).toEqual([]);
    await client.close();
  });

  it('mudança da lista chega ao vivo aos inscritos, e não aos outros clientes', async () => {
    const { daemon, url, session, client } = await start();
    const other = await WsTestClient.connect(url, await pairToken(daemon));
    await other.sync();

    client.send({ type: 'prompt', sessionId: session.id, text: '/trocar-comandos', attachments: [] });
    await client.waitFor(isEvent('turn_end'));
    await client.sync();
    await other.sync();

    const changed: AvailableCommand[] = [{ name: 'novo', description: 'Lista trocada', hint: null }];
    expect(commandsMessagesOf(client, session.id)).toEqual([
      { type: 'commands', sessionId: session.id, commands: ANNOUNCED },
      { type: 'commands', sessionId: session.id, commands: changed },
    ]);
    expect(commandsMessagesOf(other, session.id)).toEqual([]);
    expect(await fetchCommands(daemon, session.id)).toEqual(changed);
    await other.close();
  });

  it('lista igual à atual não é reenviada (resume anuncia de novo a mesma lista)', async () => {
    const { daemon, session, client } = await start();
    expect(commandsMessagesOf(client, session.id)).toHaveLength(1);

    await resumeSession(daemon, session.id);
    await client.sync();
    expect(commandsMessagesOf(client, session.id)).toHaveLength(1);
    expect(await fetchCommands(daemon, session.id)).toEqual(ANNOUNCED);
  });

  it('o comando vai como prompt de texto; a resposta vem como texto normal do agente', async () => {
    const { session, client } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: '/eco oi, tudo bem', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    const reply = client.eventsOf(session.id).filter(
      (event): event is Extract<SessionEvent, { kind: 'agent_message_chunk' }> => event.kind === 'agent_message_chunk',
    );
    expect(reply.map((event) => event.text)).toEqual(['oi, tudo bem']);
    const user = client.eventsOf(session.id).find((event) => event.kind === 'user_message');
    expect(user).toMatchObject({ kind: 'user_message', text: '/eco oi, tudo bem' });
  });

  it('o primeiro prompt, se for comando, não leva o aviso do phone-send; o próximo leva', async () => {
    const { session, client } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: '/eco primeiro', attachments: [] });
    await client.waitFor(isEvent('turn_end'));
    client.send({ type: 'prompt', sessionId: session.id, text: 'segundo', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    const prompts = await promptsReceived(pidDir, session.id);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.some((block) => block.type === 'text' && block.text === PHONE_SEND_HINT)).toBe(false);
    expect(prompts[1]?.some((block) => block.type === 'text' && block.text === PHONE_SEND_HINT)).toBe(true);
  });
});
