import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  EventsResponseSchema,
  FileInfoSchema,
  WorkspaceSchema,
  type AgentConfig,
  type FileInfo,
  type PairResponse,
  type Session,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentBinDirs, phoneSendBinDir } from '../src/agent-path.js';
import { MAX_FILE_BYTES } from '../src/file-names.js';
import { insertFile } from '../src/repository.js';
import { authHeader, createSession, fakeAgent, readAgentEnv, type AgentEnv } from './agent-support.js';
import { issueCode, setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-files-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes dos daemons: o afterEach roda por último, depois que os agentes já morreram.
const env = setupDaemonTests();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('conteudo')]);

function agents(): Record<string, AgentConfig> {
  return { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }) };
}

async function start(config: Record<string, unknown> = {}): Promise<TestDaemon> {
  return env.start({ config: { allowedRoots: [base], agents: agents(), ...config } });
}

async function workspaceId(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

async function liveSession(daemon: TestDaemon): Promise<Session> {
  return createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
}

/** Upload do celular (Bearer de dispositivo). */
async function uploadFromPhone(
  daemon: TestDaemon,
  auth: { authorization: string },
  sessionId: string,
  body: Buffer,
  headers: Record<string, string>,
) {
  return daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/attachments`,
    headers: { ...auth, ...headers },
    payload: body,
  });
}

function phoneHeaders(name: string, contentType = 'image/png'): Record<string, string> {
  return { 'content-type': contentType, 'x-file-name': encodeURIComponent(name) };
}

/** Envio do agente (token de sessão, sem Bearer). */
function agentHeaders(agentEnv: AgentEnv, name: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'image/png',
    'x-file-name': encodeURIComponent(name),
    'x-nanachi-session': agentEnv.AGENT_SESSION_ID,
    'x-nanachi-agent-token': agentEnv.NANACHI_AGENT_TOKEN,
    ...extra,
  };
}

async function postAgentFile(daemon: TestDaemon, headers: Record<string, string>, body: Buffer = PNG) {
  return daemon.app.inject({ method: 'POST', url: '/api/agent/files', headers, payload: body });
}

function filesDirOf(daemon: TestDaemon, sessionId: string): string {
  return join(daemon.home, 'files', sessionId);
}

describe('POST /api/sessions/:id/attachments (celular → PC)', () => {
  it('grava em <home>/files/<sessionId>/<fileId>-<nome>, registra direction from_phone e devolve FileInfo', async () => {
    const daemon = await start();
    const auth = await authHeader(daemon);
    const session = await liveSession(daemon);

    const res = await uploadFromPhone(daemon, auth, session.id, PNG, phoneHeaders('foto.png'));

    expect(res.statusCode).toBe(201);
    const info: FileInfo = FileInfoSchema.parse(res.json<unknown>());
    expect(info).toEqual({ fileId: expect.any(String), name: 'foto.png', mime: 'image/png', size: PNG.length });
    expect(await readFile(join(filesDirOf(daemon, session.id), `${info.fileId}-foto.png`))).toEqual(PNG);
    expect(daemon.db.prepare('SELECT direction, size FROM files WHERE id = ?').get(info.fileId)).toEqual({
      direction: 'from_phone',
      size: PNG.length,
    });
  });

  it('sanitiza o nome (basename, caracteres proibidos) antes de gravar', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);

    const res = await uploadFromPhone(
      daemon,
      await authHeader(daemon),
      session.id,
      Buffer.from('x'),
      phoneHeaders('..\\..\\evil<x>.txt', 'text/plain'),
    );

    const info = FileInfoSchema.parse(res.json<unknown>());
    expect(info.name).toBe('evil_x_.txt');
    expect(await readdir(filesDirOf(daemon, session.id))).toEqual([`${info.fileId}-evil_x_.txt`]);
  });

  it('guarda corpo JSON cru: o parser JSON global não interpreta o arquivo', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const body = Buffer.from('{"nao":"e json de api"');

    const res = await uploadFromPhone(
      daemon,
      await authHeader(daemon),
      session.id,
      body,
      phoneHeaders('dados.json', 'application/json; charset=utf-8'),
    );

    expect(res.statusCode).toBe(201);
    const info = FileInfoSchema.parse(res.json<unknown>());
    expect(info).toMatchObject({ name: 'dados.json', mime: 'application/json', size: body.length });
    expect(await readFile(join(filesDirOf(daemon, session.id), `${info.fileId}-dados.json`), 'utf8')).toBe(
      body.toString('utf8'),
    );
  });

  it('aceita exatamente 50 MiB e recusa 1 byte a mais com 413 too_large, sem gravar nada', async () => {
    const daemon = await start();
    const auth = await authHeader(daemon);
    const session = await liveSession(daemon);

    const exact = await uploadFromPhone(daemon, auth, session.id, Buffer.alloc(MAX_FILE_BYTES), phoneHeaders('a.bin', 'application/octet-stream'));
    expect(exact.statusCode).toBe(201);

    const tooBig = await uploadFromPhone(
      daemon,
      auth,
      session.id,
      Buffer.alloc(MAX_FILE_BYTES + 1),
      phoneHeaders('b.bin', 'application/octet-stream'),
    );
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json<unknown>()).toEqual({ error: 'too_large' });
    expect(await readdir(filesDirOf(daemon, session.id))).toHaveLength(1);
  });

  it('sem X-File-Name ou com corpo vazio → 400 invalid_request', async () => {
    const daemon = await start();
    const auth = await authHeader(daemon);
    const session = await liveSession(daemon);

    const noName = await uploadFromPhone(daemon, auth, session.id, PNG, { 'content-type': 'image/png' });
    expect(noName.statusCode).toBe(400);
    expect(noName.json<unknown>()).toEqual({ error: 'invalid_request' });

    const empty = await uploadFromPhone(daemon, auth, session.id, Buffer.alloc(0), phoneHeaders('a.png'));
    expect(empty.statusCode).toBe(400);
  });

  it('sessão inexistente → 404; sem Bearer → 401 e nada é gravado', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);

    const missing = await uploadFromPhone(daemon, await authHeader(daemon), 'nao-existe', PNG, phoneHeaders('a.png'));
    expect(missing.statusCode).toBe(404);

    const anonymous = await daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/attachments`,
      headers: phoneHeaders('a.png'),
      payload: PNG,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
  });
});

