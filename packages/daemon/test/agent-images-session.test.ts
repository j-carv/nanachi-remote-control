import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceSchema, type Session, type SessionEvent } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  fakeAgent,
  isEvent,
  listen,
  pairToken,
  WsTestClient,
} from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Imagens que o agente manda via ACP (fake agent com "img-inline" e "img-arquivo"). Mensagens e tool calls
 * viram ToolContent/evento file; o mesmo conteúdo reenviado não cria outro arquivo; nada notifica push.
 */

let base: string;
let workspace: string;
let pidDir: string;
/** Mesmo PNG de 1x1 que o fake agent manda em "img-inline" (test/fixtures/fake-agent.ts). */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const FILE_BYTES = Buffer.from('arquivo local diferente');

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-agimg-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
  await writeFile(join(workspace, 'teste.png'), FILE_BYTES);
  await writeFile(join(base, 'fora.png'), FILE_BYTES);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado depois do afterEach acima: os hooks rodam em pilha, então os daemons param antes da pasta sumir.
const env = setupDaemonTests();

interface Started {
  daemon: TestDaemon;
  session: Session;
  client: WsTestClient;
  notified: string[];
}

async function start(): Promise<Started> {
  const notified: string[] = [];
  const agent = fakeAgent({
    FAKE_AGENT_PID_DIR: pidDir,
    FAKE_AGENT_IMAGE_FILE: join(workspace, 'teste.png'),
    FAKE_AGENT_IMAGE_OUTSIDE: join(base, 'fora.png'),
  });
  const daemon = await env.start({
    config: { allowedRoots: [workspace], agents: { fake: agent }, phoneSendHint: false },
    onNotify: (_sessionId, kind) => {
      notified.push(kind);
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
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return { daemon, session, client, notified };
}

/** Conteúdo de cada tool_call/tool_call_update de um toolCallId, na ordem em que chegaram. */
function contentsOf(events: SessionEvent[], toolCallId: string): unknown[] {
  return events.flatMap((event) =>
    (event.kind === 'tool_call' || event.kind === 'tool_call_update') && event.toolCallId === toolCallId
      ? [event.content]
      : [],
  );
}

describe('imagens enviadas pelo agente (ACP → arquivo da sessão)', () => {
  it('imagem em mensagem vira evento file to_phone; em tool call vira ToolContent image com o mesmo arquivo', async () => {
    const { session, client } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: 'img-inline', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    const events = client.eventsOf(session.id);
    const fileEvents = events.filter((event): event is Extract<SessionEvent, { kind: 'file' }> => event.kind === 'file');
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]).toMatchObject({ name: 'imagem-1.png', mime: 'image/png', direction: 'to_phone', size: PNG_BYTES.length });
    const fileId = fileEvents[0]?.fileId;

    // tool_call e tool_call_update reenviam a mesma imagem: os dois apontam para o mesmo arquivo.
    expect(contentsOf(events, 'call-img')).toEqual([
      [{ type: 'image', fileId, mime: 'image/png' }],
      [{ type: 'image', fileId, mime: 'image/png' }],
    ]);
    expect(fileEvents).toHaveLength(1);
  });

  it('imagem não dispara push: onNotify não recebe file', async () => {
    const { session, client, notified } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: 'img-inline', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    expect(notified).not.toContain('file');
  });

  it('arquivo local de imagem dentro das raízes vira arquivo; fora das raízes não aparece no evento', async () => {
    const { daemon, session, client } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: 'img-arquivo', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    const events = client.eventsOf(session.id);
    const [inside] = contentsOf(events, 'call-link');
    const [outside] = contentsOf(events, 'call-outside');
    expect(inside).toEqual([{ type: 'image', fileId: expect.any(String), mime: 'image/png' }]);
    expect(outside).toEqual([]);

    const fileId = (inside as Array<{ fileId: string }>)[0]?.fileId ?? '';
    const res = await daemon.app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: await authHeader(daemon) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload).toEqual(FILE_BYTES);
  });

  it('GET /api/files devolve a imagem inline com os bytes do agente', async () => {
    const { daemon, session, client } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: 'img-inline', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    const file = client.eventsOf(session.id).find((event) => event.kind === 'file');
    const fileId = file?.kind === 'file' ? file.fileId : '';
    const res = await daemon.app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: await authHeader(daemon) });
    expect(res.rawPayload).toEqual(PNG_BYTES);
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('mensagens de texto continuam iguais (sem evento file)', async () => {
    const { session, client } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: 'oi', attachments: [] });
    await client.waitFor(isEvent('turn_end'));

    expect(client.eventsOf(session.id).some((event) => event.kind === 'file')).toBe(false);
  });
});
