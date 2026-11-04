import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSchema, type AgentConfig, type Session, type ServerMessage } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  fakeAgent,
  fetchConfigOptions,
  isEvent,
  listen,
  pairToken,
  WsTestClient,
} from './agent-support.js';
import { insertEvent, listEvents } from '../src/repository.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-ws-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o vitest roda afterEach em pilha, então este roda por último
// (depois que os daemons já mataram os agentes, que mantêm o cwd dentro do workspace).
const env = setupDaemonTests();

function agents(): Record<string, AgentConfig> {
  return {
    fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }),
    modos: fakeAgent({ FAKE_AGENT_STYLE: 'modes', FAKE_AGENT_PID_DIR: pidDir }),
  };
}

async function start(): Promise<TestDaemon> {
  // Aviso do phone-send desligado: o eco do fake inclui o texto do prompt, e estes testes comparam esse eco.
  return env.start({ config: { allowedRoots: [base], agents: agents(), phoneSendHint: false } });
}

async function createWorkspaceId(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

interface Open {
  daemon: TestDaemon;
  base: string;
  session: Session;
  client: WsTestClient;
}

/** Sessão fake criada por HTTP e um cliente WS inscrito nela desde o seq 0 (espera ficar idle). */
async function openSession(agent = 'fake'): Promise<Open> {
  const daemon = await start();
  const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent });
  const url = await listen(daemon);
  const client = await WsTestClient.connect(url, await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return { daemon, base: url, session, client };
}

const isErrorFor = (sessionId: string) => (message: ServerMessage) =>
  message.type === 'error' && message.sessionId === sessionId;

function isSession(sessionId: string, status?: Session['status']) {
  return (message: ServerMessage) =>
    message.type === 'session' &&
    message.session.id === sessionId &&
    (status === undefined || message.session.status === status);
}

function statusEvent(sessionId: string, status: Session['status']) {
  return (message: ServerMessage) =>
    message.type === 'event' &&
    message.event.sessionId === sessionId &&
    message.event.kind === 'status' &&
    message.event.status === status;
}

