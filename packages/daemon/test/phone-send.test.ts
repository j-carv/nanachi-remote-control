import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceSchema, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mimeFromName,
  NO_SESSION_MESSAGE,
  parsePhoneSendArgs,
  runPhoneSend,
  type PhoneSendDeps,
  type PhoneSendIO,
} from '../src/phone-send.js';
import { authHeader, createSession, fakeAgent, listen, readAgentEnv, type AgentEnv } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-phone-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes dos daemons: o afterEach roda por último, depois que os agentes já morreram.
const env = setupDaemonTests();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('tela')]);
const BIN_DIR = resolve(fileURLToPath(new URL('../bin', import.meta.url)));

function captureIO(): { io: PhoneSendIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function deps(overrides: Partial<PhoneSendDeps> = {}): PhoneSendDeps {
  return {
    fetch: globalThis.fetch,
    platform: process.platform,
    captureScreenshot: () => Promise.reject(new Error('captura real só em teste manual')),
    ...overrides,
  };
}

/** Daemon ouvindo numa porta efêmera e uma sessão fake já viva (o env do agente aponta para a porta real). */
async function liveDaemon(): Promise<{ daemon: TestDaemon; session: Session; agentEnv: AgentEnv }> {
  const daemon = await env.start({
    config: { allowedRoots: [base], agents: { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }) } },
  });
  await listen(daemon);
  const created = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  const session = await createSession(daemon, { workspaceId: WorkspaceSchema.parse(created.json<unknown>()).id, agent: 'fake' });
  return { daemon, session, agentEnv: await readAgentEnv(pidDir, session.id) };
}

function asProcessEnv(agentEnv: AgentEnv): NodeJS.ProcessEnv {
  return { ...agentEnv };
}

describe('parsePhoneSendArgs', () => {
  it('arquivo, com ou sem legenda', () => {
    expect(parsePhoneSendArgs(['nota.txt'])).toEqual({ ok: true, value: { kind: 'file', path: 'nota.txt' } });
    expect(parsePhoneSendArgs(['nota.txt', '--caption', 'veja isso'])).toEqual({
      ok: true,
      value: { kind: 'file', path: 'nota.txt', caption: 'veja isso' },
    });
  });

  it('--screenshot, com ou sem legenda; legenda vazia não conta', () => {
    expect(parsePhoneSendArgs(['--screenshot'])).toEqual({ ok: true, value: { kind: 'screenshot' } });
    expect(parsePhoneSendArgs(['--screenshot', '--caption', 'tela'])).toEqual({
      ok: true,
      value: { kind: 'screenshot', caption: 'tela' },
    });
    expect(parsePhoneSendArgs(['--screenshot', '--caption', ''])).toEqual({ ok: true, value: { kind: 'screenshot' } });
  });

  it.each([
    [[], 'falta o arquivo a enviar'],
    [['a.txt', 'b.txt'], 'envie um arquivo por vez'],
    [['--screenshot', 'a.txt'], '--screenshot não recebe arquivo'],
    [['a.txt', '--caption'], '--caption precisa de um texto'],
    [['a.txt', '--ruim'], 'opção desconhecida: --ruim'],
  ])('erros de uso: %j', (argv, error) => {
    expect(parsePhoneSendArgs(argv)).toEqual({ ok: false, error });
  });
});

describe('mimeFromName', () => {
  it('pela extensão, sem diferenciar maiúsculas; desconhecida vira octet-stream', () => {
    expect(mimeFromName('Foto.PNG')).toBe('image/png');
    expect(mimeFromName('relatorio.pdf')).toBe('application/pdf');
    expect(mimeFromName('dados.xyz')).toBe('application/octet-stream');
    expect(mimeFromName('semextensao')).toBe('application/octet-stream');
  });
});

describe('launchers (bin/)', () => {
  it('phone-send.cmd e phone-send chamam node no dist/phone-send.js, relativo ao próprio script', async () => {
    const cmd = await readFile(join(BIN_DIR, 'phone-send.cmd'), 'utf8');
    const sh = await readFile(join(BIN_DIR, 'phone-send'), 'utf8');

    expect(cmd).toContain('node "%~dp0..\\dist\\phone-send.js" %*');
    expect(sh).toContain('exec node "$DIR/dist/phone-send.js" "$@"');
  });
});

