import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NanachiMcpSettingsSchema, type AgentConfig, type NanachiMcpResponse } from '@nanachi/shared';
import { ApiError } from './api-error.js';

/** Session-scoped MCP opt-ins. No agent configuration files or session credentials are persisted here. */
export class NanachiMcpSettings {
  private readonly file: string;
  private enabled: Set<string>;

  constructor(home: string, private readonly agents: Readonly<Record<string, AgentConfig>>) {
    this.file = join(home, 'mcp.json');
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parsed = NanachiMcpSettingsSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid Nanachi MCP settings in mcp.json');
    this.enabled = new Set(parsed.data.enabledAgents);
  }

  isEnabled(agentId: string): boolean {
    return this.agents[agentId]?.kind === 'acp' && this.enabled.has(agentId);
  }

  list(): NanachiMcpResponse {
    return {
      agents: Object.entries(this.agents)
        .filter(([, agent]) => agent.kind === 'acp')
        .map(([id, agent]) => ({ id, label: agent.label, enabled: this.isEnabled(id) })),
    };
  }

  set(agentId: string, enabled: boolean): NanachiMcpResponse {
    const agent = this.agents[agentId];
    if (agent === undefined) throw new ApiError(404, 'not_found', 'Unknown MCP agent');
    if (agent.kind !== 'acp') throw new ApiError(400, 'invalid_request', 'MCP requires an ACP agent');
    if (this.enabled.has(agentId) === enabled) return this.list();

    const next = new Set(this.enabled);
    if (enabled) next.add(agentId);
    else next.delete(agentId);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ enabledAgents: [...next] }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
    // Failed writes must not change the live selection or report success to the caller.
    this.enabled = next;
    return this.list();
  }
}
