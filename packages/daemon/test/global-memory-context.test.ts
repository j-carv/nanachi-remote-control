import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearningSettingsSchema, WorkspaceSchema, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { insertEvent } from '../src/repository.js';
import { authHeader, createSession, fakeAgent, listen, readAgentEnv } from './agent-support.js';
import { setupDaemonTests } from './support.js';
import { removeTempDir } from './temp.js';

let root: string;
beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-global-memory-')));
  await mkdir(join(root, 'one'));
  await mkdir(join(root, 'two'));
});
afterEach(async () => { await removeTempDir(root); });
const env = setupDaemonTests();

it('shares learned memory across workspaces and reports authenticated current and source workspaces', async () => {
  const pids = join(root, 'pids');
  const daemon = await env.start({ config: { allowedRoots: [root], agents: { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pids }) } } });
  await listen(daemon);
  const owner = await authHeader(daemon);
  await daemon.app.inject({ method: 'PUT', url: '/api/mcp/agents/fake', headers: owner, payload: { enabled: true } });
  await daemon.app.inject({ method: 'PUT', url: '/api/learning/settings', headers: owner, payload: { ...LearningSettingsSchema.parse({}), enabled: true, enabledAgents: ['fake'] } });
  const sessions: Session[] = [];
  for (const name of ['one', 'two']) {
    const created = await daemon.app.inject({ method: 'POST', url: '/api/workspaces', headers: owner, payload: { path: join(root, name) } });
    const workspace = WorkspaceSchema.parse(created.json<unknown>());
    sessions.push(await createSession(daemon, { workspaceId: workspace.id, agent: 'fake' }));
  }
  const [first, second] = sessions;
  if (first === undefined || second === undefined) throw new Error('Missing synthetic sessions');
  const credentials = await Promise.all(sessions.map((session) => readAgentEnv(pids, session.id)));
  const firstToken = credentials[0]?.NANACHI_AGENT_TOKEN;
  const secondToken = credentials[1]?.NANACHI_AGENT_TOKEN;
  if (firstToken === undefined || secondToken === undefined) throw new Error('Missing synthetic agent credentials');
  const evidence = insertEvent(daemon.db, { sessionId: first.id, ts: 1, kind: 'user_message', payload: JSON.stringify({ text: 'Remember that I prefer concise explanations.' }) });
  const saved = await daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers: { 'x-nanachi-session': first.id, 'x-nanachi-agent-token': firstToken }, payload: { kind: 'memory', input: { action: 'save', title: 'Explanation preference', content: 'Prefer concise explanations.', evidenceSeqs: [evidence] } } });
  expect(saved.statusCode).toBe(200);
  const entryId = saved.json<{ entries: Array<{ id: string }> }>().entries[0]?.id;
  if (entryId === undefined) throw new Error('Memory was not saved');
  const found = await daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers: { 'x-nanachi-session': second.id, 'x-nanachi-agent-token': secondToken }, payload: { kind: 'memory', input: { action: 'read', id: entryId } } });
  expect(found.statusCode).toBe(200);
  expect(found.json()).toMatchObject({
    workspace: { id: second.workspaceId, name: 'two', path: join(root, 'two') },
    entries: [{ id: entryId, workspaceId: first.workspaceId, sourceWorkspace: { id: first.workspaceId, name: 'one', path: join(root, 'one') }, content: 'Prefer concise explanations.' }],
  });
  const globalList = await daemon.app.inject({ method: 'GET', url: '/api/memories', headers: owner });
  expect(globalList.statusCode).toBe(200);
  expect(globalList.json()).toMatchObject({ entries: [expect.objectContaining({ id: entryId })] });
  const forged = await daemon.app.inject({ method: 'POST', url: '/api/agent/memory', headers: { 'x-nanachi-session': second.id, 'x-nanachi-agent-token': firstToken }, payload: { kind: 'memory', input: { action: 'read', id: entryId } } });
  expect(forged.statusCode).toBe(401);
});
