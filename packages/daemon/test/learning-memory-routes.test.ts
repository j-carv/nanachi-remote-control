import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LearningSettingsSchema, MemoryEntriesResponseSchema, WorkspaceSchema, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNanachiMcpServer } from '../src/nanachi-mcp.js';
import { insertEvent } from '../src/repository.js';
import { authHeader, createSession, fakeAgent, listen, readAgentEnv } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let pidDir: string;
beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-memory-routes-')));
  pidDir = join(base, 'pids');
  await mkdir(join(base, 'one'));
  await mkdir(join(base, 'two'));
});
afterEach(async () => { await removeTempDir(base); });
const env = setupDaemonTests();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(approvalRequired = false) {
  const daemon = await env.start({ config: { allowedRoots: [base], agents: { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }) } } });
  await listen(daemon);
  const auth = await authHeader(daemon);
  expect((await daemon.app.inject({ method: 'PUT', url: '/api/mcp/agents/fake', headers: auth, payload: { enabled: true } })).statusCode).toBe(200);
  expect((await daemon.app.inject({ method: 'PUT', url: '/api/learning/settings', headers: auth, payload: { ...LearningSettingsSchema.parse({}), enabled: true, enabledAgents: ['fake'], approvalRequired } })).statusCode).toBe(200);
  const sessions: Session[] = [];
  for (const name of ['one', 'two']) {
    const response = await daemon.app.inject({ method: 'POST', url: '/api/workspaces', headers: auth, payload: { path: join(base, name) } });
    const workspace = WorkspaceSchema.parse(response.json<unknown>());
    sessions.push(await createSession(daemon, { workspaceId: workspace.id, agent: 'fake' }));
  }
  const first = sessions[0];
  const second = sessions[1];
  if (first === undefined || second === undefined) throw new Error('Missing fixture sessions');
  const evidence = insertEvent(daemon.db, { sessionId: first.id, ts: 1, kind: 'user_message', payload: '{"text":"Remember to use the focused workspace tests."}' });
  const credentials = await readAgentEnv(pidDir, first.id);
  const headers = { 'x-nanachi-session': first.id, 'x-nanachi-agent-token': credentials.NANACHI_AGENT_TOKEN };
  return { daemon, auth, first, second, evidence, credentials, headers };
}
async function clientFor(credentials: NodeJS.ProcessEnv): Promise<Client> {
  const server = createNanachiMcpServer(credentials);
  const client = new Client({ name: 'learning-integration', version: '1.0.0' });
  cleanup.push(() => server.close(), () => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
function entries(response: { json: () => unknown }) { return MemoryEntriesResponseSchema.parse(response.json()).entries; }
async function list(daemon: TestDaemon, auth: { authorization: string }, workspaceId: string) {
  const response = await daemon.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/memories`, headers: auth });
  expect(response.statusCode).toBe(200);
  return entries(response);
}

describe('authenticated memory and skills routes and MCP', () => {
  it('executes both MCP tools against real SQLite/FTS without accepting model-controlled scopes', async () => {
    const { daemon, auth, first, second, evidence, credentials, headers } = await fixture();
    const client = await clientFor({ ...credentials });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('memory');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('skills');
    expect(await client.callTool({ name: 'memory', arguments: { action: 'save', title: 'Testing preference', content: 'Use focused workspace tests.', evidenceSeqs: [evidence] } })).toMatchObject({ isError: false });
    expect(await client.callTool({ name: 'skills', arguments: { action: 'save', title: 'Testing procedure', content: 'First run focused tests, then the complete suite.' } })).toMatchObject({ isError: false });
    expect(await client.callTool({ name: 'skills', arguments: { action: 'search', query: 'focused' } })).toMatchObject({ isError: false, structuredContent: { entries: [expect.objectContaining({ kind: 'skill' })] } });
    const stored = await list(daemon, auth, first.workspaceId);
    expect(stored).toHaveLength(2);
    expect(await list(daemon, auth, second.workspaceId)).toEqual([]);
    const skill = stored.find((entry) => entry.kind === 'skill');
    if (skill === undefined) throw new Error('Missing saved skill');
    const secondCredentials = await readAgentEnv(pidDir, second.id);
    expect((await daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers: { 'x-nanachi-session': second.id, 'x-nanachi-agent-token': secondCredentials.NANACHI_AGENT_TOKEN }, payload: { kind: 'skill', input: { action: 'read', id: skill.id } } })).statusCode).toBe(404);
    expect(await client.callTool({ name: 'memory', arguments: { action: 'read', id: skill.id } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: 'memory', arguments: { action: 'search', workspaceId: second.workspaceId } })).toMatchObject({ isError: true });
    const crossed = await daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers, payload: { kind: 'memory', workspaceId: second.workspaceId, input: { action: 'search' } } });
    expect(crossed.statusCode).toBe(400);
    expect((await daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers: { ...headers, 'x-nanachi-session': second.id }, payload: { kind: 'memory', input: { action: 'search' } } })).statusCode).toBe(401);
    expect((await daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers: { ...headers, 'x-forwarded-for': '192.0.2.1' }, payload: { kind: 'memory', input: { action: 'search' } } })).statusCode).toBe(403);
  });

  it('requires both opt-ins, rotates stale authentication, and leaves device management available when disabled', async () => {
    const { daemon, auth, first, headers } = await fixture();
    const request = { method: 'POST' as const, url: '/api/agent/memory', headers, payload: { kind: 'memory', input: { action: 'search' } } };
    expect((await daemon.app.inject({ ...request, headers: {} })).statusCode).toBe(401);
    expect((await daemon.app.inject({ method: 'PUT', url: '/api/mcp/agents/fake', headers: auth, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await daemon.app.inject(request)).statusCode).toBe(403);
    expect((await daemon.app.inject({ method: 'PUT', url: '/api/mcp/agents/fake', headers: auth, payload: { enabled: true } })).statusCode).toBe(200);
    expect((await daemon.app.inject({ method: 'PUT', url: '/api/learning/settings', headers: auth, payload: LearningSettingsSchema.parse({}) })).statusCode).toBe(200);
    expect((await daemon.app.inject(request)).statusCode).toBe(403);
    const manual = await daemon.app.inject({ method: 'POST', url: `/api/workspaces/${first.workspaceId}/memories`, headers: auth, payload: { kind: 'memory', title: 'Owner entry', content: 'Owner-managed content' } });
    expect(manual.statusCode).toBe(200);
    expect(entries(manual)).toHaveLength(1);
    expect((await daemon.app.inject({ method: 'GET', url: `/api/workspaces/${first.workspaceId}/memories` })).statusCode).toBe(401);
    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${first.id}`, headers: auth });
    expect((await daemon.app.inject(request)).statusCode).toBe(401);
  });

  it('persists approval, rejection and version conflicts through device actions, not mocked responses', async () => {
    const { daemon, auth, first, second, evidence, headers } = await fixture(true);
    const save = () => daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers, payload: { kind: 'skill', input: { action: 'save', title: 'Safe tests', content: 'Run the isolated test suite.', evidenceSeqs: [evidence] } } });
    const proposed = entries(await save())[0];
    if (proposed === undefined || proposed.reviewId === null) throw new Error('Missing review proposal');
    expect(proposed.status).toBe('pending');
    const search = await daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers, payload: { kind: 'skill', input: { action: 'search' } } });
    expect(entries(search)).toEqual([]);
    const notices = () => daemon.db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND kind = 'learning'").get(first.id)?.count;
    expect(notices()).toBe(1);
    await save();
    expect(notices()).toBe(1);
    expect((await daemon.app.inject({ method: 'POST', url: `/api/workspaces/${second.workspaceId}/learning/${proposed.reviewId}/approve`, headers: auth })).statusCode).toBe(404);
    const approved = await daemon.app.inject({ method: 'POST', url: `/api/workspaces/${first.workspaceId}/learning/${proposed.reviewId}/approve`, headers: auth });
    expect(approved.json()).toMatchObject({ status: 'applied' });
    const current = (await list(daemon, auth, first.workspaceId))[0];
    if (current === undefined) throw new Error('Missing approved entry');
    expect(current.status).toBe('active');
    const edit = await daemon.app.inject({ method: 'POST', url: `/api/workspaces/${first.workspaceId}/memories`, headers: auth, payload: { id: current.id, expectedVersion: current.version, kind: current.kind, title: current.title, content: 'Owner changed the procedure.' } });
    expect(edit.statusCode).toBe(200);
    expect((await daemon.app.inject({ method: 'POST', url: `/api/workspaces/${first.workspaceId}/learning/${proposed.reviewId}/revert`, headers: auth })).statusCode).toBe(409);
    expect((await daemon.app.inject({ method: 'DELETE', url: `/api/workspaces/${first.workspaceId}/memories/${current.id}`, headers: auth, payload: { expectedVersion: current.version } })).statusCode).toBe(409);
    expect((await list(daemon, auth, first.workspaceId))[0]?.content).toBe('Owner changed the procedure.');
    const rejectedProposal = entries(await save())[0];
    if (rejectedProposal === undefined || rejectedProposal.reviewId === null) throw new Error('Missing rejection proposal');
    const rejected = await daemon.app.inject({ method: 'POST', url: `/api/workspaces/${first.workspaceId}/learning/${rejectedProposal.reviewId}/reject`, headers: auth });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ reviewId: rejectedProposal.reviewId, status: 'rejected', entryIds: [] });
    expect(await list(daemon, auth, first.workspaceId)).toHaveLength(1);
    const latestNotice = daemon.db.prepare<[string], { payload: string }>("SELECT payload FROM events WHERE session_id = ? AND kind = 'learning' ORDER BY seq DESC LIMIT 1").get(first.id);
    expect(JSON.parse(latestNotice?.payload ?? '{}')).toMatchObject({ reviewId: rejectedProposal.reviewId, status: 'rejected' });
  });
});
