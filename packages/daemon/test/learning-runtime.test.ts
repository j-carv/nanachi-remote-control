import { createServer, type Server, type ServerResponse } from 'node:http';
import { LearningSettingsSchema, MemoryEntriesResponseSchema, type SessionEvent } from '@nanachi/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { authHeader, createSession, createWorkspace, fakeAgent, isEvent, listen, pairToken, WsTestClient } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';

const env = setupDaemonTests();
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface ReviewData {
  sourceTurnSeq: number;
  evidence: Array<{ seq: number; kind: string; text: string }>;
}

async function provider(handle: (prompt: string, response: ServerResponse) => void): Promise<string> {
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string }> ; tools: unknown[]; tool_choice: string };
    expect(body.model).toBe('synthetic-reviewer');
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe('none');
    handle(body.messages.map((message) => message.content).join('\n'), response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing synthetic provider port');
  return `http://127.0.0.1:${address.port}/v1`;
}

function reply(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] }));
}

async function settings(daemon: TestDaemon, baseUrl: string, extra: Record<string, unknown> = {}): Promise<void> {
  const saved = await daemon.app.inject({
    method: 'PUT', url: '/api/learning/settings', headers: await authHeader(daemon),
    payload: { ...LearningSettingsSchema.parse({}), enabled: true, enabledAgents: ['fake'], intervalTurns: 1,
      reviewer: { source: 'openai', agentId: '', model: 'synthetic-reviewer', baseUrl }, ...extra },
  });
  expect(saved.statusCode).toBe(200);
}

async function source(baseUrl: string, extra: Record<string, unknown> = {}, notices?: string[]): Promise<{ daemon: TestDaemon; client: WsTestClient; sessionId: string; workspaceId: string }> {
  const daemon = await env.start({ config: { allowedRoots: [env.home], agents: { fake: fakeAgent() } },
    onNotify: (_id, kind) => { notices?.push(kind); },
  });
  await settings(daemon, baseUrl, extra);
  const workspaceId = await createWorkspace(daemon, env.home);
  const session = await createSession(daemon, { workspaceId, agent: 'fake' });
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.sync();
  return { daemon, client, sessionId: session.id, workspaceId };
}

function learningEvents(events: SessionEvent[]): Array<Extract<SessionEvent, { kind: 'learning' }>> {
  return events.filter((event): event is Extract<SessionEvent, { kind: 'learning' }> => event.kind === 'learning');
}

