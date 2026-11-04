import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSchema, WorkspacesResponseSchema, type Workspace } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeader } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-mute-')));
  workspace = join(base, 'projeto');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

const env = setupDaemonTests();

async function startWithWorkspace(): Promise<{ daemon: TestDaemon; workspace: Workspace }> {
  const daemon = await env.start({ config: { allowedRoots: [base] } });
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return { daemon, workspace: WorkspaceSchema.parse(res.json<unknown>()) };
}

describe('PATCH /api/workspaces/:id (silenciar)', () => {
  it('workspace novo nasce sem silêncio; PATCH liga e desliga e devolve o Workspace', async () => {
    const { daemon, workspace: created } = await startWithWorkspace();
    expect(created.muted).toBe(false);

    const on = await daemon.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${created.id}`,
      headers: await authHeader(daemon),
      payload: { muted: true },
    });
    expect(on.statusCode).toBe(200);
    expect(WorkspaceSchema.parse(on.json<unknown>())).toEqual({ ...created, muted: true });

    const off = await daemon.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${created.id}`,
      headers: await authHeader(daemon),
      payload: { muted: false },
    });
    expect(WorkspaceSchema.parse(off.json<unknown>()).muted).toBe(false);
  });

  it('o silêncio persiste: a listagem e o banco refletem a mudança', async () => {
    const { daemon, workspace: created } = await startWithWorkspace();
    await daemon.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${created.id}`,
      headers: await authHeader(daemon),
      payload: { muted: true },
    });

    const list = await daemon.app.inject({ method: 'GET', url: '/api/workspaces', headers: await authHeader(daemon) });
    expect(WorkspacesResponseSchema.parse(list.json<unknown>()).workspaces).toEqual([{ ...created, muted: true }]);
    expect(daemon.db.prepare<[string], { muted: number }>('SELECT muted FROM workspaces WHERE id = ?').get(created.id)).toEqual({
      muted: 1,
    });
  });

  it('id inexistente → 404; corpo inválido → 400', async () => {
    const { daemon, workspace: created } = await startWithWorkspace();

    const missing = await daemon.app.inject({
      method: 'PATCH',
      url: '/api/workspaces/nao-existe',
      headers: await authHeader(daemon),
      payload: { muted: true },
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await daemon.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${created.id}`,
      headers: await authHeader(daemon),
      payload: { muted: 'sim' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<unknown>()).toEqual({ error: 'invalid_request' });
  });

  it('sem Bearer → 401', async () => {
    const { daemon, workspace: created } = await startWithWorkspace();
    const res = await daemon.app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${created.id}`,
      payload: { muted: true },
    });
    expect(res.statusCode).toBe(401);
  });
});
