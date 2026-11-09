import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { SessionSchema, WorkspaceSchema, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader, createSession, fakeAgent, isEvent, listen, pairToken,
  promptsReceived, readAgentEnv, WsTestClient, writeAgentStore,
} from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;
let store: string;
beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-mcp-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  store = join(base, 'agente.json');
  await mkdir(workspace);
});
afterEach(async () => { await removeTempDir(base); });
const env = setupDaemonTests();

async function start(restoreMethod = 'load'): Promise<TestDaemon> {
  const daemon = await env.start({ config: {
    allowedRoots: [base],
    agents: {
      fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_STORE: store, FAKE_AGENT_RESUME: restoreMethod }),
      other: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }),
    },
  } });
  await listen(daemon);
  return daemon;
}
async function setEnabled(daemon: TestDaemon, enabled: boolean): Promise<void> {
  const response = await daemon.app.inject({
    method: 'PUT', url: '/api/mcp/agents/fake', headers: await authHeader(daemon), payload: { enabled },
  });
  expect(response.statusCode).toBe(200);
}
async function workspaceIdOf(daemon: TestDaemon): Promise<string> {
  const response = await daemon.app.inject({
    method: 'POST', url: '/api/workspaces', headers: await authHeader(daemon), payload: { path: workspace },
  });
  return WorkspaceSchema.parse(response.json<unknown>()).id;
}
async function subscribed(daemon: TestDaemon, session: Session): Promise<WsTestClient> {
  const address = daemon.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('test daemon is not listening');
  const client = await WsTestClient.connect(`http://127.0.0.1:${address.port}`, await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return client;
}
interface McpRequest { method: string; cwd: string; mcpServers: acp.McpServerStdio[] }
async function requests(sessionId: string): Promise<McpRequest[]> {
  const raw = await readFile(join(pidDir, `${sessionId}.mcp.jsonl`), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as McpRequest);
}
function expectDescriptor(request: McpRequest | undefined, sessionId: string, enabled: boolean): void {
  expect(request?.cwd).toBe(workspace);
  if (!enabled) { expect(request?.mcpServers).toEqual([]); return; }
  expect(request?.mcpServers).toHaveLength(1);
  const descriptor = request?.mcpServers[0];
  expect(descriptor?.name).toBe('nanachi-remote');
  expect(descriptor).not.toHaveProperty('type');
  expect(descriptor?.command).toBe(process.execPath);
  expect(isAbsolute(descriptor?.args.at(-1) ?? '')).toBe(true);
  expect(descriptor?.args.at(-1)).toMatch(/nanachi-mcp\.(ts|js)$/);
  expect(descriptor?.env).toEqual([
    { name: 'AGENT_SESSION_ID', value: sessionId },
    { name: 'NANACHI_URL', value: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) },
    { name: 'NANACHI_AGENT_TOKEN', value: '<redacted>', matchesSessionToken: true },
    { name: 'NANACHI_WORKSPACE', value: workspace },
  ]);
}
async function prompt(client: WsTestClient, sessionId: string, text: string): Promise<void> {
  client.send({ type: 'prompt', sessionId, text, attachments: [] });
  await client.waitFor(isEvent('turn_end'));
}

