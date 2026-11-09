import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  AskUserResultSchema,
  EventsResponseSchema,
  SessionsResponseSchema,
  type AskUserRequest,
  type Session,
  type SessionEvent,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNanachiMcpServer } from '../src/nanachi-mcp.js';
import { insertEvent } from '../src/repository.js';
import {
  authHeader, createSession, createWorkspace, fakeAgent, isEvent, listen, pairToken,
  readAgentEnv, WsTestClient,
} from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

const INPUT = {
  question: 'Which exact change should I make?',
  options: [{ id: 'review', label: 'Review only' }, { id: 'apply', label: 'Apply the change' }],
};
type Question = Extract<SessionEvent, { kind: 'user_question' }>;
let base: string;
let workspace: string;
let pidDir: string;
beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-ask-user-')));
  workspace = join(base, 'workspace');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});
afterEach(async () => { await removeTempDir(base); });
const env = setupDaemonTests();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

interface Rig {
  daemon: TestDaemon;
  session: Session;
  ws: WsTestClient;
  baseUrl: string;
  deviceHeaders: { authorization: string };
  credentials: NodeJS.ProcessEnv;
  agentHeaders: Record<string, string>;
}
async function connect(daemon: TestDaemon, baseUrl: string, sessionId: string): Promise<WsTestClient> {
  const ws = await WsTestClient.connect(baseUrl, await pairToken(daemon));
  cleanup.push(() => ws.close());
  ws.send({ type: 'subscribe', sessionId, afterSeq: 0 });
  await ws.waitFor(isEvent('status'));
  await ws.sync();
  return ws;
}
async function rig(options: { timeoutMs?: number; prompt?: string; enabled?: boolean } = {}): Promise<Rig> {
  const daemon = await env.start({
    askUserTimeoutMs: options.timeoutMs,
    config: { allowedRoots: [base], agents: { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }) } },
  });
  const baseUrl = await listen(daemon);
  const deviceHeaders = await authHeader(daemon);
  if (options.enabled) {
    expect((await daemon.app.inject({ method: 'PUT', url: '/api/mcp/agents/fake', headers: deviceHeaders, payload: { enabled: true } })).statusCode).toBe(200);
  }
  const session = await createSession(daemon, { workspaceId: await createWorkspace(daemon, workspace), agent: 'fake' });
  const credentials: NodeJS.ProcessEnv = { ...await readAgentEnv(pidDir, session.id), NANACHI_WORKSPACE: workspace };
  const ws = await connect(daemon, baseUrl, session.id);
  if (options.prompt !== '') {
    ws.send({ type: 'prompt', sessionId: session.id, text: options.prompt ?? 'slow' });
    await ws.waitFor((message) => message.type === 'event' && message.event.kind === 'status' && message.event.status === 'running');
  }
  return {
    daemon, baseUrl, session, deviceHeaders, credentials, ws,
    agentHeaders: {
      'Content-Type': 'application/json',
      'X-Nanachi-Session': session.id,
      'X-Nanachi-Agent-Token': credentials.NANACHI_AGENT_TOKEN ?? '',
    },
  };
}
async function mcpClient(credentials: NodeJS.ProcessEnv): Promise<Client> {
  const server = createNanachiMcpServer(credentials);
  const client = new Client({ name: 'ask-user-test', version: '1.0.0' });
  cleanup.push(() => server.close(), () => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
async function nextQuestion(ws: WsTestClient): Promise<Question> {
  const message = await ws.waitFor(isEvent('user_question'));
  if (message.type !== 'event' || message.event.kind !== 'user_question') throw new Error('expected a user question');
  return message.event;
}
function request(r: Rig, input: AskUserRequest, signal?: AbortSignal): Promise<Response> {
  return fetch(`${r.baseUrl}/api/agent/questions`, {
    method: 'POST', headers: r.agentHeaders, body: JSON.stringify(input), ...(signal === undefined ? {} : { signal }),
  });
}
function answer(r: Rig, question: Question, optionId: string | null, sessionId = r.session.id) {
  return r.daemon.app.inject({
    method: 'POST', url: `/api/sessions/${sessionId}/questions/${question.requestId}/respond`,
    headers: r.deviceHeaders, payload: { optionId },
  });
}
async function history(r: Rig): Promise<SessionEvent[]> {
  const response = await r.daemon.app.inject({ method: 'GET', url: `/api/sessions/${r.session.id}/events`, headers: r.deviceHeaders });
  return EventsResponseSchema.parse(response.json<unknown>()).events;
}
function resultFromText(result: unknown) {
  const parsed = CallToolResultSchema.parse(result);
  const text = parsed.content.find((item) => item.type === 'text');
  if (text === undefined || text.type !== 'text') throw new Error('missing MCP text result');
  return AskUserResultSchema.parse(JSON.parse(text.text) as unknown);
}

describe('ask_user MCP and real question routes', () => {
  it('blocks an SDK call until the exact explicit selection, keeps the turn running, and persists one resolution', async () => {
    const r = await rig();
    const client = await mcpClient(r.credentials);
    r.ws.send({ type: 'set_yolo', sessionId: r.session.id, enabled: true });
    await r.ws.waitFor((message) => message.type === 'yolo' && message.sessionId === r.session.id && message.enabled);
    const call = client.callTool({ name: 'ask_user', arguments: {
      question: `  ${INPUT.question}  `, options: INPUT.options.map((option) => ({ ...option, label: `  ${option.label}  ` })),
    } });
    let settled = false;
    void call.then(() => { settled = true; });
    const question = await nextQuestion(r.ws);
    expect(question).toMatchObject(INPUT);
    expect(question.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await r.ws.sync();
    expect(settled).toBe(false);
    const sessions = await r.daemon.app.inject({ method: 'GET', url: `/api/workspaces/${r.session.workspaceId}/sessions`, headers: r.deviceHeaders });
    expect(SessionsResponseSchema.parse(sessions.json<unknown>()).sessions.find((session) => session.id === r.session.id)?.status).toBe('running');
    const chosen = { status: 'answered', option: INPUT.options[1] };
    const reply = await answer(r, question, 'apply');
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual(chosen);
    const result = await call;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(chosen);
    expect(resultFromText(result)).toEqual(chosen);
    expect((await answer(r, question, 'review')).statusCode).toBe(409);
    expect((await history(r)).filter((event) => event.kind === 'user_question_resolved')).toEqual([
      expect.objectContaining({ requestId: question.requestId, result: chosen }),
    ]);
    expect((await history(r)).some((event) => event.kind === 'turn_end')).toBe(false);
  });

  it('uses the actual opted-in ACP stdio descriptor and resumes the same agent turn with the choice', async () => {
    const r = await rig({ enabled: true, prompt: '' });
    r.ws.send({ type: 'prompt', sessionId: r.session.id, text: `/nanachi-ask ${JSON.stringify(INPUT)}` });
    const question = await nextQuestion(r.ws);
    expect(r.ws.eventsOf(r.session.id).some((event) => event.kind === 'turn_end')).toBe(false);
    expect((await answer(r, question, 'review')).statusCode).toBe(200);
    await r.ws.waitFor(isEvent('turn_end'));
    const chunks = r.ws.eventsOf(r.session.id).flatMap((event) => event.kind === 'agent_message_chunk' ? [event.text] : []);
    const result: unknown = JSON.parse(chunks.join(''));
    expect(resultFromText(result)).toEqual({ status: 'answered', option: INPUT.options[0] });
    r.ws.send({ type: 'prompt', sessionId: r.session.id, text: '/eco same process' });
    await r.ws.waitFor(isEvent('turn_end'));
    expect(r.ws.eventsOf(r.session.id)).toContainEqual(expect.objectContaining({ kind: 'agent_message_chunk', text: 'same process' }));
    const token = r.credentials.NANACHI_AGENT_TOKEN ?? '<missing>';
    expect(JSON.stringify(await history(r))).not.toContain(token);
    expect(await readFile(join(pidDir, `${r.session.id}.mcp.jsonl`), 'utf8')).not.toContain(token);
  });

  it.each([
    {}, { question: ' ', options: INPUT.options }, { ...INPUT, options: [INPUT.options[0]] },
    { ...INPUT, options: [{ id: 'same', label: 'One' }, { id: 'same', label: 'Two' }] },
    { ...INPUT, options: [{ id: '../bad', label: 'One' }, INPUT.options[1]] },
    { ...INPUT, requestId: randomUUID() }, { ...INPUT, sessionId: 'another' }, { ...INPUT, token: 'model-token' },
  ])('rejects invalid or authority-bearing model input without creating a question: %j', async (input) => {
    const r = await rig();
    const client = await mcpClient(r.credentials);
    expect(await client.callTool({ name: 'ask_user', arguments: input })).toMatchObject({ isError: true });
    expect((await history(r)).filter((event) => event.kind === 'user_question')).toEqual([]);
  });

  it('rejects invalid device replies, wrong sessions and competing selections without crossing requests', async () => {
    const r = await rig();
    const other = await createSession(r.daemon, { workspaceId: r.session.workspaceId, agent: 'fake' });
    const input = { ...INPUT, requestId: randomUUID() };
    const pending = request(r, input);
    const question = await nextQuestion(r.ws);
    expect((await request(r, input)).status).toBe(409);
    expect((await answer(r, question, 'not-an-option')).statusCode).toBe(400);
    expect((await answer(r, question, 'apply', other.id)).statusCode).toBe(409);
    expect((await answer(r, question, 'apply', randomUUID())).statusCode).toBe(404);
    expect((await r.daemon.app.inject({ method: 'POST', url: `/api/sessions/${r.session.id}/questions/${question.requestId}/respond`, headers: r.deviceHeaders, payload: { optionId: 'apply', label: 'forged' } })).statusCode).toBe(400);
    expect((await r.daemon.app.inject({ method: 'POST', url: `/api/sessions/${r.session.id}/questions/${question.requestId}/respond`, payload: { optionId: 'apply' } })).statusCode).toBe(401);
    const competitors = await Promise.all([answer(r, question, 'review'), answer(r, question, 'apply')]);
    expect(competitors.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
    const winner = competitors.find((reply) => reply.statusCode === 200);
    expect(await (await pending).json()).toEqual(winner?.json());
    expect((await history(r)).filter((event) => event.kind === 'user_question_resolved')).toHaveLength(1);
    expect((await request(r, input)).status).toBe(409);
  });

  it('keeps simultaneous sessions isolated and bounds pending questions per session', async () => {
    const r = await rig();
    const other = await createSession(r.daemon, { workspaceId: r.session.workspaceId, agent: 'fake' });
    const otherWs = await connect(r.daemon, r.baseUrl, other.id);
    otherWs.send({ type: 'prompt', sessionId: other.id, text: 'slow' });
    await otherWs.waitFor((message) => message.type === 'event' && message.event.kind === 'status' && message.event.status === 'running');
    const otherEnv = await readAgentEnv(pidDir, other.id);
    const otherRig = { ...r, session: other, agentHeaders: { ...r.agentHeaders, 'X-Nanachi-Session': other.id, 'X-Nanachi-Agent-Token': otherEnv.NANACHI_AGENT_TOKEN } };
    const pending: Array<Promise<Response>> = [];
    const questions: Question[] = [];
    for (let index = 0; index < 8; index += 1) {
      pending.push(request(r, { ...INPUT, requestId: randomUUID() }));
      questions.push(await nextQuestion(r.ws));
    }
    expect((await request(r, { ...INPUT, requestId: randomUUID() })).status).toBe(429);
    const otherPending = request(otherRig, { ...INPUT, requestId: randomUUID() });
    const otherQuestion = await nextQuestion(otherWs);
    expect((await answer(r, otherQuestion, 'apply')).statusCode).toBe(409);
    expect((await answer(otherRig, otherQuestion, 'review')).statusCode).toBe(200);
    expect(await (await otherPending).json()).toEqual({ status: 'answered', option: INPUT.options[0] });
    for (const question of questions) expect((await answer(r, question, null)).statusCode).toBe(200);
    for (const response of await Promise.all(pending)) expect(await response.json()).toEqual({ status: 'cancelled', reason: 'user_cancelled' });
  });

  it.each(['user', 'session', 'stop', 'expiry', 'shutdown'] as const)('returns explicit non-answers on %s cancellation and refuses stale selections', async (reason) => {
    const r = await rig({ ...(reason === 'expiry' ? { timeoutMs: 80 } : {}) });
    const client = await mcpClient(r.credentials);
    const pending = client.callTool({ name: 'ask_user', arguments: INPUT });
    const question = await nextQuestion(r.ws);
    if (reason === 'user') await answer(r, question, null);
    if (reason === 'session') r.ws.send({ type: 'cancel', sessionId: r.session.id });
    if (reason === 'stop') await r.daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${r.session.id}`, headers: r.deviceHeaders });
    if (reason === 'shutdown') await r.daemon.app.close();
    const expected = { status: 'cancelled', reason: reason === 'user' ? 'user_cancelled' : reason === 'expiry' ? 'expired' : 'session_ended' };
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(resultFromText(result)).toEqual(expected);
    if (reason === 'session') expect((await request(r, { ...INPUT, requestId: randomUUID() })).status).toBe(409);
    if (reason !== 'shutdown') {
      expect((await answer(r, question, 'apply')).statusCode).toBe(409);
      expect((await history(r)).filter((event) => event.kind === 'user_question_resolved')).toEqual([
        expect.objectContaining({ requestId: question.requestId, result: expected }),
      ]);
    }
  });

  it('cancels on MCP SDK cancellation by disconnecting its HTTP response, not when the request body ends', async () => {
    const r = await rig();
    const client = await mcpClient(r.credentials);
    const abort = new AbortController();
    const pending = client.callTool({ name: 'ask_user', arguments: INPUT }, undefined, { signal: abort.signal }).catch((error: unknown) => error);
    const question = await nextQuestion(r.ws);
    await r.ws.sync();
    expect((await history(r)).some((event) => event.kind === 'user_question_resolved')).toBe(false);
    abort.abort();
    await pending;
    await r.ws.waitFor(isEvent('user_question_resolved'));
    expect((await history(r)).filter((event) => event.kind === 'user_question_resolved')).toEqual([
      expect.objectContaining({ requestId: question.requestId, result: { status: 'cancelled', reason: 'disconnected' } }),
    ]);
    expect((await answer(r, question, 'apply')).statusCode).toBe(409);
  });

  it('cancels an abandoned real HTTP response while a phone WebSocket disconnect leaves the question replayable', async () => {
    const r = await rig();
    const abort = new AbortController();
    const pending = request(r, { ...INPUT, requestId: randomUUID() }, abort.signal).catch((error: unknown) => error);
    const question = await nextQuestion(r.ws);
    await r.ws.close();
    const replacement = await connect(r.daemon, r.baseUrl, r.session.id);
    expect(replacement.eventsOf(r.session.id)).toContainEqual(expect.objectContaining({ kind: 'user_question', requestId: question.requestId }));
    expect(replacement.eventsOf(r.session.id).some((event) => event.kind === 'user_question_resolved')).toBe(false);
    abort.abort();
    await pending;
    await replacement.waitFor(isEvent('user_question_resolved'));
    expect((await answer(r, question, 'review')).statusCode).toBe(409);
    expect((await history(r))).toContainEqual(expect.objectContaining({ kind: 'user_question_resolved', result: { status: 'cancelled', reason: 'disconnected' } }));
  });

  it('keeps questions independent of actual security permissions and cancels remaining questions at turn end', async () => {
    const r = await rig({ prompt: 'permission' });
    const permission = await r.ws.waitFor(isEvent('permission_request'));
    if (permission.type !== 'event' || permission.event.kind !== 'permission_request') throw new Error('expected permission request');
    const pending = request(r, { ...INPUT, requestId: randomUUID() });
    const question = await nextQuestion(r.ws);
    expect((await answer(r, { ...question, requestId: permission.event.requestId }, 'apply')).statusCode).toBe(409);
    r.ws.send({ type: 'permission_response', sessionId: r.session.id, requestId: permission.event.requestId, optionId: 'allow' });
    await r.ws.waitFor(isEvent('turn_end'));
    expect(await (await pending).json()).toEqual({ status: 'cancelled', reason: 'session_ended' });
    expect((await answer(r, question, 'apply')).statusCode).toBe(409);
    const events = await history(r);
    expect(events.findIndex((event) => event.kind === 'user_question_resolved')).toBeLessThan(events.findIndex((event) => event.kind === 'turn_end'));
  });

  it.each(['turn failure', 'agent death'] as const)('cancels questions before discarding live state on %s', async (failure) => {
    const r = await rig({ prompt: failure === 'turn failure' ? 'permission-fail' : 'slow' });
    const permission = failure === 'turn failure' ? await r.ws.waitFor(isEvent('permission_request')) : undefined;
    const pending = request(r, { ...INPUT, requestId: randomUUID() });
    const question = await nextQuestion(r.ws);
    if (permission?.type === 'event' && permission.event.kind === 'permission_request') {
      r.ws.send({ type: 'permission_response', sessionId: r.session.id, requestId: permission.event.requestId, optionId: 'allow' });
    } else {
      process.kill(Number(await readFile(join(pidDir, `${r.session.id}.pid`), 'utf8')));
    }
    expect(await (await pending).json()).toEqual({ status: 'cancelled', reason: 'session_ended' });
    await r.ws.waitFor(isEvent('error'));
    expect((await answer(r, question, 'apply')).statusCode).toBe(409);
    const events = await history(r);
    expect(events.findIndex((event) => event.kind === 'user_question_resolved')).toBeLessThan(events.findIndex((event) => event.kind === 'error'));
  });

  it('requires a real active turn and authenticates session tokens before disclosing liveness', async () => {
    const r = await rig({ prompt: '' });
    const payload = { ...INPUT, requestId: randomUUID() };
    const post = (headers: Record<string, string>, remoteAddress?: string) => r.daemon.app.inject({
      method: 'POST', url: '/api/agent/questions', payload, headers, ...(remoteAddress === undefined ? {} : { remoteAddress }),
    });
    expect((await post(r.agentHeaders)).statusCode).toBe(409);
    expect((await post(r.deviceHeaders)).statusCode).toBe(401);
    expect((await post({ ...r.agentHeaders, 'X-Nanachi-Session': randomUUID() })).statusCode).toBe(401);
    expect((await post({ ...r.agentHeaders, 'X-Nanachi-Agent-Token': 'wrong' })).statusCode).toBe(401);
    expect((await post(r.agentHeaders, '192.0.2.10')).statusCode).toBe(403);
    expect((await post({ ...r.agentHeaders, host: 'attacker.invalid' })).statusCode).toBe(403);
    for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login']) {
      expect((await post({ ...r.agentHeaders, [name]: name === 'x-forwarded-host' ? 'localhost' : 'proxy' })).statusCode).toBe(403);
    }
    await r.daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${r.session.id}`, headers: r.deviceHeaders });
    expect((await post(r.agentHeaders)).statusCode).toBe(401);
    expect((await history(r)).some((event) => event.kind === 'user_question')).toBe(false);
  });

  it('marks orphaned persisted requests cancelled at restart without reviving a waiter or accepting old answers', async () => {
    const r = await rig();
    const pending = request(r, { ...INPUT, requestId: randomUUID() });
    const graceful = await nextQuestion(r.ws);
    await r.daemon.app.close();
    expect(await (await pending).json()).toEqual({ status: 'cancelled', reason: 'session_ended' });
    // Model a crash after the event commit but before HTTP completion: there is deliberately no live registry.
    const orphanId = randomUUID();
    insertEvent(r.daemon.db, {
      sessionId: r.session.id, ts: Date.now(), kind: 'user_question',
      payload: JSON.stringify({ ...INPUT, requestId: orphanId, expiresAt: Date.now() + 300_000 }),
    });
    const restarted = await env.start();
    const headers = await authHeader(restarted);
    const eventsResponse = await restarted.app.inject({ method: 'GET', url: `/api/sessions/${r.session.id}/events`, headers });
    const events = EventsResponseSchema.parse(eventsResponse.json<unknown>()).events;
    expect(events.filter((event) => event.kind === 'user_question_resolved' && event.requestId === orphanId)).toEqual([
      expect.objectContaining({ result: { status: 'cancelled', reason: 'session_ended' } }),
    ]);
    for (const requestId of [orphanId, graceful.requestId]) {
      expect((await restarted.app.inject({ method: 'POST', url: `/api/sessions/${r.session.id}/questions/${requestId}/respond`, headers, payload: { optionId: 'apply' } })).statusCode).toBe(409);
    }
  });

  it('missing credentials and unreachable daemon return MCP non-answers without leaking transport details', async () => {
    const missing = await mcpClient({});
    const result = await missing.callTool({ name: 'ask_user', arguments: INPUT });
    expect(result).toMatchObject({ isError: true });
    expect(resultFromText(result)).toEqual({ status: 'cancelled', reason: 'disconnected' });
    const r = await rig();
    const client = await mcpClient({ ...r.credentials, NANACHI_URL: 'http://127.0.0.1:1', NANACHI_AGENT_TOKEN: 'private-token' });
    const unreachable = await client.callTool({ name: 'ask_user', arguments: INPUT });
    expect(unreachable).toMatchObject({ isError: true });
    expect(resultFromText(unreachable)).toEqual({ status: 'cancelled', reason: 'disconnected' });
    expect(JSON.stringify(unreachable)).not.toContain('private-token');
    expect(JSON.stringify(unreachable)).not.toContain('127.0.0.1');
  });
});
