import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSchema, type AgentConfig, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  fakeAgent,
  isEvent,
  listen,
  pairToken,
  readAgentEnv,
  WsTestClient,
} from './agent-support.js';
import type { NotifyDetails, NotifyKind } from '../src/notify.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-notify-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes dos daemons: o afterEach roda por último, depois que os agentes já morreram.
const env = setupDaemonTests();

interface Call {
  sessionId: string;
  kind: NotifyKind;
  details: NotifyDetails;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function open(onNotify?: (sessionId: string, kind: NotifyKind, details: NotifyDetails) => void): Promise<{
  daemon: TestDaemon;
  session: Session;
  client: WsTestClient;
}> {
  const agents: Record<string, AgentConfig> = { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }) };
  const daemon = await env.start({ config: { allowedRoots: [base], agents }, onNotify });
  const created = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  const session = await createSession(daemon, { workspaceId: WorkspaceSchema.parse(created.json<unknown>()).id, agent: 'fake' });
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return { daemon, session, client };
}

describe('onNotify (ponto de extensão para o Web Push)', () => {
  it('avisa turn_end ao fim do turno, sem avisar chunks nem status', async () => {
    const calls: Call[] = [];
    const { session, client } = await open((sessionId, kind, details) => calls.push({ sessionId, kind, details }));

    client.send({ type: 'prompt', sessionId: session.id, text: 'hello' });
    await client.waitFor(isEvent('turn_end'));
    await client.waitFor((message) => message.type === 'session' && message.session.status === 'idle');

    expect(calls).toEqual([
      { sessionId: session.id, kind: 'turn_end', details: expect.objectContaining({ kind: 'turn_end', stopReason: 'end_turn' }) },
    ]);
  });

  it('avisa permission_request quando o agente pede aprovação', async () => {
    const calls: Call[] = [];
    const { session, client } = await open((sessionId, kind, details) => calls.push({ sessionId, kind, details }));

    client.send({ type: 'prompt', sessionId: session.id, text: 'permission' });
    const request = await client.waitFor(isEvent('permission_request'));
    if (request.type !== 'event' || request.event.kind !== 'permission_request') throw new Error('esperava permission_request');
    client.send({ type: 'permission_response', sessionId: session.id, requestId: request.event.requestId, optionId: 'allow' });
    await client.waitFor(isEvent('turn_end'));

    expect(calls.map((call) => call.kind)).toEqual(['permission_request', 'turn_end']);
    expect(calls[0]?.details).toMatchObject({ kind: 'permission_request', title: 'Executar comando' });
  });

  it('avisa error quando o agente morre no meio do turno', async () => {
    const calls: Call[] = [];
    const { session, client } = await open((sessionId, kind, details) => calls.push({ sessionId, kind, details }));

    client.send({ type: 'prompt', sessionId: session.id, text: 'die' });
    await client.waitFor(isEvent('error'));

    expect(calls.map((call) => call.kind)).toContain('error');
  });

  it('avisa file quando o agente manda um arquivo para o celular', async () => {
    const calls: Call[] = [];
    const { daemon, session } = await open((sessionId, kind, details) => calls.push({ sessionId, kind, details }));
    const agentEnv = await readAgentEnv(pidDir, session.id);

    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/agent/files',
      headers: {
        'content-type': 'image/png',
        'x-file-name': 'print.png',
        'x-caption': encodeURIComponent('veja'),
        'x-nanachi-session': agentEnv.AGENT_SESSION_ID,
        'x-nanachi-agent-token': agentEnv.NANACHI_AGENT_TOKEN,
      },
      payload: PNG,
    });

    expect(res.statusCode).toBe(201);
    expect(calls).toEqual([
      {
        sessionId: session.id,
        kind: 'file',
        details: expect.objectContaining({ kind: 'file', name: 'print.png', direction: 'to_phone', caption: 'veja' }),
      },
    ]);
  });

  it('o handler que falha não impede o evento de ser gravado nem o turno de terminar', async () => {
    const { session, client, daemon } = await open(() => {
      throw new Error('push indisponível');
    });

    client.send({ type: 'prompt', sessionId: session.id, text: 'hello' });
    await client.waitFor(isEvent('turn_end'));
    await client.waitFor((message) => message.type === 'session' && message.session.status === 'idle');

    const stored = daemon.db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND kind = 'turn_end'").get(session.id);
    expect(stored).toEqual({ n: 1 });
  });

  it('sem onNotify, nada muda no fluxo (o padrão do daemon)', async () => {
    const { session, client } = await open();

    client.send({ type: 'prompt', sessionId: session.id, text: 'hello' });
    await client.waitFor(isEvent('turn_end'));

    expect(client.eventsOf(session.id).some((event) => event.kind === 'turn_end')).toBe(true);
  });
});
