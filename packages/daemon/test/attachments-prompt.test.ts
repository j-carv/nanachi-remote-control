import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileInfoSchema, WorkspaceSchema, type AgentConfig, type FileInfo, type ServerMessage, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  fakeAgent,
  isEvent,
  listen,
  pairToken,
  promptsReceived,
  readAgentEnv,
  WsTestClient,
} from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-att-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes dos daemons: o afterEach roda por último, depois que os agentes já morreram.
const env = setupDaemonTests();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('imagem')]);
const PDF = Buffer.from('%PDF-1.4 texto');

/** `fake` não anuncia promptCapabilities.image; `imagem` anuncia. */
function agents(): Record<string, AgentConfig> {
  return {
    fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }),
    imagem: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir, FAKE_AGENT_PROMPT_IMAGE: '1' }),
  };
}

async function start(): Promise<TestDaemon> {
  return env.start({ config: { allowedRoots: [base], agents: agents() } });
}

interface Open {
  daemon: TestDaemon;
  session: Session;
  client: WsTestClient;
  other: Session;
}

/** Duas sessões (a segunda serve para testar anexo de outra sessão) e um cliente WS inscrito na primeira. */
async function openSession(agent: string): Promise<Open> {
  const daemon = await start();
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  const workspaceId = WorkspaceSchema.parse(res.json<unknown>()).id;
  const session = await createSession(daemon, { workspaceId, agent });
  const other = await createSession(daemon, { workspaceId, agent });
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return { daemon, session, client, other };
}

async function upload(daemon: TestDaemon, sessionId: string, body: Buffer, name: string, contentType: string): Promise<FileInfo> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/attachments`,
    headers: { ...(await authHeader(daemon)), 'content-type': contentType, 'x-file-name': encodeURIComponent(name) },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return FileInfoSchema.parse(res.json<unknown>());
}

function isErrorFor(sessionId: string) {
  return (message: ServerMessage) => message.type === 'error' && message.sessionId === sessionId;
}

function isSessionTitle(sessionId: string, title: string) {
  return (message: ServerMessage) =>
    message.type === 'session' && message.session.id === sessionId && message.session.title === title;
}

describe('WS prompt com anexos (celular → agente)', () => {
  it('agente com promptCapabilities.image: imagem vai inline (base64) depois do texto; user_message traz os anexos', async () => {
    const { daemon, session, client } = await openSession('imagem');
    const file = await upload(daemon, session.id, PNG, 'foto.png', 'image/png');

    client.send({ type: 'prompt', sessionId: session.id, text: 'olha', attachments: [file.fileId] });
    await client.waitFor(isEvent('turn_end'));

    expect(await promptsReceived(pidDir, session.id)).toEqual([
      [
        { type: 'text', text: 'olha' },
        { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      ],
    ]);
    const userMessage = client.eventsOf(session.id).find((event) => event.kind === 'user_message');
    expect(userMessage).toMatchObject({ kind: 'user_message', text: 'olha', attachments: [file] });
  });

  it('agente sem a capacidade: imagem vai como [Arquivo anexado: <caminho absoluto>] no texto', async () => {
    const { daemon, session, client } = await openSession('fake');
    const file = await upload(daemon, session.id, PNG, 'foto.png', 'image/png');

    client.send({ type: 'prompt', sessionId: session.id, text: 'olha', attachments: [file.fileId] });
    await client.waitFor(isEvent('turn_end'));

    const storedPath = join(daemon.home, 'files', session.id, `${file.fileId}-foto.png`);
    expect(await promptsReceived(pidDir, session.id)).toEqual([
      [{ type: 'text', text: `olha\n\n[Arquivo anexado: ${storedPath}]` }],
    ]);
    expect(await readFile(storedPath)).toEqual(PNG);
  });

  it('não-imagem vai como caminho mesmo quando o agente aceita imagens', async () => {
    const { daemon, session, client } = await openSession('imagem');
    const file = await upload(daemon, session.id, PDF, 'relatorio.pdf', 'application/pdf');

    client.send({ type: 'prompt', sessionId: session.id, text: 'leia', attachments: [file.fileId] });
    await client.waitFor(isEvent('turn_end'));

    const [blocks] = await promptsReceived(pidDir, session.id);
    expect(blocks?.map((block) => block.type)).toEqual(['text']);
    expect(blocks).toEqual([
      { type: 'text', text: `leia\n\n[Arquivo anexado: ${join(daemon.home, 'files', session.id, `${file.fileId}-relatorio.pdf`)}]` },
    ]);
  });

  it('sem texto, só anexos: sem bloco de texto vazio e o título da sessão vem do nome do primeiro anexo', async () => {
    const { daemon, session, client } = await openSession('imagem');
    const file = await upload(daemon, session.id, PNG, 'print.png', 'image/png');

    client.send({ type: 'prompt', sessionId: session.id, text: '', attachments: [file.fileId] });
    await client.waitFor(isSessionTitle(session.id, 'print.png'));
    await client.waitFor(isEvent('turn_end'));

    expect(await promptsReceived(pidDir, session.id)).toEqual([
      [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
    ]);
  });

  it('anexo que não existe, é de outra sessão ou veio do agente (to_phone) → erro e nenhum prompt', async () => {
    const { daemon, session, client, other } = await openSession('fake');
    const foreign = await upload(daemon, other.id, PNG, 'outra.png', 'image/png');
    const agentEnv = await readAgentEnv(pidDir, session.id);
    const sent = await daemon.app.inject({
      method: 'POST',
      url: '/api/agent/files',
      headers: {
        'content-type': 'image/png',
        'x-file-name': 'do-agente.png',
        'x-nanachi-session': agentEnv.AGENT_SESSION_ID,
        'x-nanachi-agent-token': agentEnv.NANACHI_AGENT_TOKEN,
      },
      payload: PNG,
    });
    const toPhone = FileInfoSchema.parse(sent.json<unknown>());

    for (const fileId of ['nao-existe', foreign.fileId, toPhone.fileId]) {
      client.send({ type: 'prompt', sessionId: session.id, text: 'oi', attachments: [fileId] });
      await client.waitFor(isErrorFor(session.id));
    }

    expect(client.eventsOf(session.id).some((event) => event.kind === 'user_message')).toBe(false);
    expect(await promptsReceived(pidDir, session.id)).toEqual([]);
  });
});
