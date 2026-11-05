import { describe, expect, it } from 'vitest';
import { trackToolCall, type KnownToolCall, type ToolFacts } from '../src/tool-background.js';

/** Fatos de um tool call sintético; cada teste sobrescreve só o que importa. */
function facts(patch: Partial<ToolFacts>): ToolFacts {
  return { meta: undefined, title: null, status: null, rawInput: undefined, rawOutput: undefined, texts: [], ...patch };
}

const CLAUDE_AGENT_META = { claudeCode: { toolName: 'Agent' } };
const CLAUDE_BASH_META = { claudeCode: { toolName: 'Bash' } };

describe('trackToolCall: subagente do Claude (Agent / Task)', () => {
  const start = facts({
    meta: CLAUDE_AGENT_META,
    title: 'Agent',
    status: 'pending',
    rawInput: {
      description: '  Revisar o parser  ',
      subagent_type: 'Explore',
      run_in_background: false,
      prompt: 'texto longo do prompt que nunca deve ser guardado',
    },
  });

  it('chamada nova: subagent running, com label e agentType do rawInput; o prompt não entra', () => {
    const tracked = trackToolCall(start, undefined);
    expect(tracked).toEqual({
      toolName: 'Agent',
      background: { kind: 'subagent', state: 'running', label: 'Revisar o parser', agentType: 'Explore' },
    });
  });

  it('Task conta como subagente', () => {
    const tracked = trackToolCall(
      facts({ meta: { claudeCode: { toolName: 'Task' } }, status: 'pending', rawInput: { description: 'Lint' } }),
      undefined,
    );
    expect(tracked.background).toEqual({ kind: 'subagent', state: 'running', label: 'Lint' });
  });

  it('descrição vazia ou só espaços sai do label', () => {
    const tracked = trackToolCall(
      facts({ meta: CLAUDE_AGENT_META, status: 'pending', rawInput: { description: '   ' } }),
      undefined,
    );
    expect(tracked.background).toEqual({ kind: 'subagent', state: 'running' });
  });

  it('completed sem texto de async: completed, mantendo label e agentType já conhecidos', () => {
    const known = trackToolCall(start, undefined);
    const done = trackToolCall(facts({ status: 'completed', texts: ['Relatório pronto.'] }), known);
    expect(done.background).toEqual({ kind: 'subagent', state: 'completed', label: 'Revisar o parser', agentType: 'Explore' });
    expect(done.toolName).toBe('Agent');
  });

  it('completed com "Async agent launched" continua running (o fim real não chega ao cliente)', () => {
    const known = trackToolCall(start, undefined);
    const launched = trackToolCall(
      facts({ status: 'completed', texts: ['Async agent launched successfully. agentId: a-1'] }),
      known,
    );
    expect(launched.background?.state).toBe('running');
  });

  it('failed: state failed', () => {
    const known = trackToolCall(start, undefined);
    expect(trackToolCall(facts({ status: 'failed' }), known).background?.state).toBe('failed');
  });

  it('update sem status mantém o state já conhecido', () => {
    const known = trackToolCall(start, undefined);
    expect(trackToolCall(facts({ texts: ['progresso'] }), known).background?.state).toBe('running');
  });

  it('chamada filha leva parentToolCallId; ferramenta comum filha não vira background', () => {
    const child = trackToolCall(
      facts({ meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'agent-1' } }, status: 'completed' }),
      undefined,
    );
    expect(child).toEqual({ toolName: 'Read', parentToolCallId: 'agent-1' });
  });

  it('nome da ferramenta vem da memória quando o update não o informa', () => {
    const known: KnownToolCall = { toolName: 'Agent', background: { kind: 'subagent', state: 'running' } };
    expect(trackToolCall(facts({ meta: undefined, status: 'completed' }), known).toolName).toBe('Agent');
  });
});

describe('trackToolCall: Bash em segundo plano (Claude)', () => {
  const launch = facts({
    meta: CLAUDE_BASH_META,
    title: 'Bash',
    status: 'pending',
    rawInput: { command: 'npm run dev', description: 'Servidor de dev', run_in_background: true },
  });

  it('run_in_background: shell running com a descrição como label; o comando não entra', () => {
    expect(trackToolCall(launch, undefined)).toEqual({
      toolName: 'Bash',
      background: { kind: 'shell', state: 'running', label: 'Servidor de dev' },
    });
  });

  it('resultado com "running in background" sem o flag: shell running, sem label', () => {
    const tracked = trackToolCall(
      facts({
        meta: CLAUDE_BASH_META,
        status: 'completed',
        texts: ['Command running in background with ID: bg-1. Output is being written to: C:\\tmp\\out-1.txt'],
      }),
      undefined,
    );
    expect(tracked.background).toEqual({ kind: 'shell', state: 'running' });
  });

  it('update completed sem texto, com shell já conhecido: continua running com o label', () => {
    const known = trackToolCall(launch, undefined);
    const tracked = trackToolCall(facts({ status: 'completed' }), known);
    expect(tracked.background).toEqual({ kind: 'shell', state: 'running', label: 'Servidor de dev' });
  });

  it('failed: state failed', () => {
    const known = trackToolCall(launch, undefined);
    expect(trackToolCall(facts({ status: 'failed' }), known).background?.state).toBe('failed');
  });

  it('Bash comum (sem flag, sem texto de background) não tem background', () => {
    const tracked = trackToolCall(
      facts({ meta: CLAUDE_BASH_META, status: 'completed', rawInput: { command: 'dir' }, texts: ['listado'] }),
      undefined,
    );
    expect(tracked).toEqual({ toolName: 'Bash' });
  });
});