describe('automatic isolated learning', () => {
  it('reviews a successful real turn through HTTP, redacts evidence, saves memory, and emits only a quiet learning notice', async () => {
    let calls = 0;
    let observed = '';
    const baseUrl = await provider((prompt, response) => {
      calls += 1;
      observed = prompt;
      const data = JSON.parse(prompt.split('DATA:\n')[1] ?? '') as ReviewData;
      const evidence = data.evidence.find((entry) => entry.kind === 'user_message');
      if (evidence === undefined) throw new Error('missing authentic source evidence');
      reply(response, { summary: 'Saved project test convention', entries: [{ kind: 'memory', title: 'Project tests', content: 'Use npm for project tests.', evidenceSeqs: [evidence.seq] }] });
    });
    const notices: string[] = [];
    const { daemon, client, sessionId, workspaceId } = await source(baseUrl, {}, notices);
    try {
      const text = 'Use npm for tests. api_key=sk-synthetic12345678901234567890';
      client.send({ type: 'prompt', sessionId, text });
      await client.waitFor(isEvent('learning'));
      const events = client.eventsOf(sessionId);
      expect(events.filter((event) => event.kind === 'user_message')).toMatchObject([{ text }]);
      expect(events.filter((event) => event.kind === 'agent_message_chunk')).toMatchObject([{ text: 'Eco: ' }, { text }]);
      expect(events.filter((event) => event.kind === 'turn_end')).toHaveLength(1);
      const reviewStart = events.findIndex((event) => event.kind === 'turn_end');
      expect(events.slice(reviewStart + 1).filter((event) => event.kind === 'tool_call' || event.kind === 'tool_call_update')).toEqual([]);
      expect(learningEvents(events)).toMatchObject([{ status: 'applied', memoryCount: 1, skillCount: 0 }]);
      expect(events.findIndex((event) => event.kind === 'learning')).toBeGreaterThan(events.findIndex((event) => event.kind === 'turn_end'));
      expect(observed).not.toContain('sk-synthetic');
      expect(observed).toContain('[REDACTED]');
      expect(calls).toBe(1);
      expect(notices).not.toContain('learning');
      expect(daemon.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(1);
      const memories = await daemon.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/memories`, headers: await authHeader(daemon) });
      expect(MemoryEntriesResponseSchema.parse(memories.json<unknown>()).entries).toMatchObject([{ title: 'Project tests', status: 'active' }]);
    } finally { await client.close(); }
  });

  it('cadence counts completed real turns, not learning notices, and creates pending proposals only when requested', async () => {
    let calls = 0;
    const baseUrl = await provider((prompt, response) => {
      calls += 1;
      const data = JSON.parse(prompt.split('DATA:\n')[1] ?? '') as ReviewData;
      const evidence = data.evidence.find((entry) => entry.kind === 'user_message');
      reply(response, { summary: 'Proposed test workflow', entries: [{ kind: 'skill', title: 'Test workflow', content: 'Run the focused npm test command after changes.', evidenceSeqs: [evidence?.seq] }] });
    });
    const { daemon, client, sessionId, workspaceId } = await source(baseUrl, { intervalTurns: 2, approvalRequired: true });
    try {
      client.send({ type: 'prompt', sessionId, text: 'Use focused npm tests' });
      await client.waitFor(isEvent('turn_end'));
      expect(calls).toBe(0);
      client.send({ type: 'prompt', sessionId, text: 'That test workflow succeeded' });
      await client.waitFor(isEvent('learning'));
      expect(calls).toBe(1);
      expect(learningEvents(client.eventsOf(sessionId))).toMatchObject([{ status: 'pending', skillCount: 1 }]);
      const memories = await daemon.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/memories`, headers: await authHeader(daemon) });
      expect(MemoryEntriesResponseSchema.parse(memories.json<unknown>()).entries).toMatchObject([{ status: 'pending' }]);
    } finally { await client.close(); }
  });

  it('keeps no-change reviews silent and never treats a learning notice as new review evidence', async () => {
    let calls = 0;
    const baseUrl = await provider((prompt, response) => {
      calls += 1;
      const data = JSON.parse(prompt.split('DATA:\n')[1] ?? '') as ReviewData;
      expect(data.evidence.some((entry) => entry.kind === 'learning')).toBe(false);
      if (calls === 1) { reply(response, { summary: '', entries: [] }); return; }
      const evidence = data.evidence.find((entry) => entry.kind === 'user_message' && entry.text.includes('confirmed'));
      reply(response, { summary: 'Recorded confirmed convention', entries: [{ kind: 'memory', title: 'Confirmed convention', content: 'Use npm for tests.', evidenceSeqs: [evidence?.seq] }] });
    });
    const { client, sessionId } = await source(baseUrl);
    try {
      client.send({ type: 'prompt', sessionId, text: 'Test workflow discussion' });
      await client.waitFor(isEvent('turn_end'));
      client.send({ type: 'prompt', sessionId, text: 'The npm test convention is confirmed' });
      await client.waitFor(isEvent('learning'));
      const events = client.eventsOf(sessionId);
      expect(calls).toBe(2);
      expect(learningEvents(events)).toHaveLength(1);
      expect(learningEvents(events)[0]?.sourceTurnSeq).toBe(events.filter((event) => event.kind === 'turn_end').at(-1)?.seq);
    } finally { await client.close(); }
  });

  it.each(['schema', 'credentials', 'evidence'] as const)('rejects %s-invalid reviewer proposals without memory writes', async (invalid) => {
    const baseUrl = await provider((prompt, response) => {
      const data = JSON.parse(prompt.split('DATA:\n')[1] ?? '') as ReviewData;
      const evidence = data.evidence.find((entry) => entry.kind === 'user_message');
      reply(response, invalid === 'schema' ? { entries: 'invalid' } : {
        summary: invalid === 'credentials' ? 'api_key=sk-synthetic12345678901234567890' : 'Invalid evidence',
        entries: [{ kind: 'memory', title: 'Unsafe proposal', content: 'Do not save this.', evidenceSeqs: [invalid === 'evidence' ? data.sourceTurnSeq + 1000 : evidence?.seq] }],
      });
    });
    const { daemon, client, sessionId, workspaceId } = await source(baseUrl);
    try {
      client.send({ type: 'prompt', sessionId, text: 'Use synthetic project evidence only' });
      await client.waitFor(isEvent('learning'));
      expect(learningEvents(client.eventsOf(sessionId))).toMatchObject([{ status: 'failed', entryIds: [] }]);
      const memories = await daemon.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/memories`, headers: await authHeader(daemon) });
      expect(MemoryEntriesResponseSchema.parse(memories.json<unknown>()).entries).toEqual([]);
    } finally { await client.close(); }
  });

  it('disabling learning aborts an in-flight HTTP review and prevents late writes or failure notices', async () => {
    let pending: ServerResponse | undefined;
    let started!: () => void;
    let aborted!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const disconnected = new Promise<void>((resolve) => { aborted = resolve; });
    const baseUrl = await provider((_prompt, response) => { pending = response; response.once('close', aborted); started(); });
    const { daemon, client, sessionId, workspaceId } = await source(baseUrl);
    try {
      client.send({ type: 'prompt', sessionId, text: 'Verified test preference' });
      await began;
      await settings(daemon, baseUrl, { enabled: false });
      await disconnected;
      if (pending !== undefined && !pending.destroyed) reply(pending, { summary: '', entries: [] });
      await client.sync();
      expect(learningEvents(client.eventsOf(sessionId))).toEqual([]);
      const memories = await daemon.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/memories`, headers: await authHeader(daemon) });
      expect(MemoryEntriesResponseSchema.parse(memories.json<unknown>()).entries).toEqual([]);
    } finally { await client.close(); }
  });

  it.each(['stop', 'workspace', 'shutdown'] as const)('%s cancels private reviews before source teardown', async (action) => {
    let started!: () => void;
    let aborted!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const disconnected = new Promise<void>((resolve) => { aborted = resolve; });
    const baseUrl = await provider((_prompt, response) => { response.once('close', aborted); started(); });
    const { daemon, client, sessionId, workspaceId } = await source(baseUrl);
    try {
      client.send({ type: 'prompt', sessionId, text: 'Verified project workflow' });
      await began;
      if (action === 'shutdown') {
        await client.close();
        await daemon.app.close();
      } else {
        const result = await daemon.app.inject({
          method: 'DELETE',
          url: action === 'stop' ? `/api/sessions/${sessionId}` : `/api/workspaces/${workspaceId}`,
          headers: await authHeader(daemon),
        });
        expect(result.statusCode).toBe(204);
      }
      await disconnected;
      expect(daemon.db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND kind = 'learning'").get(sessionId)?.count).toBe(0);
    } finally { await client.close(); }
  });

  it('same-model unsupported adapters fail quietly without adding source messages or hidden sessions', async () => {
    const { daemon, client, sessionId } = await source('https://example.invalid/v1');
    await settings(daemon, 'https://example.invalid/v1', { reviewer: { source: 'same', agentId: '', model: '', baseUrl: '' } });
    try {
      client.send({ type: 'prompt', sessionId, text: 'A normal user turn' });
      await client.waitFor(isEvent('learning'));
      const events = client.eventsOf(sessionId);
      expect(learningEvents(events)).toMatchObject([{ status: 'failed' }]);
      expect(events.filter((event) => event.kind === 'user_message')).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'agent_message_chunk')).toHaveLength(2);
      const reviewStart = events.findIndex((event) => event.kind === 'turn_end');
      expect(events.slice(reviewStart + 1).filter((event) => event.kind === 'tool_call' || event.kind === 'tool_call_update')).toEqual([]);
      expect(daemon.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(1);
    } finally { await client.close(); }
  });

  it('refuses unsupported configured agent reviewers before enabling model usage', async () => {
    const daemon = await env.start({ config: { agents: { fake: fakeAgent() } } });
    const saved = await daemon.app.inject({
      method: 'PUT', url: '/api/learning/settings', headers: await authHeader(daemon),
      payload: { ...LearningSettingsSchema.parse({}), enabled: true, enabledAgents: ['fake'], reviewer: { source: 'agent', agentId: 'fake', model: 'fast', baseUrl: '' } },
    });
    expect(saved.statusCode).toBe(400);
    expect(saved.json<unknown>()).toMatchObject({ error: 'reviewer_unsupported' });
  });
});
