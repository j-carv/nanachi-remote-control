import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceSchema, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNanachiMcpServer, nanachiMcpDescriptor } from '../src/nanachi-mcp.js';
import type { PhoneSendDeps } from '../src/phone-send.js';
import { authHeader, createSession, fakeAgent, listen, readAgentEnv } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;
beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-mcp-tools-')));
  workspace = join(base, 'workspace');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});
afterEach(async () => { await removeTempDir(base); });
const env = setupDaemonTests();
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});

async function liveSession(): Promise<{ daemon: TestDaemon; session: Session; credentials: NodeJS.ProcessEnv }> {
  const daemon = await env.start({ config: { allowedRoots: [base], agents: { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }) } } });
  await listen(daemon);
  const response = await daemon.app.inject({
    method: 'POST', url: '/api/workspaces', headers: await authHeader(daemon), payload: { path: workspace },
  });
  const session = await createSession(daemon, { workspaceId: WorkspaceSchema.parse(response.json<unknown>()).id, agent: 'fake' });
  return { daemon, session, credentials: { ...await readAgentEnv(pidDir, session.id), NANACHI_WORKSPACE: workspace } };
}
async function inMemoryClient(credentials: NodeJS.ProcessEnv, deps?: PhoneSendDeps): Promise<Client> {
  const server = createNanachiMcpServer(credentials, deps);
  const client = new Client({ name: 'nanachi-test', version: '1.0.0' });
  close.push(() => server.close(), () => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
function fileCount(daemon: TestDaemon): number {
  return daemon.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM files').get()?.count ?? 0;
}

describe('embedded phone_send MCP', () => {
  it('the source stdio entry advertises optional Nanachi tools and sends workspace-relative files truthfully', async () => {
    const { daemon, session, credentials } = await liveSession();
    await writeFile(join(workspace, 'result.txt'), 'synthetic result');
    const descriptor = nanachiMcpDescriptor(credentials, workspace);
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    close.push(() => client.close());
    await client.connect(new StdioClientTransport({
      command: descriptor.command, args: descriptor.args,
      env: Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value])),
      // Deliberately not the workspace: relative paths must use the explicit session workspace.
      cwd: base, stderr: 'pipe',
    }));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['phone_send', 'ask_user', 'request_file', 'open_preview', 'memory', 'skills']);
    expect(tools[0]?.inputSchema.properties).toHaveProperty('path');
    expect(tools[0]?.inputSchema.properties).toHaveProperty('screenshot');
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {}).sort()).toEqual(['caption', 'path', 'screenshot']);
    expect(Object.keys(tools[1]?.inputSchema.properties ?? {}).sort()).toEqual(['options', 'question']);
    expect(tools[1]?.description).toContain('NEVER mean approval');
    const result = await client.callTool({ name: 'phone_send', arguments: { path: 'result.txt', caption: 'Synthetic delivery' } });
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'enviado: result.txt' }] });
    const event = daemon.db.prepare<[string], { payload: string }>("SELECT payload FROM events WHERE session_id = ? AND kind = 'file'").get(session.id);
    expect(JSON.parse(event?.payload ?? 'null')).toMatchObject({ name: 'result.txt', caption: 'Synthetic delivery', direction: 'to_phone' });
    expect(fileCount(daemon)).toBe(1);
  });

  it.each([
    {}, { path: '' }, { screenshot: false }, { path: 'a.txt', screenshot: true },
    { path: 'a.txt', url: 'http://attacker.invalid' },
    { path: 'a.txt', sessionId: 'other' }, { path: 'a.txt', token: 'model-token' },
    { path: 'a.txt', NANACHI_AGENT_TOKEN: 'model-token' },
  ])('rejects invalid or credential-bearing input without delivery: %j', async (input) => {
    const { daemon, credentials } = await liveSession();
    await writeFile(join(workspace, 'a.txt'), 'must not send');
    const client = await inMemoryClient(credentials);
    expect(await client.callTool({ name: 'phone_send', arguments: input })).toMatchObject({ isError: true });
    expect(fileCount(daemon)).toBe(0);
  });

  it('missing files and missing session credentials return errors, never successful delivery', async () => {
    const { daemon, credentials } = await liveSession();
    const client = await inMemoryClient(credentials);
    expect(await client.callTool({ name: 'phone_send', arguments: { path: 'missing.txt' } }))
      .toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('arquivo não encontrado') }] });
    const unbound = await inMemoryClient({ NANACHI_WORKSPACE: workspace });
    expect(await unbound.callTool({ name: 'phone_send', arguments: { path: 'missing.txt' } }))
      .toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('só funciona dentro de uma sessão') }] });
    expect(fileCount(daemon)).toBe(0);
  });

  it('keeps credentials bound to their session and rejects them after stop and after resume', async () => {
    const { daemon, session, credentials } = await liveSession();
    await writeFile(join(workspace, 'a.txt'), 'private result');
    const other = await createSession(daemon, { workspaceId: session.workspaceId, agent: 'fake' });
    const crossed = await inMemoryClient({ ...credentials, AGENT_SESSION_ID: other.id });
    const rejected = { isError: true, content: [{ type: 'text', text: 'o Nanachi Remote não reconhece o token desta sessão' }] };
    expect(await crossed.callTool({ name: 'phone_send', arguments: { path: 'a.txt' } })).toMatchObject(rejected);
    const stale = await inMemoryClient(credentials);
    const headers = await authHeader(daemon);
    expect((await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers })).statusCode).toBe(204);
    expect(await stale.callTool({ name: 'phone_send', arguments: { path: 'a.txt' } })).toMatchObject(rejected);
    expect((await daemon.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/resume`, headers })).statusCode).toBe(200);
    expect(await stale.callTool({ name: 'phone_send', arguments: { path: 'a.txt' } })).toMatchObject(rejected);
    expect(fileCount(daemon)).toBe(0);
    const refreshed = await inMemoryClient({ ...await readAgentEnv(pidDir, session.id), NANACHI_WORKSPACE: workspace });
    expect(await refreshed.callTool({ name: 'phone_send', arguments: { path: 'a.txt' } })).toMatchObject({ isError: false });
    expect(fileCount(daemon)).toBe(1);
  });

  it('uses the existing screenshot capture/upload path and removes its temporary PNG', async () => {
    const { daemon, credentials } = await liveSession();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic screen')]);
    let target = '';
    const client = await inMemoryClient(credentials, {
      fetch: globalThis.fetch, platform: 'win32',
      captureScreenshot: async (path) => { target = path; await writeFile(path, png); },
    });
    expect(await client.callTool({ name: 'phone_send', arguments: { screenshot: true, caption: 'Synthetic screen' } }))
      .toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringMatching(/^enviado: captura-.*\.png$/) }] });
    expect(target).not.toBe('');
    expect(existsSync(target)).toBe(false);
    expect(fileCount(daemon)).toBe(1);
  });

  it('returns screenshot platform and capture failures as MCP errors without uploads', async () => {
    const { daemon, credentials } = await liveSession();
    for (const platform of ['linux', 'win32'] as const) {
      const client = await inMemoryClient(credentials, {
        fetch: globalThis.fetch, platform,
        captureScreenshot: async () => { throw new Error('Synthetic capture failure'); },
      });
      expect(await client.callTool({ name: 'phone_send', arguments: { screenshot: true } })).toMatchObject({ isError: true });
    }
    expect(fileCount(daemon)).toBe(0);
  });
});
