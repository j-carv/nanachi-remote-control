import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  EventsResponseSchema, FileInfoSchema, RequestFileAgentResultSchema, RequestFileResultSchema, PreviewInfoSchema, PreviewOpenResponseSchema, previewLocalPort,
  type FileInfo, type Session, type SessionEvent,
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

type FileRequest = Extract<SessionEvent, { kind: 'file_request' }>;
const INPUT = { prompt: 'Choose the source document', accept: ['.pdf', 'image/*'] };
let base: string;
let workspace: string;
let pidDir: string;
beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-request-file-')));
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
  releasePreviewPort: (() => Promise<void>) | undefined;
}
async function connect(daemon: TestDaemon, baseUrl: string, sessionId: string): Promise<WsTestClient> {
  const ws = await WsTestClient.connect(baseUrl, await pairToken(daemon));
  cleanup.push(() => ws.close());
  ws.send({ type: 'subscribe', sessionId, afterSeq: 0 });
  await ws.waitFor(isEvent('status'));
  await ws.sync();
  return ws;
}
/** Keep the gateway out of the OS ephemeral-client pool until the real gateway can bind it. */
async function reservePreviewPorts(): Promise<{ port: number; release(): Promise<void> }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const main = createServer();
    await new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve));
    const address = main.address();
    if (address === null || typeof address === 'string') throw new Error('missing reserved daemon port');
    const gateway = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        gateway.once('error', reject);
        gateway.listen(previewLocalPort(address.port), '127.0.0.1', resolve);
      });
    } catch {
      await new Promise<void>((resolve) => main.close(() => resolve()));
      continue;
    }
    await new Promise<void>((resolve) => main.close(() => resolve()));
    return { port: address.port, release: () => new Promise<void>((resolve) => gateway.close(() => resolve())) };
  }
  throw new Error('cannot reserve adjacent preview ports');
}

