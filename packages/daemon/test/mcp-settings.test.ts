import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NanachiMcpResponseSchema } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { NanachiMcpSettings } from '../src/mcp-settings.js';
import { authHeader, fakeAgent } from './agent-support.js';
import { setupDaemonTests } from './support.js';

const env = setupDaemonTests();
const config = {
  agents: {
    first: fakeAgent(),
    second: { ...fakeAgent(), label: 'Second agent' },
    terminal: { label: 'Terminal', command: process.execPath, args: [], env: {}, kind: 'pty' },
  },
};

describe('Nanachi MCP opt-in settings', () => {
  it('requires paired-device authentication for reading and changing the selection', async () => {
    const daemon = await env.start({ config });
    expect((await daemon.app.inject({ method: 'GET', url: '/api/mcp/agents' })).statusCode).toBe(401);
    expect((await daemon.app.inject({ method: 'PUT', url: '/api/mcp/agents/first', payload: { enabled: true } })).statusCode).toBe(401);
  });

  it('starts disabled, excludes terminals, and persists independent choices across reloads', async () => {
    const daemon = await env.start({ config });
    const headers = await authHeader(daemon);
    const get = async () => {
      const response = await daemon.app.inject({ method: 'GET', url: '/api/mcp/agents', headers });
      expect(response.statusCode).toBe(200);
      return NanachiMcpResponseSchema.parse(response.json<unknown>()).agents;
    };
    const change = async (id: string, enabled: boolean) => {
      const response = await daemon.app.inject({ method: 'PUT', url: `/api/mcp/agents/${id}`, headers, payload: { enabled } });
      expect(response.statusCode).toBe(200);
    };
    const initial = await get();
    expect(initial.every((agent) => !agent.enabled)).toBe(true);
    expect(initial.some((agent) => agent.id === 'terminal')).toBe(false);

    await change('first', true);
    await change('second', true);
    await change('first', false);
    expect((await get()).filter((agent) => agent.enabled).map((agent) => agent.id)).toEqual(['second']);
    const reloaded = new NanachiMcpSettings(daemon.home, daemon.config.agents);
    expect(reloaded.isEnabled('first')).toBe(false);
    expect(reloaded.isEnabled('second')).toBe(true);
    expect(JSON.parse(await readFile(join(daemon.home, 'mcp.json'), 'utf8'))).toEqual({ enabledAgents: ['second'] });
  });

  it('rejects unknown agents, terminal agents, and non-boolean choices without enabling anything', async () => {
    const daemon = await env.start({ config });
    const headers = await authHeader(daemon);
    for (const [id, payload, status] of [
      ['unknown', { enabled: true }, 404],
      ['terminal', { enabled: true }, 400],
      ['first', { enabled: 'true' }, 400],
      ['first', {}, 400],
    ] as const) {
      const response = await daemon.app.inject({ method: 'PUT', url: `/api/mcp/agents/${id}`, headers, payload });
      expect(response.statusCode).toBe(status);
    }
    const response = await daemon.app.inject({ method: 'GET', url: '/api/mcp/agents', headers });
    expect(NanachiMcpResponseSchema.parse(response.json<unknown>()).agents.every((agent) => !agent.enabled)).toBe(true);
  });

  it('does not enable an agent in memory when saving its selection fails', async () => {
    const daemon = await env.start({ config });
    await mkdir(join(daemon.home, 'mcp.json'));
    const headers = await authHeader(daemon);
    const failed = await daemon.app.inject({ method: 'PUT', url: '/api/mcp/agents/first', headers, payload: { enabled: true } });
    expect(failed.statusCode).toBe(500);
    const response = await daemon.app.inject({ method: 'GET', url: '/api/mcp/agents', headers });
    expect(NanachiMcpResponseSchema.parse(response.json<unknown>()).agents.find((agent) => agent.id === 'first')?.enabled).toBe(false);
  });
});
