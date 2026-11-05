import { describe, expect, it } from 'vitest';
import {
  AgentSessionSummarySchema,
  AvailableCommandSchema,
  FileInfoSchema,
  SessionConfigOptionSchema,
  SessionEventSchema,
  SessionSchema,
  SessionStatusSchema,
  ToolContentSchema,
  WorkspaceSchema,
} from '../src/index.js';

const workspace = {
  id: 'w-1',
  name: 'app',
  path: 'C:\\projetos\\app',
  createdAt: 1_700_000_000_000,
  muted: false,
};

const selectOption = {
  id: 'model',
  name: 'Modelo',
  description: null,
  category: 'model',
  type: 'select',
  currentValue: 'opus',
  options: [
    { value: 'opus', name: 'Opus', description: 'mais capaz' },
    { value: 'sonnet', name: 'Sonnet' },
  ],
};

const booleanOption = {
  id: 'fast',
  name: 'Fast',
  category: 'model_config',
  type: 'boolean',
  currentValue: false,
};

const session = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'omp',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'idle',
  accountId: null,
  worktree: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
};

const meta = { seq: 1, sessionId: 's-1', ts: 1_700_000_000_000 };

describe('WorkspaceSchema', () => {
  it('aceita workspace válido', () => {
    expect(WorkspaceSchema.parse(workspace)).toEqual(workspace);
  });

  it.each([
    { id: '' },
    { name: '' },
    { path: '' },
    { createdAt: -1 },
    { createdAt: 1.5 },
    { createdAt: '2024' },
    { muted: 'no' },
    { muted: 0 },
  ])('rejeita workspace inválido %j', (patch) => {
    expect(WorkspaceSchema.safeParse({ ...workspace, ...patch }).success).toBe(false);
  });

  it('aceita workspace silenciado', () => {
    expect(WorkspaceSchema.parse({ ...workspace, muted: true }).muted).toBe(true);
  });

  it('rejeita campo ausente', () => {
    const { createdAt: _createdAt, ...withoutCreatedAt } = workspace;
    expect(WorkspaceSchema.safeParse(withoutCreatedAt).success).toBe(false);
  });

  it('rejeita muted ausente (o daemon sempre envia)', () => {
    const { muted: _muted, ...withoutMuted } = workspace;
    expect(WorkspaceSchema.safeParse(withoutMuted).success).toBe(false);
  });
});

describe('FileInfoSchema', () => {
  const file = { fileId: 'f-1', name: 'print.png', mime: 'image/png', size: 2048 };

  it('aceita arquivo válido', () => {
    expect(FileInfoSchema.parse(file)).toEqual(file);
  });

  it('aceita size 0', () => {
    expect(FileInfoSchema.safeParse({ ...file, size: 0 }).success).toBe(true);
  });

  it.each([
    { fileId: '' },
    { name: '' },
    { mime: '' },
    { size: -1 },
    { size: 1.5 },
    { size: '2048' },
  ])('rejeita arquivo inválido %j', (patch) => {
    expect(FileInfoSchema.safeParse({ ...file, ...patch }).success).toBe(false);
  });

  it('rejeita campo ausente', () => {
    const { mime: _mime, ...withoutMime } = file;
    expect(FileInfoSchema.safeParse(withoutMime).success).toBe(false);
  });
});

describe('SessionStatusSchema', () => {
  it.each(['starting', 'idle', 'running', 'awaiting_permission', 'stopped', 'error'])(
    'aceita status %s',
    (status) => {
      expect(SessionStatusSchema.parse(status)).toBe(status);
    },
  );

  it.each(['done', 'ready', '', 'IDLE'])('rejeita status %j', (status) => {
    expect(SessionStatusSchema.safeParse(status).success).toBe(false);
  });
});