describe('WS: subscribe e prompt', () => {
  it('prompt transmite o turno ao vivo: user_message, chunks, tool_call com diff, turn_end e volta a idle', async () => {
    const { client, session } = await openSession();

    client.send({ type: 'prompt', sessionId: session.id, text: 'hello' });
    await client.waitFor(isEvent('turn_end'));
    await client.waitFor(statusEvent(session.id, 'idle'));

    const events = client.eventsOf(session.id);
    expect(events.map((event) => event.kind)).toEqual([
      'status',
      'status',
      'user_message',
      'status',
      'agent_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'turn_end',
      'status',
    ]);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    expect(events[4]).toMatchObject({ kind: 'agent_message_chunk', text: 'Eco: ' });
    expect(events[5]).toMatchObject({ kind: 'agent_message_chunk', text: 'hello' });
    expect(events[6]).toMatchObject({
      kind: 'tool_call',
      toolCallId: 'call-1',
      title: 'Editar a.txt',
      toolKind: 'edit',
      status: 'pending',
      content: [{ type: 'diff', path: 'a.txt', oldText: 'antigo', newText: 'novo' }],
      locations: ['a.txt'],
    });
    expect(events[7]).toMatchObject({ kind: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });
    expect(events[8]).toMatchObject({ kind: 'turn_end', stopReason: 'end_turn' });

    const list = await client.waitFor(isSession(session.id, 'idle'));
    expect(list).toMatchObject({ type: 'session', session: { title: 'hello' } });
    await client.close();
  });

  it('título vem dos 60 primeiros caracteres do primeiro prompt', async () => {
    const { client, session } = await openSession();
    const text = 'x'.repeat(80);

    client.send({ type: 'prompt', sessionId: session.id, text });
    await client.waitFor(isEvent('turn_end'));
    await client.waitFor(statusEvent(session.id, 'idle'));

    const sent = client.messages.find((message) => message.type === 'session' && message.session.title !== 'Nova sessão');
    expect(sent).toMatchObject({ type: 'session', session: { title: 'x'.repeat(60) } });
    await client.close();
  });

  it('subscribe com afterSeq manda só seq > afterSeq e depois segue ao vivo sem duplicar', async () => {
    const { client, session, base: url, daemon } = await openSession();
    client.send({ type: 'prompt', sessionId: session.id, text: 'hello' });
    await client.waitFor(statusEvent(session.id, 'idle'));
    const firstTurn = client.eventsOf(session.id);
    const cut = firstTurn[3]?.seq ?? 0;

    const late = await WsTestClient.connect(url, await pairToken(daemon));
    late.send({ type: 'subscribe', sessionId: session.id, afterSeq: cut });
    await late.sync();
    expect(late.eventsOf(session.id).map((event) => event.seq)).toEqual(
      firstTurn.filter((event) => event.seq > cut).map((event) => event.seq),
    );

    client.send({ type: 'prompt', sessionId: session.id, text: 'again' });
    await late.waitFor(statusEvent(session.id, 'idle'));
    await client.waitFor(statusEvent(session.id, 'idle'));

    const seqs = late.eventsOf(session.id).map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual(client.eventsOf(session.id).filter((event) => event.seq > cut).map((event) => event.seq));
    await late.close();
    await client.close();
  });

  it('unsubscribe para de mandar eventos da sessão', async () => {
    const { client, session } = await openSession();
    client.send({ type: 'unsubscribe', sessionId: session.id });
    await client.sync();
    const before = client.eventsOf(session.id).length;

    client.send({ type: 'prompt', sessionId: session.id, text: 'hello' });
    await client.waitFor((message) => isSession(session.id, 'running')(message));
    await client.waitFor((message) => isSession(session.id, 'idle')(message));

    expect(client.eventsOf(session.id).length).toBe(before);
    await client.close();
  });

  it('prompt fora de idle → error com sessionId', async () => {
    const { client, session } = await openSession();
    client.send({ type: 'prompt', sessionId: session.id, text: 'slow' });
    await client.waitFor(isEvent('agent_message_chunk'));

    client.send({ type: 'prompt', sessionId: session.id, text: 'outro' });
    await client.waitFor(isErrorFor(session.id));

    client.send({ type: 'cancel', sessionId: session.id });
    await client.waitFor(isEvent('turn_end'));
    await client.close();
  });

  it('subscribe de sessão desconhecida → error', async () => {
    const { client } = await openSession();
    client.send({ type: 'subscribe', sessionId: 'nao-existe', afterSeq: 0 });
    await client.waitFor(isErrorFor('nao-existe'));
    await client.close();
  });

  it('broadcast de session chega a todos os clientes autenticados', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspaceId(daemon);
    const url = await listen(daemon);
    const first = await WsTestClient.connect(url, await pairToken(daemon));
    const second = await WsTestClient.connect(url, await pairToken(daemon));

    const session = await createSession(daemon, { workspaceId, agent: 'fake' });

    await first.waitFor(isSession(session.id, 'idle'));
    await second.waitFor(isSession(session.id, 'idle'));
    await first.close();
    await second.close();
  });
});