describe('trackToolCall: subagentes do Codex', () => {
  const spawn = (status: ToolFacts['status'], agentsStates: Record<string, { status: string }>): ToolFacts =>
    facts({
      title: 'spawnAgent',
      status,
      rawInput: { receiverThreadIds: Object.keys(agentsStates), agentsStates },
    });

  it('spawnAgent em andamento: subagent running, com um job por receiver', () => {
    expect(trackToolCall(spawn('pending', { 'thread-1': { status: 'pendingInit' } }), undefined).background).toEqual({
      kind: 'subagent',
      state: 'running',
      label: 'spawnAgent',
      jobs: [{ id: 'thread-1', status: 'pendingInit' }],
    });
  });

  it('spawnAgent completed com o filho ainda running: continua running', () => {
    const tracked = trackToolCall(spawn('completed', { 'thread-1': { status: 'running' } }), undefined);
    expect(tracked.background?.state).toBe('running');
  });

  it('wait completed com um filho errored: failed', () => {
    const tracked = trackToolCall(
      facts({
        title: 'wait',
        status: 'completed',
        rawInput: {
          receiverThreadIds: ['t1', 't2'],
          agentsStates: { t1: { status: 'completed' }, t2: { status: 'errored' } },
        },
      }),
      undefined,
    );
    expect(tracked.background).toEqual({
      kind: 'subagent',
      state: 'failed',
      label: 'wait',
      jobs: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'errored' },
      ],
    });
  });

  it('wait completed com todos interrompidos: stopped', () => {
    const tracked = trackToolCall(
      spawn('completed', { 'thread-1': { status: 'interrupted' }, 'thread-2': { status: 'shutdown' } }),
      undefined,
    );
    expect(tracked.background?.state).toBe('stopped');
  });

  it('wait completed com todos concluídos: completed', () => {
    expect(trackToolCall(spawn('completed', { 'thread-1': { status: 'completed' } }), undefined).background?.state).toBe(
      'completed',
    );
  });

  it('receiver sem status em agentsStates vira unknown e não conta como running', () => {
    const tracked = trackToolCall(
      facts({ title: 'sendInput', status: 'completed', rawInput: { receiverThreadIds: ['t9'] } }),
      undefined,
    );
    expect(tracked.background).toEqual({
      kind: 'subagent',
      state: 'completed',
      label: 'sendInput',
      jobs: [{ id: 't9', status: 'unknown' }],
    });
  });

  it('followupTask é subagente mesmo sem receivers no rawInput', () => {
    expect(trackToolCall(facts({ title: 'followupTask', status: 'pending' }), undefined).background).toEqual({
      kind: 'subagent',
      state: 'running',
      label: 'followupTask',
    });
  });

  it('wait sem receivers nem agentsStates não é do Codex (fica sem background)', () => {
    expect(trackToolCall(facts({ title: 'wait', status: 'pending', rawInput: { ids: ['x'] } }), undefined)).toEqual({});
  });
});