describe('SessionConfigOptionSchema', () => {
  it('aceita opção select com description e category', () => {
    expect(SessionConfigOptionSchema.parse(selectOption)).toEqual(selectOption);
  });

  it('aceita opção boolean', () => {
    expect(SessionConfigOptionSchema.parse(booleanOption)).toEqual(booleanOption);
  });

  it('aceita description e category ausentes ou null', () => {
    const minimal = { id: 'mode', name: 'Modo', type: 'select', currentValue: 'default', options: [] };
    expect(SessionConfigOptionSchema.parse(minimal)).toEqual(minimal);
    const nulls = { ...booleanOption, description: null, category: null };
    expect(SessionConfigOptionSchema.parse(nulls)).toEqual(nulls);
  });

  it('aceita option de select sem description', () => {
    expect(
      SessionConfigOptionSchema.safeParse({
        ...selectOption,
        options: [{ value: 'a', name: 'A' }],
      }).success,
    ).toBe(true);
  });

  it('aceita option de select com group (nome do grupo ACP), null ou ausente', () => {
    const options = [
      { value: 'a', name: 'A', group: 'openrouter' },
      { value: 'b', name: 'B', group: null },
      { value: 'c', name: 'C' },
    ];
    expect(SessionConfigOptionSchema.parse({ ...selectOption, options })).toEqual({ ...selectOption, options });
  });

  it('rejeita group vazio na option de select', () => {
    expect(
      SessionConfigOptionSchema.safeParse({
        ...selectOption,
        options: [{ value: 'a', name: 'A', group: '' }],
      }).success,
    ).toBe(false);
  });

  it('rejeita select sem options', () => {
    const { options: _options, ...withoutOptions } = selectOption;
    expect(SessionConfigOptionSchema.safeParse(withoutOptions).success).toBe(false);
  });

  it('rejeita select com currentValue booleano', () => {
    expect(
      SessionConfigOptionSchema.safeParse({ ...selectOption, currentValue: true }).success,
    ).toBe(false);
  });

  it('rejeita boolean com currentValue string', () => {
    expect(
      SessionConfigOptionSchema.safeParse({ ...booleanOption, currentValue: 'on' }).success,
    ).toBe(false);
  });

  it('rejeita option sem value ou sem name', () => {
    expect(
      SessionConfigOptionSchema.safeParse({
        ...selectOption,
        options: [{ name: 'Opus' }],
      }).success,
    ).toBe(false);
    expect(
      SessionConfigOptionSchema.safeParse({
        ...selectOption,
        options: [{ value: 'opus' }],
      }).success,
    ).toBe(false);
  });

  it('rejeita type desconhecido', () => {
    expect(SessionConfigOptionSchema.safeParse({ ...booleanOption, type: 'text' }).success).toBe(
      false,
    );
  });

  it('rejeita id vazio', () => {
    expect(SessionConfigOptionSchema.safeParse({ ...booleanOption, id: '' }).success).toBe(false);
  });
});

describe('SessionSchema', () => {
  it('aceita sessão válida', () => {
    expect(SessionSchema.parse(session)).toEqual(session);
  });

  it('não carrega configOptions: a Session sai sem o campo (as opções vêm por GET /config)', () => {
    const parsed: Record<string, unknown> = SessionSchema.parse({ ...session, configOptions: [selectOption] });
    expect(parsed).not.toHaveProperty('configOptions');
  });

  it('rejeita status fora do enum', () => {
    expect(SessionSchema.safeParse({ ...session, status: 'done' }).success).toBe(false);
  });

  it('rejeita agent vazio', () => {
    expect(SessionSchema.safeParse({ ...session, agent: '' }).success).toBe(false);
  });

  it('rejeita title vazio', () => {
    expect(SessionSchema.safeParse({ ...session, title: '' }).success).toBe(false);
  });

  it('rejeita campo ausente', () => {
    const { updatedAt: _updatedAt, ...withoutUpdatedAt } = session;
    expect(SessionSchema.safeParse(withoutUpdatedAt).success).toBe(false);
  });

  it.each(['acp', 'pty'] as const)('aceita kind %s', (kind) => {
    expect(SessionSchema.parse({ ...session, kind }).kind).toBe(kind);
  });

  it('rejeita kind ausente (o daemon sempre envia)', () => {
    const { kind: _kind, ...withoutKind } = session;
    expect(SessionSchema.safeParse(withoutKind).success).toBe(false);
  });

  it.each(['rpc', '', 'ACP'])('rejeita kind inválido %j', (kind) => {
    expect(SessionSchema.safeParse({ ...session, kind }).success).toBe(false);
  });

  it('aceita sessão em worktree separado (path e branch)', () => {
    const worktree = { path: 'C:\\nanachi\\worktrees\\w-1\\abc123', branch: 'nanachi/abc123' };
    expect(SessionSchema.parse({ ...session, worktree }).worktree).toEqual(worktree);
  });

  it('aceita worktree null (sessão no cwd do workspace)', () => {
    expect(SessionSchema.parse({ ...session, worktree: null }).worktree).toBeNull();
  });

  it('rejeita worktree ausente (o daemon sempre envia, mesmo null)', () => {
    const { worktree: _worktree, ...withoutWorktree } = session;
    expect(SessionSchema.safeParse(withoutWorktree).success).toBe(false);
  });

  it.each([
    { path: '', branch: 'nanachi/abc' },
    { path: 'C:\\wt', branch: '' },
    { path: 'C:\\wt' },
    { branch: 'nanachi/abc' },
    'C:\\wt',
  ])('rejeita worktree inválido %j', (worktree) => {
    expect(SessionSchema.safeParse({ ...session, worktree }).success).toBe(false);
  });
});

