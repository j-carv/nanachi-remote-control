import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { SessionSchema, WorkspaceSchema, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PHONE_SEND_HINT } from '../src/acp-mapping.js';
import {
  authHeader,
  createSession,
  fakeAgent,
  isEvent,
  listen,
  pairToken,
  promptsReceived,
  WsTestClient,
  writeAgentStore,
} from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Aviso do phone-send: vai no PRIMEIRO prompt de sessão ACP criada pelo app, como bloco de texto depois do texto
 * do usuário. O user_message gravado não tem o aviso. Importadas e retomadas não recebem.
 */

let base: string;
let workspace: string;
let pidDir: string;
let store: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-hint-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  store = join(base, 'agente.json');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado depois do afterEach acima: os daemons param antes da pasta sumir.
const env = setupDaemonTests();

async function start(config: Record<string, unknown> = {}): Promise<TestDaemon> {
  return env.start({
    config: {
      allowedRoots: [base],
      agents: { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_STORE: store }) },
      ...config,
    },
  });
}

async function workspaceIdOf(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

async function subscribed(daemon: TestDaemon, session: Session): Promise<WsTestClient> {
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return client;
}

const HINT_BLOCK: acp.ContentBlock = { type: 'text', text: PHONE_SEND_HINT };

describe('aviso do phone-send no primeiro prompt', () => {
  it('sessão criada pelo app: primeiro prompt leva o aviso como último bloco; user_message não', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceIdOf(daemon), agent: 'fake' });
    const client = await subscribed(daemon, session);

    client.send({ type: 'prompt', sessionId: session.id, text: 'olha isto', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    expect(await promptsReceived(pidDir, session.id)).toEqual([
      [{ type: 'text', text: 'olha isto' }, HINT_BLOCK],
    ]);
    const userMessage = client.eventsOf(session.id).find((event) => event.kind === 'user_message');
    expect(userMessage).toMatchObject({ kind: 'user_message', text: 'olha isto' });
  });

  it('segundo prompt da mesma sessão não leva o aviso', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceIdOf(daemon), agent: 'fake' });
    const client = await subscribed(daemon, session);

    client.send({ type: 'prompt', sessionId: session.id, text: 'um', attachments: [] });
    await client.waitFor(isEvent('turn_end'));
    client.send({ type: 'prompt', sessionId: session.id, text: 'dois', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    expect(await promptsReceived(pidDir, session.id)).toEqual([
      [{ type: 'text', text: 'um' }, HINT_BLOCK],
      [{ type: 'text', text: 'dois' }],
    ]);
  });

  it('phoneSendHint: false desliga o aviso', async () => {
    const daemon = await start({ phoneSendHint: false });
    const session = await createSession(daemon, { workspaceId: await workspaceIdOf(daemon), agent: 'fake' });
    const client = await subscribed(daemon, session);

    client.send({ type: 'prompt', sessionId: session.id, text: 'oi', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    expect(await promptsReceived(pidDir, session.id)).toEqual([[{ type: 'text', text: 'oi' }]]);
  });

  it('sessão importada do PC não leva o aviso no primeiro prompt', async () => {
    await writeAgentStore(store, [
      { sessionId: 'antiga', cwd: workspace, title: 'Antiga', updatedAt: '2026-11-02T10:00:00.000Z', history: [] },
    ]);
    const daemon = await start();
    const workspaceId = await workspaceIdOf(daemon);
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId, agent: 'fake', resumeAcpSessionId: 'antiga' },
    });
    expect(res.statusCode).toBe(201);
    const session = SessionSchema.parse(res.json<unknown>());
    const client = await subscribed(daemon, session);

    client.send({ type: 'prompt', sessionId: session.id, text: 'continua', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    expect(await promptsReceived(pidDir, session.id)).toEqual([[{ type: 'text', text: 'continua' }]]);
  });
});