describe('trackToolCall: jobs do omp', () => {
  it('task (rawInput.tasks) em andamento: job running com o título como label', () => {
    expect(
      trackToolCall(facts({ title: 'task', status: 'pending', rawInput: { tasks: [{ description: 'x' }] } }), undefined)
        .background,
    ).toEqual({ kind: 'job', state: 'running', label: 'task' });
  });

  it('task completed com details.async running: job com o jobId, state running', () => {
    const tracked = trackToolCall(
      facts({
        title: 'task',
        status: 'completed',
        rawInput: { tasks: [] },
        rawOutput: { details: { async: { jobId: 'job-1', state: 'running', type: 'task' } } },
      }),
      undefined,
    );
    expect(tracked.background).toEqual({
      kind: 'job',
      state: 'running',
      label: 'task',
      jobs: [{ id: 'job-1', status: 'running' }],
    });
  });

  it('progress com um job ainda running: state running; label do job vem da tarefa', () => {
    const tracked = trackToolCall(
      facts({
        title: 'task',
        status: 'completed',
        rawOutput: {
          details: {
            progress: [
              { id: '0-Explore', agent: 'explore', status: 'completed', task: 'Ler o parser', toolCount: 4 },
              { id: '1-Impl', agent: 'task', status: 'running', task: 'Ajustar o teste' },
            ],
          },
        },
      }),
      undefined,
    );
    expect(tracked.background).toEqual({
      kind: 'job',
      state: 'running',
      label: 'task',
      jobs: [
        { id: '0-Explore', label: 'Ler o parser', status: 'completed' },
        { id: '1-Impl', label: 'Ajustar o teste', status: 'running' },
      ],
    });
  });

  it('results sem status: job completed', () => {
    const tracked = trackToolCall(
      facts({ title: 'task', status: 'completed', rawOutput: { details: { results: [{ id: '0-Explore' }] } } }),
      undefined,
    );
    expect(tracked.background).toEqual({
      kind: 'job',
      state: 'completed',
      label: 'task',
      jobs: [{ id: '0-Explore', status: 'completed' }],
    });
  });

  it('wait (details.jobs) só leva id e status; resultText não entra', () => {
    const tracked = trackToolCall(
      facts({
        title: 'wait',
        status: 'completed',
        rawOutput: { details: { jobs: [{ id: 'job-1', status: 'completed', resultText: 'segredo do resultado' }] } },
      }),
      undefined,
    );
    expect(tracked.background).toEqual({
      kind: 'job',
      state: 'completed',
      label: 'wait',
      jobs: [{ id: 'job-1', status: 'completed' }],
    });
  });

  it('job async que falhou: state failed mesmo com a chamada completed', () => {
    const tracked = trackToolCall(
      facts({ title: 'task', status: 'completed', rawOutput: { details: { async: { jobId: 'job-2', state: 'failed' } } } }),
      undefined,
    );
    expect(tracked.background?.state).toBe('failed');
  });

  it('update seguinte junta jobs pelo id: o status novo vence e jobs novos entram', () => {
    const known = trackToolCall(facts({ title: 'task', status: 'pending', rawInput: { tasks: [] } }), undefined);
    const first = trackToolCall(
      facts({ title: 'task', status: 'completed', rawOutput: { details: { progress: [{ id: 'j1', status: 'running' }] } } }),
      known,
    );
    const second = trackToolCall(
      facts({
        title: 'task',
        status: 'completed',
        rawOutput: {
          details: { progress: [{ id: 'j1', status: 'completed' }, { id: 'j2', status: 'completed' }] },
        },
      }),
      first.background === undefined ? undefined : { background: first.background },
    );
    expect(second.background).toEqual({
      kind: 'job',
      state: 'completed',
      label: 'task',
      jobs: [
        { id: 'j1', status: 'completed' },
        { id: 'j2', status: 'completed' },
      ],
    });
  });

  it('status fora da tabela (ex.: "paused") conta como unknown: a chamada completed não vira running', () => {
    const tracked = trackToolCall(
      facts({ title: 'task', status: 'completed', rawOutput: { details: { progress: [{ id: 'j1', status: 'paused' }] } } }),
      undefined,
    );
    expect(tracked.background).toEqual({
      kind: 'job',
      state: 'completed',
      label: 'task',
      jobs: [{ id: 'j1', status: 'paused' }],
    });
  });
});

describe('trackToolCall: limites', () => {
  it('label cortado em 200 pontos de código (sem quebrar emoji)', () => {
    const title = '😀'.repeat(300);
    const tracked = trackToolCall(facts({ title, status: 'pending', rawInput: { tasks: [] } }), undefined);
    expect(tracked.background?.label).toBe('😀'.repeat(200));
  });

  it('descrição do Claude também é cortada', () => {
    const tracked = trackToolCall(
      facts({ meta: CLAUDE_AGENT_META, status: 'pending', rawInput: { description: 'a'.repeat(500) } }),
      undefined,
    );
    expect(tracked.background?.label).toBe('a'.repeat(200));
  });

  it('no máximo 50 jobs; os primeiros 50 ficam', () => {
    const progress = Array.from({ length: 60 }, (_, i) => ({ id: `j${i}`, status: 'running' }));
    const tracked = trackToolCall(facts({ title: 'task', status: 'pending', rawOutput: { details: { progress } } }), undefined);
    const jobs = tracked.background?.jobs ?? [];
    expect(jobs).toHaveLength(50);
    expect(jobs[0]?.id).toBe('j0');
    expect(jobs[49]?.id).toBe('j49');
  });

  it('status de job acima de 40 caracteres vira unknown (não quebra o evento)', () => {
    const tracked = trackToolCall(
      facts({ title: 'task', status: 'pending', rawOutput: { details: { progress: [{ id: 'j1', status: 'x'.repeat(41) }] } } }),
      undefined,
    );
    expect(tracked.background?.jobs).toEqual([{ id: 'j1', status: 'unknown' }]);
  });
});

describe('trackToolCall: ferramenta comum', () => {
  it('sem _meta e sem sinais de segundo plano: resultado vazio', () => {
    expect(trackToolCall(facts({ title: 'Read', status: 'completed', rawInput: { path: 'a.txt' } }), undefined)).toEqual({});
  });
});