describe('ToolContentSchema', () => {
  it('aceita texto', () => {
    expect(ToolContentSchema.parse({ type: 'text', text: 'ok' })).toEqual({
      type: 'text',
      text: 'ok',
    });
  });

  it('aceita diff com oldText null (arquivo novo)', () => {
    const diff = { type: 'diff', path: 'src/a.ts', oldText: null, newText: 'x' };
    expect(ToolContentSchema.parse(diff)).toEqual(diff);
  });

  it('aceita diff com oldText string', () => {
    const diff = { type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' };
    expect(ToolContentSchema.parse(diff)).toEqual(diff);
  });

  it('rejeita diff sem oldText', () => {
    expect(ToolContentSchema.safeParse({ type: 'diff', path: 'a.ts', newText: 'x' }).success).toBe(
      false,
    );
  });

  it('rejeita diff sem newText', () => {
    expect(
      ToolContentSchema.safeParse({ type: 'diff', path: 'a.ts', oldText: null }).success,
    ).toBe(false);
  });

  it('aceita imagem enviada pelo agente (arquivo da sessão)', () => {
    const image = { type: 'image', fileId: 'f-1', mime: 'image/png' };
    expect(ToolContentSchema.parse(image)).toEqual(image);
  });

  it('rejeita imagem sem fileId (o PWA precisa do arquivo para mostrar)', () => {
    expect(ToolContentSchema.safeParse({ type: 'image', mime: 'image/png' }).success).toBe(false);
  });

  it('rejeita tipo desconhecido', () => {
    expect(ToolContentSchema.safeParse({ type: 'audio', fileId: 'f-1', mime: 'audio/wav' }).success).toBe(false);
  });
});

describe('SessionEventSchema', () => {
  const valid: Record<string, unknown>[] = [
    { kind: 'user_message', text: 'oi' },
    {
      kind: 'user_message',
      text: '',
      attachments: [{ fileId: 'f-1', name: 'print.png', mime: 'image/png', size: 10 }],
    },
    { kind: 'user_message', text: 'oi', attachments: [] },
    { kind: 'file', fileId: 'f-2', name: 'a.txt', mime: 'text/plain', size: 3, direction: 'to_phone' },
    {
      kind: 'file',
      fileId: 'f-3',
      name: 'print.png',
      mime: 'image/png',
      size: 99,
      direction: 'to_phone',
      caption: 'tela do erro',
    },
    {
      kind: 'file',
      fileId: 'f-4',
      name: 'log.txt',
      mime: 'text/plain',
      size: 0,
      direction: 'from_phone',
    },
    { kind: 'agent_message_chunk', text: 'olá' },
    { kind: 'agent_thought_chunk', text: 'pensando' },
    {
      kind: 'tool_call',
      toolCallId: 't-1',
      title: 'Editar a.ts',
      toolKind: 'edit',
      status: 'pending',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'a', newText: 'b' }],
      locations: ['a.ts'],
    },
    { kind: 'tool_call', toolCallId: 't-2', title: 'Ler', content: [], locations: [] },
    { kind: 'tool_call_update', toolCallId: 't-1' },
    {
      kind: 'tool_call_update',
      toolCallId: 't-1',
      title: 'Editar a.ts',
      status: 'completed',
      content: [{ type: 'text', text: 'feito' }],
    },
    {
      kind: 'plan',
      entries: [{ content: 'passo 1', status: 'in_progress', priority: 'high' }],
    },
    {
      kind: 'permission_request',
      requestId: 'r-1',
      title: 'Rodar npm test',
      content: [],
      options: [
        { optionId: 'allow', name: 'Permitir', kind: 'allow_once' },
        { optionId: 'reject', name: 'Recusar', kind: 'reject_once' },
      ],
    },
    {
      kind: 'permission_request',
      requestId: 'r-2',
      title: 'Rodar comando',
      toolKind: 'execute',
      rawInput: { command: 'ls' },
      content: [{ type: 'text', text: 'ls' }],
      options: [{ optionId: 'always', name: 'Sempre', kind: 'allow_always' }],
    },
    { kind: 'permission_resolved', requestId: 'r-1', optionId: 'allow' },
    { kind: 'permission_resolved', requestId: 'r-1', optionId: null },
    { kind: 'turn_end', stopReason: 'end_turn' },
    { kind: 'status', status: 'running' },
    { kind: 'error', message: 'falhou' },
  ];

  it.each(valid)('aceita evento válido de kind %j', (body) => {
    const event = { ...meta, ...body };
    expect(SessionEventSchema.parse(event)).toEqual(event);
  });

  it('aceita rawInput com qualquer valor (z.unknown)', () => {
    for (const rawInput of [null, 42, 'texto', [1, 2], { a: { b: true } }]) {
      const event = {
        ...meta,
        kind: 'permission_request',
        requestId: 'r-1',
        title: 'x',
        rawInput,
        content: [],
        options: [],
      };
      expect(SessionEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('rejeita attachment de user_message sem fileId', () => {
    expect(
      SessionEventSchema.safeParse({
        ...meta,
        kind: 'user_message',
        text: 'oi',
        attachments: [{ name: 'a.txt', mime: 'text/plain', size: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejeita file com direction fora do enum', () => {
    expect(
      SessionEventSchema.safeParse({
        ...meta,
        kind: 'file',
        fileId: 'f-1',
        name: 'a.txt',
        mime: 'text/plain',
        size: 1,
        direction: 'both',
      }).success,
    ).toBe(false);
  });

  it('rejeita file sem size', () => {
    expect(
      SessionEventSchema.safeParse({
        ...meta,
        kind: 'file',
        fileId: 'f-1',
        name: 'a.txt',
        mime: 'text/plain',
        direction: 'to_phone',
      }).success,
    ).toBe(false);
  });

  it('rejeita evento com kind desconhecido', () => {
    expect(SessionEventSchema.safeParse({ ...meta, kind: 'telepathy', text: 'x' }).success).toBe(
      false,
    );
  });

  it('rejeita evento sem kind', () => {
    expect(SessionEventSchema.safeParse({ ...meta, text: 'x' }).success).toBe(false);
  });

  it.each([
    { seq: 0 },
    { seq: 1.5 },
    { seq: -3 },
    { sessionId: '' },
    { ts: -1 },
    { ts: '2024' },
  ])('rejeita metadados inválidos %j', (patch) => {
    expect(
      SessionEventSchema.safeParse({ ...meta, ...patch, kind: 'user_message', text: 'oi' }).success,
    ).toBe(false);
  });

  it('rejeita seq ausente', () => {
    expect(
      SessionEventSchema.safeParse({ sessionId: 's-1', ts: 1, kind: 'user_message', text: 'oi' })
        .success,
    ).toBe(false);
  });

  it('rejeita chunk sem text', () => {
    expect(SessionEventSchema.safeParse({ ...meta, kind: 'agent_message_chunk' }).success).toBe(
      false,
    );
  });

  it('rejeita status de tool_call fora do enum do ACP', () => {
    expect(
      SessionEventSchema.safeParse({
        ...meta,
        kind: 'tool_call',
        toolCallId: 't-1',
        title: 'x',
        status: 'done',
        content: [],
        locations: [],
      }).success,
    ).toBe(false);
  });

  it('rejeita priority de plano fora do enum', () => {
    expect(
      SessionEventSchema.safeParse({
        ...meta,
        kind: 'plan',
        entries: [{ content: 'x', status: 'pending', priority: 'urgent' }],
      }).success,
    ).toBe(false);
  });

  it('rejeita option de permissão com kind inválido', () => {
    expect(
      SessionEventSchema.safeParse({
        ...meta,
        kind: 'permission_request',
        requestId: 'r-1',
        title: 'x',
        content: [],
        options: [{ optionId: 'a', name: 'A', kind: 'maybe' }],
      }).success,
    ).toBe(false);
  });

  it('rejeita permission_request sem options', () => {
    expect(
      SessionEventSchema.safeParse({
        ...meta,
        kind: 'permission_request',
        requestId: 'r-1',
        title: 'x',
        content: [],
      }).success,
    ).toBe(false);
  });

  it('rejeita permission_resolved sem optionId (usa null para cancelar)', () => {
    expect(
      SessionEventSchema.safeParse({ ...meta, kind: 'permission_resolved', requestId: 'r-1' })
        .success,
    ).toBe(false);
  });

  it('rejeita status de evento fora do enum de sessão', () => {
    expect(SessionEventSchema.safeParse({ ...meta, kind: 'status', status: 'done' }).success).toBe(
      false,
    );
  });

  it('rejeita error sem message', () => {
    expect(SessionEventSchema.safeParse({ ...meta, kind: 'error' }).success).toBe(false);
  });

  describe('terminal', () => {
    it('aceita terminal_output com data (ANSI incluso)', () => {
      const event = { ...meta, kind: 'terminal_output', data: '\u001b[32mok\u001b[0m\r\n' };
      expect(SessionEventSchema.parse(event)).toEqual(event);
    });

    it('aceita terminal_output com data vazio', () => {
      expect(
        SessionEventSchema.safeParse({ ...meta, kind: 'terminal_output', data: '' }).success,
      ).toBe(true);
    });

    it('rejeita terminal_output sem data', () => {
      expect(SessionEventSchema.safeParse({ ...meta, kind: 'terminal_output' }).success).toBe(false);
    });

    it('aceita terminal_exit com exitCode inteiro ou null (morto por sinal)', () => {
      expect(
        SessionEventSchema.safeParse({ ...meta, kind: 'terminal_exit', exitCode: 0 }).success,
      ).toBe(true);
      expect(
        SessionEventSchema.safeParse({ ...meta, kind: 'terminal_exit', exitCode: null }).success,
      ).toBe(true);
    });

    it('rejeita terminal_exit sem exitCode ou com exitCode fracionário', () => {
      expect(SessionEventSchema.safeParse({ ...meta, kind: 'terminal_exit' }).success).toBe(false);
      expect(
        SessionEventSchema.safeParse({ ...meta, kind: 'terminal_exit', exitCode: 1.5 }).success,
      ).toBe(false);
    });
  });
});

describe('AvailableCommandSchema', () => {
  it('aceita comando com dica de argumento ou com hint null', () => {
    const withHint = { name: 'loop', description: 'Repete um prompt', hint: '[intervalo] [prompt]' };
    expect(AvailableCommandSchema.parse(withHint)).toEqual(withHint);
    expect(AvailableCommandSchema.parse({ ...withHint, hint: null }).hint).toBeNull();
  });

  it('rejeita nome vazio e campos faltando', () => {
    expect(AvailableCommandSchema.safeParse({ name: '', description: 'x', hint: null }).success).toBe(false);
    expect(AvailableCommandSchema.safeParse({ name: 'mcp', hint: null }).success).toBe(false);
  });
});

describe('SessionSchema sem commands', () => {
  it('a lista de comandos não faz parte da Session (sai no parse; vem por GET /api/sessions/:id/commands)', () => {
    const commands = [{ name: 'mcp', description: 'Servidores MCP', hint: null }];
    expect(SessionSchema.parse({ ...session, commands })).not.toHaveProperty('commands');
  });
});

describe('AgentSessionSummarySchema', () => {
  it('aceita sessão listada pelo agente, com ou sem vínculo no app', () => {
    const listed = { acpSessionId: 'sess-1', title: 'Parser', updatedAt: 1_700_000_000_000, linkedSessionId: null };
    expect(AgentSessionSummarySchema.parse(listed)).toEqual(listed);
    expect(AgentSessionSummarySchema.parse({ ...listed, linkedSessionId: 's-1' }).linkedSessionId).toBe('s-1');
  });

  it('rejeita acpSessionId vazio e updatedAt negativo', () => {
    expect(
      AgentSessionSummarySchema.safeParse({ acpSessionId: '', title: null, updatedAt: null, linkedSessionId: null })
        .success,
    ).toBe(false);
    expect(
      AgentSessionSummarySchema.safeParse({ acpSessionId: 'a', title: null, updatedAt: -1, linkedSessionId: null })
        .success,
    ).toBe(false);
  });
});

describe('SessionEventSchema: subagentes e segundo plano (tool_call)', () => {
  const toolCall = {
    ...meta,
    kind: 'tool_call',
    toolCallId: 'call-1',
    title: 'Agent',
    content: [],
    locations: [],
  };

  it('evento antigo, sem os campos novos, continua válido e sem eles', () => {
    expect(SessionEventSchema.parse(toolCall)).toEqual(toolCall);
    const update = { ...meta, kind: 'tool_call_update', toolCallId: 'call-1', status: 'completed' };
    expect(SessionEventSchema.parse(update)).toEqual(update);
  });

  it('aceita parentToolCallId, toolName e background de subagente com jobs', () => {
    const event = {
      ...toolCall,
      parentToolCallId: 'parent-1',
      toolName: 'Agent',
      background: {
        kind: 'subagent',
        state: 'running',
        label: 'Revisar o parser',
        agentType: 'Explore',
        jobs: [{ id: 'thread-1', label: 'spawnAgent', status: 'running' }],
      },
    };
    expect(SessionEventSchema.parse(event)).toEqual(event);
  });

  it('aceita background de shell e de job sem label, agentType nem jobs', () => {
    expect(
      SessionEventSchema.safeParse({ ...toolCall, background: { kind: 'shell', state: 'running' } }).success,
    ).toBe(true);
    expect(
      SessionEventSchema.safeParse({ ...toolCall, background: { kind: 'job', state: 'completed', jobs: [] } }).success,
    ).toBe(true);
  });

  it('aceita tool_call_update com background', () => {
    const event = {
      ...meta,
      kind: 'tool_call_update',
      toolCallId: 'call-1',
      background: { kind: 'subagent', state: 'completed' },
    };
    expect(SessionEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    ['kind desconhecido', { kind: 'nope' }],
    ['state desconhecido', { background: { kind: 'subagent', state: 'done' } }],
    ['kind de background desconhecido', { background: { kind: 'thread', state: 'running' } }],
    ['label vazio', { background: { kind: 'shell', state: 'running', label: '' } }],
    ['label acima de 200 caracteres', { background: { kind: 'shell', state: 'running', label: 'x'.repeat(201) } }],
    ['mais de 50 jobs', { background: { kind: 'job', state: 'running', jobs: Array.from({ length: 51 }, (_, i) => ({ id: `j${i}`, status: 'running' })) } }],
    ['job sem id', { background: { kind: 'job', state: 'running', jobs: [{ status: 'running' }] } }],
    ['toolName vazio', { toolName: '' }],
    ['parentToolCallId vazio', { parentToolCallId: '' }],
  ])('rejeita %s', (_label, patch) => {
    expect(SessionEventSchema.safeParse({ ...toolCall, ...patch }).success).toBe(false);
  });
});

describe('SessionSchema.accountId e o evento account_changed', () => {
  it('accountId ausente vira null (principal); string não vazia é aceita', () => {
    const { accountId: _ignored, ...withoutAccount } = { ...session, accountId: null };
    expect(SessionSchema.parse(withoutAccount).accountId).toBeNull();
    expect(SessionSchema.parse({ ...session, accountId: 'a1' }).accountId).toBe('a1');
  });

  it('recusa accountId vazio', () => {
    expect(SessionSchema.safeParse({ ...session, accountId: '' }).success).toBe(false);
  });

  it('account_changed aceita conta nova (id e label) e volta ao principal (id null)', () => {
    const changed = { ...meta, kind: 'account_changed', accountId: 'a1', label: 'Trabalho' };
    expect(SessionEventSchema.parse(changed)).toEqual(changed);
    const principal = { ...meta, kind: 'account_changed', accountId: null, label: 'Principal' };
    expect(SessionEventSchema.parse(principal)).toEqual(principal);
  });

  it('account_changed recusa label vazio ou campo ausente', () => {
    expect(SessionEventSchema.safeParse({ ...meta, kind: 'account_changed', accountId: null, label: '' }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ ...meta, kind: 'account_changed', label: 'Trabalho' }).success).toBe(false);
  });
});