describe('runPhoneSend', () => {
  it('sem as variáveis do agente: mensagem do contrato e saída 1', async () => {
    const { io, out, err } = captureIO();

    const code = await runPhoneSend([join(base, 'nota.txt')], {}, io, deps());

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([NO_SESSION_MESSAGE]);
  });

  it('envia o arquivo com legenda para a sessão do agente: "enviado: <nome>", evento file e arquivo gravado', async () => {
    const { daemon, session, agentEnv } = await liveDaemon();
    await writeFile(join(base, 'nota.txt'), 'olá celular');
    const { io, out, err } = captureIO();

    const code = await runPhoneSend([join(base, 'nota.txt'), '--caption', 'Veja isso'], asProcessEnv(agentEnv), io, deps());

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out).toEqual(['enviado: nota.txt']);
    const [row] = daemon.db
      .prepare<[string], { payload: string }>("SELECT payload FROM events WHERE session_id = ? AND kind = 'file'")
      .all(session.id);
    expect(JSON.parse(row?.payload ?? 'null')).toMatchObject({
      name: 'nota.txt',
      mime: 'text/plain',
      size: Buffer.byteLength('olá celular'),
      direction: 'to_phone',
      caption: 'Veja isso',
    });
  });

  it('arquivo inexistente → saída 1 com mensagem, sem chamar o daemon', async () => {
    const { daemon, session, agentEnv } = await liveDaemon();
    const { io, err } = captureIO();

    const code = await runPhoneSend(['nao-existe.txt'], asProcessEnv(agentEnv), io, deps());

    expect(code).toBe(1);
    expect(err[0]).toContain('arquivo não encontrado: nao-existe.txt');
    expect(daemon.db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM files WHERE session_id = ?").get(session.id)).toEqual({ n: 0 });
  });

  it('token errado → saída 1 com o motivo do daemon (401)', async () => {
    const { agentEnv } = await liveDaemon();
    await writeFile(join(base, 'nota.txt'), 'x');
    const { io, err } = captureIO();

    const code = await runPhoneSend([join(base, 'nota.txt')], asProcessEnv({ ...agentEnv, NANACHI_AGENT_TOKEN: 'x'.repeat(43) }), io, deps());

    expect(code).toBe(1);
    expect(err).toEqual(['o Nanachi Remote não reconhece o token desta sessão']);
  });

  it('sessão parada → saída 1 (401: o token já foi revogado; a rota não revela se a sessão está viva)', async () => {
    const { daemon, session, agentEnv } = await liveDaemon();
    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });
    await writeFile(join(base, 'nota.txt'), 'x');
    const { io, err } = captureIO();

    const code = await runPhoneSend([join(base, 'nota.txt')], asProcessEnv(agentEnv), io, deps());

    expect(code).toBe(1);
    expect(err).toEqual(['o Nanachi Remote não reconhece o token desta sessão']);
  });

  it('daemon fora do ar → saída 1 com mensagem de conexão', async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await writeFile(join(base, 'nota.txt'), 'x');
    const { io, err } = captureIO();

    const code = await runPhoneSend(
      [join(base, 'nota.txt')],
      { AGENT_SESSION_ID: 'a', NANACHI_AGENT_TOKEN: 'b', NANACHI_URL: `http://127.0.0.1:${port}` },
      io,
      deps(),
    );

    expect(code).toBe(1);
    expect(err).toEqual([`não foi possível falar com o Nanachi Remote (http://127.0.0.1:${port})`]);
  });

  it('--screenshot fora do Windows → saída 1', async () => {
    const { agentEnv } = await liveDaemon();
    const { io, err } = captureIO();

    const code = await runPhoneSend(['--screenshot'], asProcessEnv(agentEnv), io, deps({ platform: 'linux' }));

    expect(code).toBe(1);
    expect(err).toEqual(['--screenshot só funciona no Windows']);
  });

  it('--screenshot: a captura vai para PNG temporário, é enviada e o temporário é apagado (captura simulada)', async () => {
    const { daemon, session, agentEnv } = await liveDaemon();
    let seen = '';
    const { io, out, err } = captureIO();

    const code = await runPhoneSend(
      ['--screenshot', '--caption', 'print'],
      asProcessEnv(agentEnv),
      io,
      deps({
        platform: 'win32',
        captureScreenshot: async (target) => {
          seen = target;
          await writeFile(target, PNG);
        },
      }),
    );

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^enviado: captura-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
    expect(seen).toMatch(/nanachi-captura-.*\.png$/);
    expect(existsSync(seen)).toBe(false);
    const [row] = daemon.db
      .prepare<[string], { payload: string }>("SELECT payload FROM events WHERE session_id = ? AND kind = 'file'")
      .all(session.id);
    expect(JSON.parse(row?.payload ?? 'null')).toMatchObject({ mime: 'image/png', size: PNG.length, caption: 'print' });
  });

  it('captura que falha: saída 1 e nenhum envio', async () => {
    const { daemon, session, agentEnv } = await liveDaemon();
    const { io, err } = captureIO();

    const code = await runPhoneSend(
      ['--screenshot'],
      asProcessEnv(agentEnv),
      io,
      deps({ platform: 'win32', captureScreenshot: () => Promise.reject(new Error('sem área de trabalho')) }),
    );

    expect(code).toBe(1);
    expect(err).toEqual(['sem área de trabalho']);
    expect(daemon.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM files WHERE session_id = ?').get(session.id)).toEqual({ n: 0 });
  });
});