describe('cota de arquivos por sessão (200 arquivos e 500 MiB, os dois sentidos somados)', () => {
  /** Linha de arquivo sem gravar bytes: a cota conta o que está no banco. */
  function seedFileRow(daemon: TestDaemon, sessionId: string, size: number, direction: 'to_phone' | 'from_phone'): void {
    insertFile(daemon.db, {
      id: randomUUID(),
      sessionId,
      name: 'semente.bin',
      mime: 'application/octet-stream',
      size,
      direction,
      path: join(base, 'semente.bin'),
      createdAt: Date.now(),
    });
  }

  it('o 201º arquivo da sessão → 413 quota_exceeded, sem gravar nada no disco', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    for (let i = 0; i < 200; i++) seedFileRow(daemon, session.id, 1, 'from_phone');

    const res = await uploadFromPhone(daemon, await authHeader(daemon), session.id, Buffer.from('x'), phoneHeaders('x.txt', 'text/plain'));

    expect(res.statusCode).toBe(413);
    expect(res.json<unknown>()).toEqual({ error: 'quota_exceeded' });
    expect(await readdir(filesDirOf(daemon, session.id)).catch(() => [])).toEqual([]);
  });

  it('bytes contam nos dois sentidos: to_phone (agente) também estoura o limite de 500 MiB', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);
    seedFileRow(daemon, session.id, 500 * 1024 * 1024 - 10, 'to_phone');

    const big = await postAgentFile(daemon, agentHeaders(agentEnv, 'grande.png'), Buffer.alloc(11));

    expect(big.statusCode).toBe(413);
    expect(big.json<unknown>()).toEqual({ error: 'quota_exceeded' });
    const small = await postAgentFile(daemon, agentHeaders(agentEnv, 'pequeno.png'), Buffer.alloc(10));
    expect(small.statusCode).toBe(201);
  });

  it('o limite é por sessão: outra sessão continua gravando', async () => {
    const daemon = await start();
    const full = await liveSession(daemon);
    const other = await liveSession(daemon);
    for (let i = 0; i < 200; i++) seedFileRow(daemon, full.id, 1, 'from_phone');

    const res = await uploadFromPhone(daemon, await authHeader(daemon), other.id, Buffer.from('x'), phoneHeaders('x.txt', 'text/plain'));

    expect(res.statusCode).toBe(201);
  });
});