describe('WS: permissão e cancelamento', () => {
  it('permissão aprovada: request, awaiting_permission, resolved com optionId, agente recebe a escolha e turno termina', async () => {
    const { client, session } = await openSession();
    client.send({ type: 'prompt', sessionId: session.id, text: 'permission' });

    const request = await client.waitFor(isEvent('permission_request'));
    if (request.type !== 'event' || request.event.kind !== 'permission_request') throw new Error('sem request');
    expect(request.event.options.map((option) => option.optionId)).toEqual(['allow', 'reject']);
    await client.waitFor(statusEvent(session.id, 'awaiting_permission'));

    client.send({
      type: 'permission_response',
      sessionId: session.id,
      requestId: request.event.requestId,
      optionId: 'allow',
    });
    await client.waitFor(isEvent('permission_resolved'));
    await client.waitFor(isEvent('turn_end'));
    await client.waitFor(statusEvent(session.id, 'idle'));

    const kinds = client.eventsOf(session.id).map((event) => event.kind);
    expect(kinds.slice(kinds.indexOf('permission_request'))).toEqual([
      'permission_request',
      'status',
      'permission_resolved',
      'status',
      'agent_message_chunk',
      'turn_end',
      'status',
    ]);
    expect(client.eventsOf(session.id).find((event) => event.kind === 'permission_resolved')).toMatchObject({
      requestId: request.event.requestId,
      optionId: 'allow',
    });
    expect(client.eventsOf(session.id).filter((event) => event.kind === 'agent_message_chunk').at(-1)).toMatchObject({
      text: 'Escolhida: allow',
    });
    await client.close();
  });

  it('permissão cancelada (optionId null): resolved com null e o agente recebe cancelled', async () => {
    const { client, session } = await openSession();
    client.send({ type: 'prompt', sessionId: session.id, text: 'permission' });
    const request = await client.waitFor(isEvent('permission_request'));
    if (request.type !== 'event' || request.event.kind !== 'permission_request') throw new Error('sem request');

    client.send({ type: 'permission_response', sessionId: session.id, requestId: request.event.requestId, optionId: null });
    await client.waitFor(isEvent('turn_end'));

    expect(client.eventsOf(session.id).find((event) => event.kind === 'permission_resolved')).toMatchObject({
      optionId: null,
    });
    expect(client.eventsOf(session.id).filter((event) => event.kind === 'agent_message_chunk').at(-1)).toMatchObject({
      text: 'Cancelada',
    });
    await client.close();
  });

  it('permission_response com requestId desconhecido → error', async () => {
    const { client, session } = await openSession();
    client.send({ type: 'prompt', sessionId: session.id, text: 'permission' });
    await client.waitFor(isEvent('permission_request'));

    client.send({ type: 'permission_response', sessionId: session.id, requestId: 'nao-existe', optionId: 'allow' });
    await client.waitFor(isErrorFor(session.id));

    client.send({ type: 'cancel', sessionId: session.id });
    await client.waitFor(isEvent('turn_end'));
    await client.close();
  });

  it('cancel com permissão pendente: a permissão vira cancelada e o turno termina cancelled', async () => {
    const { client, session } = await openSession();
    client.send({ type: 'prompt', sessionId: session.id, text: 'permission' });
    await client.waitFor(isEvent('permission_request'));

    client.send({ type: 'cancel', sessionId: session.id });
    await client.waitFor(isEvent('permission_resolved'));
    const turnEnd = await client.waitFor(isEvent('turn_end'));

    expect(turnEnd).toMatchObject({ event: { stopReason: 'cancelled' } });
    expect(client.eventsOf(session.id).find((event) => event.kind === 'permission_resolved')).toMatchObject({
      optionId: null,
    });
    await client.close();
  });

  it('cancel durante turno longo: turn_end com stopReason cancelled', async () => {
    const { client, session } = await openSession();
    client.send({ type: 'prompt', sessionId: session.id, text: 'slow' });
    await client.waitFor((message) => message.type === 'event' && message.event.kind === 'agent_message_chunk' && message.event.text === 'Trabalhando');

    client.send({ type: 'cancel', sessionId: session.id });
    const turnEnd = await client.waitFor(isEvent('turn_end'));

    expect(turnEnd).toMatchObject({ event: { stopReason: 'cancelled' } });
    await client.waitFor(statusEvent(session.id, 'idle'));
    await client.close();
  });
});