async function rig(options: { timeoutMs?: number; prompt?: string; enabled?: boolean; reservePreview?: boolean } = {}): Promise<Rig> {
  const daemon = await env.start({
    requestFileTimeoutMs: options.timeoutMs,
    config: { allowedRoots: [base], agents: { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }) } },
  });
  const ports = options.reservePreview ? await reservePreviewPorts() : undefined;
  if (ports !== undefined) cleanup.push(ports.release);
  const baseUrl = ports === undefined ? await listen(daemon) : await daemon.app.listen({ host: '127.0.0.1', port: ports.port });
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
    releasePreviewPort: ports?.release,
    agentHeaders: {
      'Content-Type': 'application/json', 'X-Nanachi-Session': session.id,
      'X-Nanachi-Agent-Token': credentials.NANACHI_AGENT_TOKEN ?? '',
    },
  };
}
async function mcpClient(credentials: NodeJS.ProcessEnv): Promise<Client> {
  const server = createNanachiMcpServer(credentials);
  const client = new Client({ name: 'request-file-test', version: '1.0.0' });
  cleanup.push(() => server.close(), () => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
async function nextRequest(ws: WsTestClient): Promise<FileRequest> {
  const message = await ws.waitFor(isEvent('file_request'));
  if (message.type !== 'event' || message.event.kind !== 'file_request') throw new Error('expected file request');
  return message.event;
}
function request(r: Rig, requestId: string = randomUUID(), signal?: AbortSignal): Promise<Response> {
  return fetch(`${r.baseUrl}/api/agent/file-requests`, {
    method: 'POST', headers: r.agentHeaders, body: JSON.stringify({ ...INPUT, requestId }),
    ...(signal === undefined ? {} : { signal }),
  });
}
function answer(r: Rig, pending: FileRequest, fileId: string | null, sessionId = r.session.id) {
  return r.daemon.app.inject({
    method: 'POST', url: `/api/sessions/${sessionId}/file-requests/${pending.requestId}/respond`,
    headers: r.deviceHeaders, payload: { fileId },
  });
}
async function upload(r: Rig, name = 'source.PDF', mime = 'application/pdf', sessionId = r.session.id): Promise<FileInfo> {
  const response = await r.daemon.app.inject({
    method: 'POST', url: `/api/sessions/${sessionId}/attachments`,
    headers: { ...r.deviceHeaders, 'content-type': mime, 'x-file-name': encodeURIComponent(name) },
    payload: Buffer.from('synthetic attachment'),
  });
  expect(response.statusCode).toBe(201);
  return FileInfoSchema.parse(response.json<unknown>());
}
async function history(r: Rig): Promise<SessionEvent[]> {
  const response = await r.daemon.app.inject({ method: 'GET', url: `/api/sessions/${r.session.id}/events`, headers: r.deviceHeaders });
  return EventsResponseSchema.parse(response.json<unknown>()).events;
}

describe('request_file MCP and attachment responses', () => {
  it('waits for explicit selection, returns a real stored path only to MCP and does not create a user prompt', async () => {
    const r = await rig();
    const existing = await upload(r);
    const client = await mcpClient(r.credentials);
    r.ws.send({ type: 'set_yolo', sessionId: r.session.id, enabled: true });
    await r.ws.waitFor((message) => message.type === 'yolo' && message.sessionId === r.session.id && message.enabled);
    const pending = client.callTool({ name: 'request_file', arguments: INPUT });
    let settled = false;
    void pending.then(() => { settled = true; });
    const card = await nextRequest(r.ws);
    expect(card).toMatchObject(INPUT);
    const selected = await upload(r);
    await r.ws.sync();
    expect(settled).toBe(false);
    expect(existing.fileId).not.toBe(selected.fileId);
    const device = await answer(r, card, selected.fileId);
    expect(device.statusCode).toBe(200);
    expect(device.json()).toEqual({ status: 'received', file: selected });
    const mcp = await pending;
    expect(mcp.isError).toBe(false);
    const result = RequestFileAgentResultSchema.parse(mcp.structuredContent);
    expect(result.status).toBe('received');
    if (result.status !== 'received') throw new Error('expected selected file');
    expect(isAbsolute(result.path)).toBe(true);
    expect(await readFile(result.path, 'utf8')).toBe('synthetic attachment');
    const events = await history(r);
    expect(events.filter((event) => event.kind === 'user_message')).toHaveLength(1);
    expect(events.some((event) => event.kind === 'turn_end')).toBe(false);
    expect(events.filter((event) => event.kind === 'file_request_resolved')).toEqual([
      expect.objectContaining({ requestId: card.requestId, result: { status: 'received', file: selected } }),
    ]);
    expect(JSON.stringify(events)).not.toContain(result.path);
    expect(device.body).not.toContain(result.path);
    expect((await answer(r, card, existing.fileId)).statusCode).toBe(409);
  });

  it('runs through the actual opted-in ACP stdio descriptor and continues the same turn', async () => {
    const r = await rig({ enabled: true, prompt: '' });
    r.ws.send({ type: 'prompt', sessionId: r.session.id, text: `/nanachi-request-file ${JSON.stringify(INPUT)}` });
    const card = await nextRequest(r.ws);
    const file = await upload(r);
    expect((await answer(r, card, file.fileId)).statusCode).toBe(200);
    await r.ws.waitFor(isEvent('turn_end'));
    const text = r.ws.eventsOf(r.session.id).flatMap((event) => event.kind === 'agent_message_chunk' ? [event.text] : []).join('');
    const response = JSON.parse(text) as { structuredContent?: unknown; fileAvailable?: boolean };
    expect(RequestFileResultSchema.parse(response.structuredContent)).toEqual({ status: 'received', file });
    expect(response.fileAvailable).toBe(true);
    expect(text).not.toContain(join(r.daemon.home, 'files'));
    r.ws.send({ type: 'prompt', sessionId: r.session.id, text: '/eco continued' });
    await r.ws.waitFor(isEvent('turn_end'));
    expect(r.ws.eventsOf(r.session.id)).toContainEqual(expect.objectContaining({ kind: 'agent_message_chunk', text: 'continued' }));
    expect(await readFile(join(pidDir, `${r.session.id}.mcp.jsonl`), 'utf8')).not.toContain(r.credentials.NANACHI_AGENT_TOKEN ?? '<missing>');
  });

  it('rejects another session, agent uploads, invalid types and forged responses without settling', async () => {
    const r = await rig();
    const other = await createSession(r.daemon, { workspaceId: r.session.workspaceId, agent: 'fake' });
    const pending = request(r);
    const card = await nextRequest(r.ws);
    const wrongSession = await upload(r, 'elsewhere.pdf', 'application/pdf', other.id);
    const wrongType = await upload(r, 'notes.txt', 'text/plain');
    const sent = await r.daemon.app.inject({
      method: 'POST', url: '/api/agent/files',
      headers: { ...r.agentHeaders, 'content-type': 'image/png', 'x-file-name': 'agent.png' },
      payload: Buffer.from('synthetic agent output'),
    });
    const wrongDirection = FileInfoSchema.parse(sent.json<unknown>());
    for (const fileId of [wrongSession.fileId, wrongDirection.fileId, randomUUID()]) {
      expect((await answer(r, card, fileId)).statusCode).toBe(400);
    }
    expect((await answer(r, card, wrongType.fileId)).json()).toEqual({ error: 'file_type_not_accepted' });
    expect((await answer(r, card, wrongType.fileId, other.id)).statusCode).toBe(409);
    expect((await answer(r, card, null, randomUUID())).statusCode).toBe(404);
    expect((await r.daemon.app.inject({
      method: 'POST', url: `/api/sessions/${r.session.id}/file-requests/${card.requestId}/respond`,
      headers: r.deviceHeaders, payload: { fileId: wrongType.fileId, path: 'C:\\forged.pdf' },
    })).statusCode).toBe(400);
    expect((await r.daemon.app.inject({
      method: 'POST', url: `/api/sessions/${r.session.id}/file-requests/${card.requestId}/respond`, payload: { fileId: null },
    })).statusCode).toBe(401);
    expect((await history(r)).some((event) => event.kind === 'file_request_resolved')).toBe(false);
    const valid = await upload(r, 'no-extension', 'IMAGE/PNG; charset=binary');
    expect((await answer(r, card, valid.fileId)).statusCode).toBe(200);
    expect(RequestFileAgentResultSchema.parse(await (await pending).json())).toMatchObject({ status: 'received', file: valid });
  });

  it('does not release a waiter when the resolution commit fails, and allows an explicit retry', async () => {
    const r = await rig();
    const pending = request(r);
    let settled = false;
    void pending.then(() => { settled = true; });
    const card = await nextRequest(r.ws);
    const file = await upload(r);
    r.daemon.db.exec("CREATE TRIGGER reject_file_resolution BEFORE INSERT ON events WHEN NEW.kind = 'file_request_resolved' BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END");
    try {
      expect((await answer(r, card, file.fileId)).statusCode).toBe(500);
      await r.ws.sync();
      expect(settled).toBe(false);
      expect((await history(r)).filter((event) => event.kind === 'file_request_resolved')).toEqual([]);
    } finally {
      r.daemon.db.exec('DROP TRIGGER reject_file_resolution');
    }
    expect((await answer(r, card, file.fileId)).statusCode).toBe(200);
    expect(RequestFileAgentResultSchema.parse(await (await pending).json())).toMatchObject({ status: 'received', file });
    expect((await history(r)).filter((event) => event.kind === 'file_request_resolved')).toHaveLength(1);
  });

  it('refuses missing stored bytes instead of returning a fictitious path', async () => {
    const r = await rig();
    const pending = request(r);
    const card = await nextRequest(r.ws);
    const file = await upload(r);
    await rm(join(r.daemon.home, 'files', r.session.id, `${file.fileId}-${file.name}`));
    expect((await answer(r, card, file.fileId)).statusCode).toBe(410);
    expect((await answer(r, card, null)).statusCode).toBe(200);
    expect(await (await pending).json()).toEqual({ status: 'cancelled', reason: 'user_cancelled' });
  });

  it('bounds pending requests and prevents identity reuse or competing cancel/file delivery', async () => {
    const r = await rig();
    const responses: Array<Promise<Response>> = [];
    const cards: FileRequest[] = [];
    for (let index = 0; index < 8; index += 1) {
      responses.push(request(r));
      cards.push(await nextRequest(r.ws));
    }
    expect((await request(r)).status).toBe(429);
    const first = cards[0];
    if (first === undefined) throw new Error('missing request');
    const file = await upload(r);
    expect((await answer(r, first, null)).statusCode).toBe(200);
    expect((await answer(r, first, file.fileId)).statusCode).toBe(409);
    for (const card of cards.slice(1)) expect((await answer(r, card, null)).statusCode).toBe(200);
    for (const response of await Promise.all(responses)) {
      expect(await response.json()).toEqual({ status: 'cancelled', reason: 'user_cancelled' });
    }
    expect((await request(r, first.requestId)).status).toBe(409);
    const competing = request(r);
    const card = await nextRequest(r.ws);
    const replies = await Promise.all([answer(r, card, null), answer(r, card, file.fileId)]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
    const winner: unknown = replies.find((reply) => reply.statusCode === 200)?.json();
    const agentResult = RequestFileAgentResultSchema.parse(await (await competing).json());
    expect(agentResult.status === 'received' ? { status: agentResult.status, file: agentResult.file } : agentResult).toEqual(winner);
  });

  it.each(['user', 'turn cancellation', 'process stop', 'expiry', 'shutdown'] as const)(
    'settles %s as a non-file result and rejects stale delivery', async (reason) => {
      const r = await rig({ ...(reason === 'expiry' ? { timeoutMs: 80 } : {}) });
      const client = await mcpClient(r.credentials);
      const pending = client.callTool({ name: 'request_file', arguments: INPUT });
      const card = await nextRequest(r.ws);
      if (reason === 'user') await answer(r, card, null);
      if (reason === 'turn cancellation') r.ws.send({ type: 'cancel', sessionId: r.session.id });
      if (reason === 'process stop') await r.daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${r.session.id}`, headers: r.deviceHeaders });
      if (reason === 'shutdown') await r.daemon.app.close();
      const expected = { status: 'cancelled', reason: reason === 'user' ? 'user_cancelled' : reason === 'expiry' ? 'expired' : 'session_ended' };
      const response = await pending;
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toEqual(expected);
      if (reason !== 'shutdown') {
        const file = await upload(r);
        expect((await answer(r, card, file.fileId)).statusCode).toBe(409);
        expect((await history(r)).filter((event) => event.kind === 'file_request_resolved')).toEqual([
          expect.objectContaining({ requestId: card.requestId, result: expected }),
        ]);
      }
    },
  );

  it('preserves cards across phone reconnect but cancels when its MCP response disconnects', async () => {
    const r = await rig();
    const client = await mcpClient(r.credentials);
    const abort = new AbortController();
    const pending = client.callTool({ name: 'request_file', arguments: INPUT }, undefined, { signal: abort.signal }).catch((error: unknown) => error);
    const card = await nextRequest(r.ws);
    await r.ws.close();
    const replacement = await connect(r.daemon, r.baseUrl, r.session.id);
    expect(replacement.eventsOf(r.session.id)).toContainEqual(expect.objectContaining({ kind: 'file_request', requestId: card.requestId }));
    expect((await history(r)).some((event) => event.kind === 'file_request_resolved')).toBe(false);
    abort.abort();
    await pending;
    await replacement.waitFor(isEvent('file_request_resolved'));
    expect((await answer(r, card, null)).statusCode).toBe(409);
    expect((await history(r))).toContainEqual(expect.objectContaining({
      kind: 'file_request_resolved', result: { status: 'cancelled', reason: 'disconnected' },
    }));
  });

  it.each(['turn end', 'turn failure', 'agent death'] as const)('cancels requests before %s events', async (reason) => {
    const r = await rig({ prompt: reason === 'agent death' ? 'slow' : reason === 'turn failure' ? 'permission-fail' : 'permission' });
    const permission = reason === 'agent death' ? undefined : await r.ws.waitFor(isEvent('permission_request'));
    const pending = request(r);
    const card = await nextRequest(r.ws);
    if (permission?.type === 'event' && permission.event.kind === 'permission_request') {
      expect((await answer(r, { ...card, requestId: permission.event.requestId }, null)).statusCode).toBe(409);
      r.ws.send({ type: 'permission_response', sessionId: r.session.id, requestId: permission.event.requestId, optionId: 'allow' });
    } else {
      process.kill(Number(await readFile(join(pidDir, `${r.session.id}.pid`), 'utf8')));
    }
    expect(await (await pending).json()).toEqual({ status: 'cancelled', reason: 'session_ended' });
    await r.ws.waitFor(isEvent(reason === 'turn end' ? 'turn_end' : 'error'));
    expect((await answer(r, card, null)).statusCode).toBe(409);
    const events = await history(r);
    expect(events.findIndex((event) => event.kind === 'file_request_resolved')).toBeLessThan(
      events.findIndex((event) => event.kind === (reason === 'turn end' ? 'turn_end' : 'error')),
    );
  });

  it('authenticates local session tokens before disclosing liveness and requires an active turn', async () => {
    const r = await rig({ prompt: '' });
    const post = (headers: Record<string, string>, remoteAddress?: string) => r.daemon.app.inject({
      method: 'POST', url: '/api/agent/file-requests', payload: { ...INPUT, requestId: randomUUID() }, headers,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
    });
    expect((await post(r.agentHeaders)).statusCode).toBe(409);
    expect((await post(r.deviceHeaders)).statusCode).toBe(401);
    expect((await post({ ...r.agentHeaders, 'X-Nanachi-Session': randomUUID() })).statusCode).toBe(401);
    expect((await post({ ...r.agentHeaders, 'X-Nanachi-Agent-Token': 'wrong' })).statusCode).toBe(401);
    expect((await post(r.agentHeaders, '192.0.2.10')).statusCode).toBe(403);
    expect((await post({ ...r.agentHeaders, host: 'attacker.invalid' })).statusCode).toBe(403);
    for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'tailscale-user-login', 'tailscale-user-name']) {
      expect((await post({ ...r.agentHeaders, [name]: name === 'x-forwarded-host' ? 'localhost' : 'proxy' })).statusCode).toBe(403);
    }
    await r.daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${r.session.id}`, headers: r.deviceHeaders });
    expect((await post(r.agentHeaders)).statusCode).toBe(401);
    expect((await history(r)).some((event) => event.kind === 'file_request')).toBe(false);
  });

  it.each([
    {}, { prompt: ' ' }, { ...INPUT, accept: [] }, { ...INPUT, accept: ['*/*'] },
    { ...INPUT, accept: ['image/png; token=secret'] }, { ...INPUT, accept: ['../secret'] },
    { ...INPUT, requestId: randomUUID() }, { ...INPUT, sessionId: 'another' },
    { ...INPUT, path: 'C:\\secret.txt' }, { ...INPUT, token: 'model-token' },
  ])('rejects invalid or authority-bearing MCP arguments without creating a card: %j', async (input) => {
    const r = await rig();
    const client = await mcpClient(r.credentials);
    expect(await client.callTool({ name: 'request_file', arguments: input })).toMatchObject({ isError: true });
    expect((await history(r)).filter((event) => event.kind === 'file_request')).toEqual([]);
  });

  it('settles crash-orphaned requests at restart without reviving waiters or accepting stale responses', async () => {
    const r = await rig();
    const pending = request(r);
    const card = await nextRequest(r.ws);
    await r.daemon.app.close();
    expect(await (await pending).json()).toEqual({ status: 'cancelled', reason: 'session_ended' });
    const requestId = randomUUID();
    insertEvent(r.daemon.db, {
      sessionId: r.session.id, ts: Date.now(), kind: 'file_request',
      payload: JSON.stringify({ ...INPUT, requestId, expiresAt: Date.now() + 300_000 }),
    });
    const restarted = await env.start();
    const headers = await authHeader(restarted);
    const response = await restarted.app.inject({ method: 'GET', url: `/api/sessions/${r.session.id}/events`, headers });
    const events = EventsResponseSchema.parse(response.json<unknown>()).events;
    expect(events.filter((event) => event.kind === 'file_request_resolved' && event.requestId === requestId)).toEqual([
      expect.objectContaining({ result: { status: 'cancelled', reason: 'session_ended' } }),
    ]);
    for (const id of [requestId, card.requestId]) {
      expect((await restarted.app.inject({
        method: 'POST', url: `/api/sessions/${r.session.id}/file-requests/${id}/respond`, headers, payload: { fileId: null },
      })).statusCode).toBe(409);
    }
  });

  it('never leaks transport details on missing credentials or unreachable daemon errors', async () => {
    for (const credentials of [{}, { AGENT_SESSION_ID: 'synthetic', NANACHI_URL: 'http://127.0.0.1:1', NANACHI_AGENT_TOKEN: 'private-token' }]) {
      const client = await mcpClient(credentials);
      const result = await client.callTool({ name: 'request_file', arguments: INPUT });
      expect(result).toMatchObject({ isError: true, structuredContent: { status: 'cancelled', reason: 'disconnected' } });
      expect(JSON.stringify(result)).not.toContain('private-token');
      expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    }
  });
});

describe('open_preview through the optional Nanachi MCP', () => {
  it('creates a real preview card without opening automatically, survives idle and closes explicitly', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('synthetic local application');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => {
      upstream.close((error) => error === undefined ? resolve() : reject(error));
    }));
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('expected local HTTP port');
    const r = await rig({ enabled: true, prompt: '', reservePreview: true });
    r.ws.send({
      type: 'prompt', sessionId: r.session.id,
      text: `/nanachi-preview ${JSON.stringify({ port: address.port, title: 'Synthetic application', path: '/demo?mode=test' })}`,
    });
    const message = await r.ws.waitFor(isEvent('preview'));
    if (message.type !== 'event' || message.event.kind !== 'preview') throw new Error('expected preview card');
    const card = message.event;
    await r.ws.waitFor(isEvent('turn_end'));
    const text = r.ws.eventsOf(r.session.id).flatMap((event) => event.kind === 'agent_message_chunk' ? [event.text] : []).join('');
    const result = JSON.parse(text) as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError).toBe(false);
    expect(PreviewInfoSchema.parse(result.structuredContent)).toMatchObject({
      previewId: card.previewId, port: address.port, path: '/demo?mode=test', title: 'Synthetic application',
    });
    expect((await history(r)).some((event) => event.kind === 'preview_closed')).toBe(false);
    await r.releasePreviewPort?.();
    const opened = await r.daemon.app.inject({
      method: 'POST', url: `/api/sessions/${r.session.id}/previews/${card.previewId}/open`,
      headers: r.deviceHeaders, payload: {},
    });
    expect(opened.statusCode).toBe(200);
    const launch = PreviewOpenResponseSchema.parse(opened.json<unknown>());
    expect(launch.url).not.toContain(r.deviceHeaders.authorization);
    expect(launch.url).not.toContain(r.credentials.NANACHI_AGENT_TOKEN ?? '<missing>');
    const closed = await r.daemon.app.inject({
      method: 'DELETE', url: `/api/sessions/${r.session.id}/previews/${card.previewId}`, headers: r.deviceHeaders,
    });
    expect(closed.statusCode).toBe(200);
    await r.ws.waitFor(isEvent('preview_closed'));
    expect((await history(r))).toContainEqual(expect.objectContaining({
      kind: 'preview_closed', previewId: card.previewId, reason: 'closed',
    }));
    expect((await r.daemon.app.inject({
      method: 'POST', url: `/api/sessions/${r.session.id}/previews/${card.previewId}/open`,
      headers: r.deviceHeaders, payload: {},
    })).statusCode).toBe(409);
  });

  it('rejects arbitrary targets and authority-bearing inputs without emitting preview cards', async () => {
    const r = await rig();
    const client = await mcpClient(r.credentials);
    for (const input of [
      { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: 3000, host: 'example.invalid' },
      { port: 3000, path: '//example.invalid/app' }, { port: 3000, path: 'https://example.invalid' },
      { port: 3000, path: '/\\example.invalid' }, { port: 3000, path: '/app#token' },
      { port: 3000, sessionId: 'another' }, { port: 3000, token: 'model-token' },
    ]) {
      expect(await client.callTool({ name: 'open_preview', arguments: input })).toMatchObject({ isError: true });
    }
    expect((await history(r)).filter((event) => event.kind === 'preview')).toEqual([]);
  });

  it('returns a retryable MCP error for a stopped local server rather than fictitious preview content', async () => {
    const upstream = createServer();
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('expected local HTTP port');
    await new Promise<void>((resolve, reject) => upstream.close((error) => error === undefined ? resolve() : reject(error)));
    const r = await rig();
    const client = await mcpClient(r.credentials);
    const result = await client.callTool({ name: 'open_preview', arguments: { port: address.port } });
    expect(result).toMatchObject({ isError: true });
    expect((await history(r)).filter((event) => event.kind === 'preview')).toEqual([]);
  });

  it('closes disconnected agent preview probes promptly and releases the entire session quota', async () => {
    let ready = false;
    const upstream = createServer((_request, response) => { if (ready) response.end(); });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('expected local HTTP port');
    const r = await rig();
    const controllers: AbortController[] = [];
    const responses: Array<Promise<unknown>> = [];
    const closed: Array<Promise<void>> = [];
    for (let index = 0; index < 4; index += 1) {
      const incoming = new Promise<Socket>((resolve) => upstream.once('request', (request) => resolve(request.socket)));
      const controller = new AbortController();
      controllers.push(controller);
      responses.push(fetch(`${r.baseUrl}/api/agent/previews`, {
        method: 'POST', headers: r.agentHeaders, body: JSON.stringify({ port: address.port }), signal: controller.signal,
      }).catch((error: unknown) => error));
      const socket = await incoming;
      closed.push(new Promise<void>((resolve) => socket.once('close', () => resolve())));
    }
    expect((await fetch(`${r.baseUrl}/api/agent/previews`, {
      method: 'POST', headers: r.agentHeaders, body: JSON.stringify({ port: address.port }),
    })).status).toBe(429);
    // Measure actual socket closure: fake time cannot exercise a remote HTTP client disconnect.
    const canceledAt = performance.now();
    for (const controller of controllers) controller.abort();
    await Promise.all(responses);
    await Promise.all(closed);
    expect(performance.now() - canceledAt).toBeLessThan(2_000);
    expect((await history(r)).filter((event) => event.kind === 'preview')).toEqual([]);
    ready = true;
    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${r.baseUrl}/api/agent/previews`, {
        method: 'POST', headers: r.agentHeaders, body: JSON.stringify({ port: address.port }),
      });
      expect(response.status).toBe(201);
      expect(PreviewInfoSchema.parse(await response.json())).toMatchObject({ port: address.port });
    }
    expect((await history(r)).filter((event) => event.kind === 'preview')).toHaveLength(4);
  });

  it('cancels a device open probe when its HTTP response disconnects without revoking the preview', async () => {
    let ready = true;
    const upstream = createServer((_request, response) => { if (ready) response.end(); });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('expected local HTTP port');
    const r = await rig({ reservePreview: true });
    const created = await fetch(`${r.baseUrl}/api/agent/previews`, {
      method: 'POST', headers: r.agentHeaders, body: JSON.stringify({ port: address.port }),
    });
    expect(created.status).toBe(201);
    const info = PreviewInfoSchema.parse(await created.json());
    await r.releasePreviewPort?.();
    ready = false;
    const incoming = new Promise<Socket>((resolve) => upstream.once('request', (request) => resolve(request.socket)));
    const controller = new AbortController();
    const url = `${r.baseUrl}/api/sessions/${r.session.id}/previews/${info.previewId}/open`;
    const response = fetch(url, { method: 'POST', headers: r.deviceHeaders, signal: controller.signal }).catch((error: unknown) => error);
    const socket = await incoming;
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const canceledAt = performance.now();
    controller.abort();
    await response;
    await closed;
    expect(performance.now() - canceledAt).toBeLessThan(2_000);
    ready = true;
    const opened = await fetch(url, { method: 'POST', headers: r.deviceHeaders });
    expect(opened.status).toBe(200);
    expect(PreviewOpenResponseSchema.parse(await opened.json()).url).toContain('/__nanachi_preview/open#');
    expect((await history(r)).filter((event) => event.kind === 'preview_closed')).toEqual([]);
  });
});