describe('GET /api/files/:fileId (download)', () => {
  async function uploadedPng(daemon: TestDaemon, name = 'foto.png'): Promise<FileInfo> {
    const session = await liveSession(daemon);
    const res = await uploadFromPhone(daemon, await authHeader(daemon), session.id, PNG, phoneHeaders(name));
    return FileInfoSchema.parse(res.json<unknown>());
  }

  it('imagem vai inline com nosniff e cache privado; corpo igual ao gravado', async () => {
    const daemon = await start();
    const info = await uploadedPng(daemon);

    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/files/${info.fileId}`,
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe(`inline; filename="foto.png"; filename*=UTF-8''foto.png`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it('não-imagem vai como attachment com nome em RFC 5987', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const up = await uploadFromPhone(daemon, await authHeader(daemon), session.id, Buffer.from('%PDF'), phoneHeaders('relatório final.pdf', 'application/pdf'));
    const info = FileInfoSchema.parse(up.json<unknown>());

    const res = await daemon.app.inject({ method: 'GET', url: `/api/files/${info.fileId}`, headers: await authHeader(daemon) });

    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="relat_rio final.pdf"; filename*=UTF-8''relat%C3%B3rio%20final.pdf`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('HTML enviado pelo agente é servido como octet-stream e attachment (nunca text/html)', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const up = await uploadFromPhone(daemon, await authHeader(daemon), session.id, Buffer.from('<script>x</script>'), phoneHeaders('pagina.html', 'text/html'));
    const info = FileInfoSchema.parse(up.json<unknown>());

    const res = await daemon.app.inject({ method: 'GET', url: `/api/files/${info.fileId}`, headers: await authHeader(daemon) });

    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('SVG nunca é inline (pode carregar script)', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const up = await uploadFromPhone(daemon, await authHeader(daemon), session.id, Buffer.from('<svg/>'), phoneHeaders('x.svg', 'image/svg+xml'));
    const info = FileInfoSchema.parse(up.json<unknown>());

    const res = await daemon.app.inject({ method: 'GET', url: `/api/files/${info.fileId}`, headers: await authHeader(daemon) });

    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('sem Bearer → 401; id desconhecido → 404; arquivo sumido do disco → 404', async () => {
    const daemon = await start();
    const info = await uploadedPng(daemon);

    const anonymous = await daemon.app.inject({ method: 'GET', url: `/api/files/${info.fileId}` });
    expect(anonymous.statusCode).toBe(401);

    const unknown = await daemon.app.inject({ method: 'GET', url: '/api/files/nao-existe', headers: await authHeader(daemon) });
    expect(unknown.statusCode).toBe(404);

    const row = daemon.db.prepare<[string], { path: string }>('SELECT path FROM files WHERE id = ?').get(info.fileId);
    await rm(row?.path ?? '', { force: true });
    const gone = await daemon.app.inject({ method: 'GET', url: `/api/files/${info.fileId}`, headers: await authHeader(daemon) });
    expect(gone.statusCode).toBe(404);
  });
});

describe('POST /api/agent/files (agente → celular)', () => {
  it('o agente recebe no env o id da sessão, o token e a URL do daemon, com launchers antes do PATH', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);

    expect(agentEnv.AGENT_SESSION_ID).toBe(session.id);
    expect(agentEnv.NANACHI_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(agentEnv.NANACHI_AGENT_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(agentEnv.PATH.split(delimiter)[0]).toBe(phoneSendBinDir());
    expect(agentEnv.PATH.split(delimiter).slice(1, 1 + agentBinDirs().length)).toEqual(agentBinDirs());
  });

  it('com token da sessão: 201, grava em files/<sessionId>, registra to_phone e emite o evento file com legenda', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);

    const res = await postAgentFile(daemon, agentHeaders(agentEnv, 'captura.png', { 'x-caption': encodeURIComponent('  Olá, tudo bem?  ') }));

    expect(res.statusCode).toBe(201);
    const info = FileInfoSchema.parse(res.json<unknown>());
    expect(info).toEqual({ fileId: expect.any(String), name: 'captura.png', mime: 'image/png', size: PNG.length });
    expect(await readFile(join(filesDirOf(daemon, session.id), `${info.fileId}-captura.png`))).toEqual(PNG);
    expect(daemon.db.prepare('SELECT direction FROM files WHERE id = ?').get(info.fileId)).toEqual({ direction: 'to_phone' });

    const events = await daemon.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/events`,
      headers: await authHeader(daemon),
    });
    const fileEvent = EventsResponseSchema.parse(events.json<unknown>()).events.find((event) => event.kind === 'file');
    expect(fileEvent).toMatchObject({
      kind: 'file',
      fileId: info.fileId,
      name: 'captura.png',
      mime: 'image/png',
      size: PNG.length,
      direction: 'to_phone',
      caption: 'Olá, tudo bem?',
    });
  });

  it('sem legenda, o evento não tem caption; sem X-File-Name → 400', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);

    const ok = await postAgentFile(daemon, agentHeaders(agentEnv, 'a.png'));
    expect(ok.statusCode).toBe(201);
    const [row] = daemon.db
      .prepare<[string], { payload: string }>("SELECT payload FROM events WHERE session_id = ? AND kind = 'file'")
      .all(session.id);
    expect(JSON.parse(row?.payload ?? 'null')).not.toHaveProperty('caption');

    const headers = agentHeaders(agentEnv, 'x');
    delete headers['x-file-name'];
    const noName = await postAgentFile(daemon, headers);
    expect(noName.statusCode).toBe(400);
  });

  it('legenda acima de 1000 caracteres → 400', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);

    const res = await postAgentFile(daemon, agentHeaders(agentEnv, 'a.png', { 'x-caption': encodeURIComponent('x'.repeat(1001)) }));
    expect(res.statusCode).toBe(400);
  });

  it('sem nenhum cabeçalho de agente, ou só com Bearer de dispositivo → 401', async () => {
    const daemon = await start();
    await liveSession(daemon);

    const none = await postAgentFile(daemon, { 'content-type': 'image/png', 'x-file-name': 'a.png' });
    expect(none.statusCode).toBe(401);

    const device = await postAgentFile(daemon, { ...(await authHeader(daemon)), 'content-type': 'image/png', 'x-file-name': 'a.png' });
    expect(device.statusCode).toBe(401);
    expect(daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
  });

  it('token errado → 401', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);

    const res = await postAgentFile(daemon, agentHeaders({ ...agentEnv, NANACHI_AGENT_TOKEN: 'x'.repeat(43) }, 'a.png'));

    expect(res.statusCode).toBe(401);
    expect(daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
  });

  it('token de outra sessão viva → 401 (cada sessão só escreve nela mesma)', async () => {
    const daemon = await start();
    const first = await liveSession(daemon);
    const second = await liveSession(daemon);
    const firstEnv = await readAgentEnv(pidDir, first.id);
    const secondEnv = await readAgentEnv(pidDir, second.id);

    const res = await postAgentFile(daemon, agentHeaders(firstEnv, 'a.png', { 'x-nanachi-session': secondEnv.AGENT_SESSION_ID }));

    expect(res.statusCode).toBe(401);
  });

  it('sessão parada com o token antigo → 401 (o token vem antes do estado da sessão: não revela se ela está viva)', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);
    const stopped = await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });
    expect(stopped.statusCode).toBe(204);

    const res = await postAgentFile(daemon, agentHeaders(agentEnv, 'a.png'));

    expect(res.statusCode).toBe(401);
    expect(res.json<unknown>()).toEqual({ error: 'unauthorized' });
  });

  it('sessão inexistente e sessão parada respondem igual (401 com o mesmo corpo)', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);
    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });

    const stopped = await postAgentFile(daemon, agentHeaders(agentEnv, 'a.png'));
    const unknown = await postAgentFile(daemon, agentHeaders(agentEnv, 'a.png', { 'x-nanachi-session': 'nao-existe' }));

    expect(unknown.statusCode).toBe(stopped.statusCode);
    expect(unknown.json<unknown>()).toEqual(stopped.json<unknown>());
  });

  // Valores que passam pela checagem de Host: o que se testa é o header de proxy, não o Host.
  it.each([
    ['x-forwarded-for', '100.64.0.1'],
    ['x-forwarded-host', 'pc.tailnet.ts.net'],
    ['x-forwarded-proto', 'https'],
    ['tailscale-user-login', 'jose@exemplo.com'],
  ])(
    'com o header %s (veio pelo tailscale serve) → 403, mesmo com token válido',
    async (name, value) => {
      const daemon = await start();
      const session = await liveSession(daemon);
      const agentEnv = await readAgentEnv(pidDir, session.id);

      const res = await postAgentFile(daemon, agentHeaders(agentEnv, 'a.png', { [name]: value }));

      expect(res.statusCode).toBe(403);
      expect(res.json<unknown>()).toEqual({ error: 'forbidden' });
      expect(daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
    },
  );

  it('com allowedTailscaleLogins configurado, o agente (loopback, sem Tailscale) continua passando', async () => {
    const login = { 'tailscale-user-login': 'jose@exemplo.com' };
    const daemon = await start({ allowedTailscaleLogins: ['jose@exemplo.com'] });
    const paired = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair',
      headers: login,
      payload: { code: issueCode(daemon), deviceName: 'iPhone' },
    });
    const auth = { ...login, authorization: `Bearer ${paired.json<PairResponse>().token}` };
    const created = await daemon.app.inject({ method: 'POST', url: '/api/workspaces', headers: auth, payload: { path: workspace } });
    const session = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: auth,
      payload: { workspaceId: WorkspaceSchema.parse(created.json<unknown>()).id, agent: 'fake' },
    });
    const agentEnv = await readAgentEnv(pidDir, (session.json<Session>()).id);

    const res = await postAgentFile(daemon, agentHeaders(agentEnv, 'a.png'));

    expect(res.statusCode).toBe(201);
    // A exceção vale só para o endpoint do agente: o resto da API continua barrado sem o login.
    const roots = await daemon.app.inject({ method: 'GET', url: '/api/roots', headers: await authHeader(daemon) });
    expect(roots.statusCode).toBe(403);
  });

  it('acima de 50 MiB → 413 too_large e nada gravado', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);

    const res = await postAgentFile(daemon, agentHeaders(agentEnv, 'grande.bin', { 'content-type': 'application/octet-stream' }), Buffer.alloc(MAX_FILE_BYTES + 1));

    expect(res.statusCode).toBe(413);
    expect(res.json<unknown>()).toEqual({ error: 'too_large' });
    await expect(readdir(filesDirOf(daemon, session.id))).rejects.toThrow();
  });
});

describe('cabeçalho X-File-Name', () => {
  it('escape inválido (%) → 400, não 500', async () => {
    const daemon = await start();
    const session = await liveSession(daemon);
    const agentEnv = await readAgentEnv(pidDir, session.id);

    const res = await postAgentFile(daemon, agentHeaders(agentEnv, 'x', { 'x-file-name': '%E0%A4%A' }));

    expect(res.statusCode).toBe(400);
  });
});