describe('native Nanachi MCP session integration', () => {
  it('defaults to no tools for every selected agent and opts in only the chosen agent', async () => {
    const daemon = await start();
    const workspaceId = await workspaceIdOf(daemon);
    const disabled = await createSession(daemon, { workspaceId, agent: 'fake' });
    expectDescriptor((await requests(disabled.id))[0], disabled.id, false);
    await setEnabled(daemon, true);
    const enabled = await createSession(daemon, { workspaceId, agent: 'fake' });
    expectDescriptor((await requests(enabled.id))[0], enabled.id, true);
    const other = await createSession(daemon, { workspaceId, agent: 'other' });
    expectDescriptor((await requests(other.id))[0], other.id, false);
    expectDescriptor((await requests(disabled.id))[0], disabled.id, false);
  });

  it('changing the setting during a busy turn leaves its process and tools untouched', async () => {
    const daemon = await start();
    await setEnabled(daemon, true);
    const session = await createSession(daemon, { workspaceId: await workspaceIdOf(daemon), agent: 'fake' });
    const client = await subscribed(daemon, session);
    const pid = await readFile(join(pidDir, `${session.id}.pid`), 'utf8');
    client.send({ type: 'prompt', sessionId: session.id, text: 'slow', attachments: [] });
    await client.waitFor((message) => message.type === 'event' && message.event.kind === 'status' && message.event.status === 'running');
    await setEnabled(daemon, false);
    expect(await readFile(join(pidDir, `${session.id}.pid`), 'utf8')).toBe(pid);
    const recorded = await requests(session.id);
    expect(recorded).toHaveLength(1);
    expectDescriptor(recorded[0], session.id, true);
    client.send({ type: 'cancel', sessionId: session.id });
    await client.waitFor(isEvent('turn_end'));
    await prompt(client, session.id, '/eco still alive');
  });

  it('the actual ACP descriptor discovers and calls phone_send over stdio without changing ordinary prompts', async () => {
    const daemon = await start();
    await setEnabled(daemon, true);
    const session = await createSession(daemon, { workspaceId: await workspaceIdOf(daemon), agent: 'fake' });
    const client = await subscribed(daemon, session);
    await writeFile(join(workspace, 'nota.txt'), 'olá celular');
    await prompt(client, session.id, '/nanachi-send {"path":"nota.txt","caption":"Veja isso"}');
    const reply = client.eventsOf(session.id).find((event) => event.kind === 'agent_message_chunk');
    expect(reply).toMatchObject({ kind: 'agent_message_chunk', text: expect.stringContaining('enviado: nota.txt') });
    const event = client.eventsOf(session.id).find((item) => item.kind === 'file');
    expect(event).toMatchObject({ kind: 'file', name: 'nota.txt', direction: 'to_phone', caption: 'Veja isso' });
    await prompt(client, session.id, '/eco intact');
    await prompt(client, session.id, 'normal');
    expect((await promptsReceived(pidDir, session.id)).slice(-2)).toEqual([
      [{ type: 'text', text: '/eco intact' }], [{ type: 'text', text: 'normal' }],
    ]);
    const token = (await readAgentEnv(pidDir, session.id)).NANACHI_AGENT_TOKEN;
    expect(await readFile(join(pidDir, `${session.id}.mcp.jsonl`), 'utf8')).not.toContain(token);
    expect(await readFile(join(daemon.home, 'mcp.json'), 'utf8')).not.toContain(token);
  });

  it.each(['load', 'resume'].flatMap((method) => [true, false].map((enabled) => ({ method, enabled }))))
  ('imports with session/$method and enabled=$enabled', async ({ method, enabled }) => {
    await writeAgentStore(store, [{ sessionId: 'antiga', cwd: workspace, title: 'Antiga', updatedAt: null, history: [] }]);
    const daemon = await start(method);
    await setEnabled(daemon, enabled);
    const response = await daemon.app.inject({
      method: 'POST', url: '/api/sessions', headers: await authHeader(daemon),
      payload: { workspaceId: await workspaceIdOf(daemon), agent: 'fake', resumeAcpSessionId: 'antiga' },
    });
    expect(response.statusCode).toBe(201);
    const session = SessionSchema.parse(response.json<unknown>());
    const [request] = await requests(session.id);
    expect(request?.method).toBe(`session/${method}`);
    expectDescriptor(request, session.id, enabled);
  });

  it.each(['load', 'resume'].flatMap((method) => [true, false].flatMap((manual) => [true, false].map((enabled) => ({ method, manual, enabled })))))
  ('restores current tools ($method, manual=$manual, enabled=$enabled) with unchanged slash and normal text', async ({ method, manual, enabled }) => {
    const daemon = await start(method);
    await setEnabled(daemon, !enabled);
    const session = await createSession(daemon, { workspaceId: await workspaceIdOf(daemon), agent: 'fake' });
    const client = await subscribed(daemon, session);
    await prompt(client, session.id, 'before');
    const previous = await readAgentEnv(pidDir, session.id);
    const pid = await readFile(join(pidDir, `${session.id}.pid`), 'utf8');
    await setEnabled(daemon, enabled);
    expect(await readFile(join(pidDir, `${session.id}.pid`), 'utf8')).toBe(pid);
    expect(await requests(session.id)).toHaveLength(1);
    const headers = await authHeader(daemon);
    const stopped = await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers });
    expect(stopped.statusCode).toBe(204);
    if (manual) {
      const resumed = await daemon.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/resume`, headers });
      expect(resumed.statusCode).toBe(200);
    }
    for (const text of ['/eco unchanged', 'after', 'next']) await prompt(client, session.id, text);
    const recorded = await requests(session.id);
    expect(recorded.map((request) => request.method)).toEqual(['session/new', `session/${method}`]);
    expectDescriptor(recorded[1], session.id, enabled);
    const current = await readAgentEnv(pidDir, session.id);
    expect(current.NANACHI_AGENT_TOKEN === previous.NANACHI_AGENT_TOKEN).toBe(false);
    expect(await promptsReceived(pidDir, session.id)).toEqual(['before', '/eco unchanged', 'after', 'next'].map((text) => [{ type: 'text', text }]));
    expect(client.eventsOf(session.id).filter((event) => event.kind === 'user_message').map((event) => event.text))
      .toEqual(['before', '/eco unchanged', 'after', 'next']);
  });
});