describe('WS: config_options só para quem está inscrito', () => {
  const configOf = (client: WsTestClient, sessionId: string) =>
    client.messages.filter(
      (message): message is Extract<ServerMessage, { type: 'config_options' }> =>
        message.type === 'config_options' && message.sessionId === sessionId,
    );

  it('mudança de opção não vai para cliente que não assina a sessão', async () => {
    const { daemon, base, client, session } = await openSession();
    const other = await WsTestClient.connect(base, await pairToken(daemon));
    await other.sync();
    await client.sync();
    const before = configOf(client, session.id).length;

    client.send({ type: 'set_config', sessionId: session.id, configId: 'model', value: 'slow-model' });
    await client.waitFor((message) => message.type === 'config_options');
    await client.sync();
    await other.sync();

    expect(configOf(client, session.id)).toHaveLength(before + 1);
    expect(configOf(other, session.id)).toEqual([]);
    await other.close();
    await client.close();
  });

  it('subscribe manda as opções atuais depois do replay', async () => {
    const { daemon, base, client, session } = await openSession();
    client.send({ type: 'set_config', sessionId: session.id, configId: 'model', value: 'slow-model' });
    await client.waitFor((message) => message.type === 'config_options');

    const late = await WsTestClient.connect(base, await pairToken(daemon));
    late.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
    await late.waitFor((message) => message.type === 'config_options');
    await late.sync();

    const messages = late.messages;
    const configAt = messages.findIndex((message) => message.type === 'config_options');
    const lastEventAt = messages.reduce((at, message, index) => (message.type === 'event' ? index : at), -1);
    expect(configAt).toBeGreaterThan(lastEventAt);
    expect(configOf(late, session.id)[0]?.configOptions).toContainEqual(
      expect.objectContaining({ id: 'model', currentValue: 'slow-model' }),
    );
    await late.close();
    await client.close();
  });

  it('opções iguais às gravadas não são reenviadas (resume devolve as mesmas opções)', async () => {
    const { daemon, client, session } = await openSession();
    await client.sync();
    const before = configOf(client, session.id).length;
    expect(before).toBe(1);

    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });
    const res = await daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/resume`,
      headers: await authHeader(daemon),
    });
    expect(res.statusCode).toBe(200);
    await client.sync();

    expect(configOf(client, session.id)).toHaveLength(before);
    await client.close();
  });
});

describe('WS: set_config e config_option_update', () => {
  it('set_config troca o valor, persiste e manda config_options ao inscrito; valor inválido vira error', async () => {
    const { client, session, daemon } = await openSession();

    client.send({ type: 'set_config', sessionId: session.id, configId: 'model', value: 'slow-model' });
    const updated = await client.waitFor((message) => {
      if (message.type !== 'config_options' || message.sessionId !== session.id) return false;
      return message.configOptions.some((option) => option.id === 'model' && option.type === 'select' && option.currentValue === 'slow-model');
    });
    expect(updated.type).toBe('config_options');
    expect(await fetchConfigOptions(daemon, session.id)).toContainEqual(expect.objectContaining({ id: 'model', currentValue: 'slow-model' }));

    client.send({ type: 'set_config', sessionId: session.id, configId: 'model', value: 'nao-existe' });
    await client.waitFor(isErrorFor(session.id));

    client.send({ type: 'set_config', sessionId: session.id, configId: 'thought', value: true });
    await client.waitFor(isErrorFor(session.id));

    client.send({ type: 'set_config', sessionId: session.id, configId: 'nao-existe', value: 'x' });
    await client.waitFor(isErrorFor(session.id));
    await client.close();
  });

  it('config_option_update do agente atualiza as opções e manda config_options ao inscrito', async () => {
    const { client, session } = await openSession();

    client.send({ type: 'prompt', sessionId: session.id, text: 'config' });
    await client.waitFor((message) => {
      if (message.type !== 'config_options' || message.sessionId !== session.id) return false;
      return message.configOptions.some((option) => option.id === 'thought' && option.type === 'select' && option.currentValue === 'high');
    });
    await client.waitFor(isEvent('turn_end'));
    await client.close();
  });

  it('agente que só informa modes: opção "mode" sintetizada e troca via session/set_mode', async () => {
    const { client, session, daemon } = await openSession('modos');
    expect(await fetchConfigOptions(daemon, session.id)).toEqual([
      expect.objectContaining({ id: 'mode', category: 'mode', type: 'select', currentValue: 'default' }),
    ]);

    client.send({ type: 'set_config', sessionId: session.id, configId: 'mode', value: 'plan' });
    await client.waitFor((message) => {
      if (message.type !== 'config_options' || message.sessionId !== session.id) return false;
      return message.configOptions.some((option) => option.id === 'mode' && option.type === 'select' && option.currentValue === 'plan');
    });
    await client.close();
  });
});

describe('WS: agente que morre', () => {
  it('morte no meio do turno → evento error e status error; próximo prompt é recusado', async () => {
    const { client, session } = await openSession();
    client.send({ type: 'prompt', sessionId: session.id, text: 'die' });

    await client.waitFor(isEvent('error'));
    await client.waitFor(isSession(session.id, 'error'));

    client.send({ type: 'prompt', sessionId: session.id, text: 'de novo' });
    await client.waitFor(isErrorFor(session.id));
    await client.close();
  });
});

describe('WS: replay longo', () => {
  it('replay de 600 eventos com um turno ao vivo no meio: cada seq chega uma vez, em ordem', async () => {
    const { daemon, base, session, client } = await openSession();
    for (let i = 0; i < 600; i++) {
      insertEvent(daemon.db, {
        sessionId: session.id,
        ts: Date.now(),
        kind: 'agent_message_chunk',
        payload: JSON.stringify({ kind: 'agent_message_chunk', text: `antigo ${i}` }),
      });
    }

    const reader = await WsTestClient.connect(base, await pairToken(daemon));
    reader.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
    client.send({ type: 'prompt', sessionId: session.id, text: 'hello' });
    await client.waitFor(isEvent('turn_end'));
    await client.waitFor(statusEvent(session.id, 'idle'));

    const stored = listEvents(daemon.db, session.id, 0, 10_000).map((event) => event.seq);
    await reader.waitFor((message) => message.type === 'event' && message.event.seq === stored[stored.length - 1]);
    expect(reader.eventsOf(session.id).map((event) => event.seq)).toEqual(stored);
    await reader.close();
  });
});
