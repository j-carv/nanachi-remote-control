import { join } from 'node:path';
import { DEFAULT_AGENTS } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { agentBinDirs, withPathPrepended } from '../src/agent-path.js';
import { resolveAgentCommand } from '../src/agent-command.js';

describe('agentes default', () => {
  it('codex-acp (dependência do daemon) resolve pelo PATH que o daemon prepende aos agentes', () => {
    const codex = DEFAULT_AGENTS.codex;
    expect(codex).toMatchObject({ command: 'codex-acp', kind: 'acp' });
    if (codex === undefined) throw new Error('codex ausente nos defaults');

    const env = withPathPrepended({ ...process.env }, agentBinDirs());
    const resolved = resolveAgentCommand(codex.command, codex.args, env);

    expect(resolved.file).toContain(join('node_modules', '.bin', 'codex-acp'));
  });

  it('antigravity roda por ACP (agy acp) e Oh My Pi continua ACP', () => {
    expect(DEFAULT_AGENTS.agy).toMatchObject({ command: 'agy', args: ['acp'], kind: 'acp' });
    expect(DEFAULT_AGENTS.omp).toMatchObject({ command: 'omp', kind: 'acp' });
  });
});
