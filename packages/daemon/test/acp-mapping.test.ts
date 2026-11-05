import type * as acp from '@agentclientprotocol/sdk';
import { SessionEventSchema, type FileInfo } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import {
  availableCommandsOf,
  flattenConfigOptions,
  isPromptImage,
  isSlashCommand,
  listedUpdatedAt,
  modeConfigOption,
  newestFirst,
  PHONE_SEND_HINT,
  promptBlocks,
  restoreMethodOf,
  sameWorkingDirectory,
  sessionUpdateToDraft,
  titleFromPrompt,
  type ImageSink,
} from '../src/acp-mapping.js';
import type { ToolCallMemory } from '../src/tool-background.js';

function validate(draft: Record<string, unknown>) {
  return SessionEventSchema.safeParse({ ...draft, seq: 1, sessionId: 's', ts: 1 });
}

describe('sessionUpdateToDraft', () => {
  it('chunks de texto viram eventos; chunk que não é texto é ignorado', () => {
    expect(
      sessionUpdateToDraft({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'oi' },
      }),
    ).toEqual({ kind: 'agent_message_chunk', text: 'oi' });

    expect(
      sessionUpdateToDraft({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'pensando' },
      }),
    ).toEqual({ kind: 'agent_thought_chunk', text: 'pensando' });

    expect(
      sessionUpdateToDraft({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      }),
    ).toBeUndefined();
  });

  it('tool_call: kind vira toolKind, locations viram paths, diff é preservado', () => {
    const draft = sessionUpdateToDraft({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Editar a.txt',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'C:\\proj\\a.txt' }],
      content: [
        { type: 'content', content: { type: 'text', text: 'lendo' } },
        { type: 'diff', path: 'C:\\proj\\a.txt', oldText: null, newText: 'novo' },
        { type: 'terminal', terminalId: 't1' },
      ],
    });

    expect(draft).toEqual({
      kind: 'tool_call',
      toolCallId: 'call-1',
      title: 'Editar a.txt',
      toolKind: 'edit',
      status: 'pending',
      content: [
        { type: 'text', text: 'lendo' },
        { type: 'diff', path: 'C:\\proj\\a.txt', oldText: null, newText: 'novo' },
      ],
      locations: ['C:\\proj\\a.txt'],
    });
    expect(validate(draft as Record<string, unknown>).success).toBe(true);
  });

  it('tool_call com status desconhecido omite o campo', () => {
    const draft = sessionUpdateToDraft({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-2',
      title: 'Algo',
      status: 'weird' as acp.ToolCallStatus,
    });

    expect(draft).toEqual({
      kind: 'tool_call',
      toolCallId: 'call-2',
      title: 'Algo',
      content: [],
      locations: [],
    });
  });

  it('tool_call_update: campos ausentes ou null ficam de fora', () => {
    expect(
      sessionUpdateToDraft({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }),
    ).toEqual({ kind: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });

    expect(
      sessionUpdateToDraft({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        title: null,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'erro' } }],
      }),
    ).toEqual({
      kind: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'failed',
      content: [{ type: 'text', text: 'erro' }],
    });
  });

  it('plan mapeia entradas', () => {
    expect(
      sessionUpdateToDraft({
        sessionUpdate: 'plan',
        entries: [{ content: 'passo 1', status: 'in_progress', priority: 'high' }],
      }),
    ).toEqual({
      kind: 'plan',
      entries: [{ content: 'passo 1', status: 'in_progress', priority: 'high' }],
    });
  });

  it('demais updates (ex.: available_commands_update, user_message_chunk) são ignorados', () => {
    expect(sessionUpdateToDraft({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toBeUndefined();
    expect(
      sessionUpdateToDraft({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } }),
    ).toBeUndefined();
  });
});

/** Sink de teste: grava qualquer bloco de imagem como um arquivo fixo e devolve o registro. */
const FILE: FileInfo = { fileId: 'f-1', name: 'imagem-1.png', mime: 'image/png', size: 3 };
const savingSink = (seen: acp.ContentBlock[]): ImageSink => (block) => {
  seen.push(block);
  return FILE;
};
const IMAGE_BLOCK: acp.ContentBlock = { type: 'image', data: 'QUJD', mimeType: 'image/png' };

describe('sessionUpdateToDraft com imagens do agente', () => {
  it('imagem em agent_message_chunk vira evento file (to_phone, sem legenda)', () => {
    const seen: acp.ContentBlock[] = [];
    const draft = sessionUpdateToDraft(
      { sessionUpdate: 'agent_message_chunk', content: IMAGE_BLOCK },
      savingSink(seen),
    );

    expect(seen).toEqual([IMAGE_BLOCK]);
    expect(draft).toEqual({ kind: 'file', fileId: 'f-1', name: 'imagem-1.png', mime: 'image/png', size: 3, direction: 'to_phone' });
    expect(validate(draft as Record<string, unknown>).success).toBe(true);
  });

  it('imagem em agent_thought_chunk também vira evento file', () => {
    const draft = sessionUpdateToDraft({ sessionUpdate: 'agent_thought_chunk', content: IMAGE_BLOCK }, savingSink([]));
    expect(draft).toMatchObject({ kind: 'file', fileId: 'f-1', direction: 'to_phone' });
  });

  it('sem sink (ou sink que recusa) a imagem é ignorada, como antes', () => {
    expect(sessionUpdateToDraft({ sessionUpdate: 'agent_message_chunk', content: IMAGE_BLOCK })).toBeUndefined();
    const refuse: ImageSink = () => undefined;
    expect(sessionUpdateToDraft({ sessionUpdate: 'agent_message_chunk', content: IMAGE_BLOCK }, refuse)).toBeUndefined();
  });

  it('tool_call: imagem vira ToolContent image com o fileId; texto e diff continuam', () => {
    const draft = sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Ler teste.png',
        content: [
          { type: 'content', content: { type: 'text', text: 'ok' } },
          { type: 'content', content: IMAGE_BLOCK },
        ],
      },
      savingSink([]),
    );
    expect(draft).toMatchObject({
      kind: 'tool_call',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', fileId: 'f-1', mime: 'image/png' },
      ],
    });
  });

  it('tool_call_update: imagem em content vira ToolContent image', () => {
    const draft = sessionUpdateToDraft(
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', content: [{ type: 'content', content: IMAGE_BLOCK }] },
      savingSink([]),
    );
    expect(draft).toEqual({
      kind: 'tool_call_update',
      toolCallId: 'call-1',
      content: [{ type: 'image', fileId: 'f-1', mime: 'image/png' }],
    });
  });

  it('resource_link e resource vão ao sink (que decide se são imagem de arquivo permitido)', () => {
    const link: acp.ContentBlock = { type: 'resource_link', name: 'a.png', uri: 'file:///C:/x/a.png', mimeType: 'image/png' };
    const embedded: acp.ContentBlock = {
      type: 'resource',
      resource: { uri: 'file:///C:/x/b.png', mimeType: 'image/png', blob: 'QUJD' },
    };
    const seen: acp.ContentBlock[] = [];
    sessionUpdateToDraft({ sessionUpdate: 'agent_message_chunk', content: link }, savingSink(seen));
    sessionUpdateToDraft(
      { sessionUpdate: 'tool_call', toolCallId: 'c', title: 't', content: [{ type: 'content', content: embedded }] },
      savingSink(seen),
    );
    expect(seen).toEqual([link, embedded]);
  });

  it('texto em message chunk não passa pelo sink', () => {
    const seen: acp.ContentBlock[] = [];
    sessionUpdateToDraft({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'oi' } }, savingSink(seen));
    expect(seen).toEqual([]);
  });
});

describe('flattenConfigOptions', () => {
  it('achata grupos de select e mantém boolean', () => {
    const options = flattenConfigOptions([
      {
        type: 'select',
        id: 'model',
        name: 'Modelo',
        category: 'model',
        currentValue: 'a',
        options: [
          {
            group: 'g1',
            name: 'Grupo',
            options: [
              { value: 'a', name: 'A' },
              { value: 'b', name: 'B', description: 'desc' },
            ],
          },
        ],
      },
      { type: 'boolean', id: 'fast', name: 'Rápido', category: 'model_config', currentValue: true },
    ]);

    expect(options).toEqual([
      {
        id: 'model',
        name: 'Modelo',
        description: null,
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          { value: 'a', name: 'A', description: null },
          { value: 'b', name: 'B', description: 'desc' },
        ],
      },
      {
        id: 'fast',
        name: 'Rápido',
        description: null,
        category: 'model_config',
        type: 'boolean',
        currentValue: true,
      },
    ]);
  });

  it('descarta opção que não passa no schema compartilhado (ex.: nome vazio)', () => {
    const options = flattenConfigOptions([
      { type: 'select', id: 'x', name: '', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
    ]);
    expect(options).toEqual([]);
  });
});

describe('modeConfigOption', () => {
  it('sintetiza a opção "mode" a partir de modes', () => {
    expect(
      modeConfigOption({
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Padrão' },
          { id: 'plan', name: 'Plano', description: 'só planeja' },
        ],
      }),
    ).toEqual({
      id: 'mode',
      name: 'Modo',
      description: null,
      category: 'mode',
      type: 'select',
      currentValue: 'plan',
      options: [
        { value: 'default', name: 'Padrão', description: null },
        { value: 'plan', name: 'Plano', description: 'só planeja' },
      ],
    });
  });
});

describe('titleFromPrompt', () => {
  it('usa os primeiros 60 caracteres, com espaços colapsados', () => {
    expect(titleFromPrompt('  linha um\n\nlinha  dois  ')).toBe('linha um linha dois');
    const long = 'x'.repeat(100);
    expect(titleFromPrompt(long)).toBe('x'.repeat(60));
  });

  it('prompt só com espaços não gera título', () => {
    expect(titleFromPrompt(' \n\t ')).toBeUndefined();
  });
});

describe('restoreMethodOf', () => {
  it('loadSession vence; senão sessionCapabilities.resume; senão nada', () => {
    expect(restoreMethodOf({ loadSession: true, sessionCapabilities: { resume: {} } })).toBe('load');
    expect(restoreMethodOf({ sessionCapabilities: { resume: {} } })).toBe('resume');
    expect(restoreMethodOf({ loadSession: false, sessionCapabilities: { resume: null } })).toBeUndefined();
    expect(restoreMethodOf({})).toBeUndefined();
    expect(restoreMethodOf(undefined)).toBeUndefined();
  });
});

describe('isPromptImage', () => {
  it('só raster comum entra inline; SVG, BMP e HEIC vão como caminho', () => {
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp'].every(isPromptImage)).toBe(true);
    expect(isPromptImage('image/svg+xml')).toBe(false);
    expect(isPromptImage('image/bmp')).toBe(false);
    expect(isPromptImage('application/pdf')).toBe(false);
  });
});

describe('promptBlocks', () => {
  it('texto sem anexos vira um bloco de texto', () => {
    expect(promptBlocks('oi', [])).toEqual([{ type: 'text', text: 'oi' }]);
  });

  it('anexo sem imagem inline vira caminho no texto, depois do texto do usuário', () => {
    const blocks = promptBlocks('veja', [{ path: 'C:\\files\\a.pdf', mime: 'application/pdf' }]);

    expect(blocks).toEqual([{ type: 'text', text: 'veja\n\n[Arquivo anexado: C:\\files\\a.pdf]' }]);
  });

  it('imagem inline vira bloco image depois do texto', () => {
    const blocks = promptBlocks('olha', [{ path: '/f/x.png', mime: 'image/png', imageData: 'QUJD' }]);

    expect(blocks).toEqual([
      { type: 'text', text: 'olha' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
  });

  it('sem texto, não manda bloco de texto vazio; só o caminho, sem quebras de linha no começo', () => {
    expect(promptBlocks('', [{ path: '/f/a.pdf', mime: 'application/pdf' }])).toEqual([
      { type: 'text', text: '[Arquivo anexado: /f/a.pdf]' },
    ]);
    expect(promptBlocks('', [{ path: '/f/x.png', mime: 'image/png', imageData: 'QUJD' }])).toEqual([
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
  });

  it('com hint, o bloco do aviso vai por último, como bloco de texto próprio', () => {
    const blocks = promptBlocks('olha', [{ path: '/f/a.pdf', mime: 'application/pdf' }], PHONE_SEND_HINT);
    expect(blocks).toEqual([
      { type: 'text', text: 'olha\n\n[Arquivo anexado: /f/a.pdf]' },
      { type: 'text', text: PHONE_SEND_HINT },
    ]);
  });

  it('o aviso é exatamente o do PLAN.md', () => {
    expect(PHONE_SEND_HINT).toBe(
      '[Nanachi Remote] O usuário está no celular. Para mandar um arquivo ou imagem a ele, rode no terminal: phone-send "<caminho>" (opcional: --caption "texto"). Para mandar uma print da tela do PC: phone-send --screenshot.',
    );
  });

  it('vários caminhos ficam um por linha dupla', () => {
    const blocks = promptBlocks('x', [
      { path: '/a', mime: 'text/plain' },
      { path: '/b', mime: 'text/plain' },
    ]);
    expect(blocks).toEqual([{ type: 'text', text: 'x\n\n[Arquivo anexado: /a]\n\n[Arquivo anexado: /b]' }]);
  });
});

describe('sessionUpdateToDraft: subagentes e segundo plano', () => {
  // Fixtures sintéticos com a forma descrita no PLAN.md; nenhum id, caminho ou texto é real.
  it('tool_call comum, sem _meta nem sinais novos, sai igual ao de antes (nada novo no evento)', () => {
    const draft = sessionUpdateToDraft({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Ler a.txt',
      kind: 'read',
      status: 'completed',
      rawInput: { path: 'C:\\proj\\a.txt' },
      content: [{ type: 'content', content: { type: 'text', text: 'conteúdo' } }],
      locations: [{ path: 'C:\\proj\\a.txt' }],
    });
    expect(draft).toEqual({
      kind: 'tool_call',
      toolCallId: 'call-1',
      title: 'Ler a.txt',
      toolKind: 'read',
      status: 'completed',
      content: [{ type: 'text', text: 'conteúdo' }],
      locations: ['C:\\proj\\a.txt'],
    });
  });

  it('Claude: tool_call Agent vira subagent running; rawInput e prompt não são guardados', () => {
    const memory: ToolCallMemory = new Map();
    const draft = sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'agent-1',
        title: 'Agent',
        kind: 'think',
        status: 'pending',
        rawInput: { description: 'Revisar o parser', subagent_type: 'Explore', run_in_background: false, prompt: 'PROMPT-SECRETO' },
        content: [],
        locations: [],
        _meta: { claudeCode: { toolName: 'Agent' } },
      },
      NO_IMAGES_SINK,
      memory,
    );

    expect(draft).toMatchObject({
      kind: 'tool_call',
      toolName: 'Agent',
      background: { kind: 'subagent', state: 'running', label: 'Revisar o parser', agentType: 'Explore' },
    });
    expect(draft).not.toHaveProperty('rawInput');
    expect(JSON.stringify(draft)).not.toContain('PROMPT-SECRETO');
    expect(validate(draft as Record<string, unknown>).success).toBe(true);
    expect(memory.get('agent-1')?.background?.state).toBe('running');
  });

  it('Claude: filho com _meta.parentToolUseId leva o pai; ferramenta comum filha não tem background', () => {
    const draft = sessionUpdateToDraft({
      sessionUpdate: 'tool_call',
      toolCallId: 'read-9',
      title: 'Read x.ts',
      status: 'pending',
      content: [],
      locations: [],
      _meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'agent-1' } },
    });
    expect(draft).toEqual({
      kind: 'tool_call',
      toolCallId: 'read-9',
      title: 'Read x.ts',
      status: 'pending',
      content: [],
      locations: [],
      toolName: 'Read',
      parentToolCallId: 'agent-1',
    });
  });

  it('Claude: a conclusão do Agent usa a memória do tool_call (label e agentType) e fecha como completed', () => {
    const memory: ToolCallMemory = new Map();
    sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'agent-1',
        title: 'Agent',
        status: 'pending',
        rawInput: { description: 'Revisar', subagent_type: 'Explore' },
        content: [],
        locations: [],
        _meta: { claudeCode: { toolName: 'Agent' } },
      },
      NO_IMAGES_SINK,
      memory,
    );
    const draft = sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Relatório pronto.' } }],
        _meta: { claudeCode: { toolName: 'Agent' } },
      },
      NO_IMAGES_SINK,
      memory,
    );
    expect(draft).toEqual({
      kind: 'tool_call_update',
      toolCallId: 'agent-1',
      status: 'completed',
      content: [{ type: 'text', text: 'Relatório pronto.' }],
      toolName: 'Agent',
      background: { kind: 'subagent', state: 'completed', label: 'Revisar', agentType: 'Explore' },
    });
    expect(validate(draft as Record<string, unknown>).success).toBe(true);
  });

  it('Claude: Agent assíncrono segue running depois do completed', () => {
    const memory: ToolCallMemory = new Map();
    const draft = sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent-2',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Async agent launched successfully. agentId: a-2' } }],
        _meta: { claudeCode: { toolName: 'Task' } },
      },
      NO_IMAGES_SINK,
      memory,
    );
    expect(draft).toMatchObject({ background: { kind: 'subagent', state: 'running' } });
  });

  it('Claude: Bash com run_in_background vira shell; o update com o texto de background mantém o label', () => {
    const memory: ToolCallMemory = new Map();
    const start = sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'bash-1',
        title: 'Bash',
        status: 'pending',
        rawInput: { command: 'npm run dev', description: 'Servidor de dev', run_in_background: true },
        content: [],
        locations: [],
        _meta: { claudeCode: { toolName: 'Bash' } },
      },
      NO_IMAGES_SINK,
      memory,
    );
    expect(start).toMatchObject({ toolName: 'Bash', background: { kind: 'shell', state: 'running', label: 'Servidor de dev' } });

    const done = sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bash-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Command running in background with ID: bg-1' } }],
      },
      NO_IMAGES_SINK,
      memory,
    );
    expect(done).toEqual({
      kind: 'tool_call_update',
      toolCallId: 'bash-1',
      status: 'completed',
      content: [{ type: 'text', text: 'Command running in background with ID: bg-1' }],
      toolName: 'Bash',
      background: { kind: 'shell', state: 'running', label: 'Servidor de dev' },
    });
  });

  it('Codex: spawnAgent vira subagent com um job por receiver; a chave de rawInput não entra no evento', () => {
    const draft = sessionUpdateToDraft({
      sessionUpdate: 'tool_call',
      toolCallId: 'codex-1',
      title: 'spawnAgent',
      kind: 'other',
      status: 'pending',
      rawInput: { receiverThreadIds: ['thread-1'], agentsStates: { 'thread-1': { status: 'pendingInit' } }, message: 'MENSAGEM-LONGA' },
      content: [],
      locations: [],
    });
    expect(draft).toMatchObject({
      background: { kind: 'subagent', state: 'running', label: 'spawnAgent', jobs: [{ id: 'thread-1', status: 'pendingInit' }] },
    });
    expect(JSON.stringify(draft)).not.toContain('MENSAGEM-LONGA');
    expect(validate(draft as Record<string, unknown>).success).toBe(true);
  });

  it('Codex: wait completed com um receiver errored vira failed', () => {
    const draft = sessionUpdateToDraft({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'codex-2',
      status: 'completed',
      rawInput: { receiverThreadIds: ['t1', 't2'], agentsStates: { t1: { status: 'completed' }, t2: { status: 'errored' } } },
    });
    expect(draft).toMatchObject({ background: { kind: 'subagent', state: 'failed' } });
  });

  it('omp: task com details.progress vira job; wait com details.jobs atualiza o status (sem resultText)', () => {
    const memory: ToolCallMemory = new Map();
    sessionUpdateToDraft(
      { sessionUpdate: 'tool_call', toolCallId: 'omp-task-1', title: 'task', status: 'pending', rawInput: { tasks: [] }, content: [], locations: [] },
      NO_IMAGES_SINK,
      memory,
    );
    const task = sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'omp-task-1',
        status: 'completed',
        rawOutput: {
          details: {
            progress: [
              { id: 'job-a', agent: 'explore', status: 'running', task: 'Ler o parser', toolCount: 3, tokens: 900, durationMs: 1200 },
            ],
          },
        },
      },
      NO_IMAGES_SINK,
      memory,
    );
    expect(task).toMatchObject({
      background: { kind: 'job', state: 'running', label: 'task', jobs: [{ id: 'job-a', label: 'Ler o parser', status: 'running' }] },
    });

    const wait = sessionUpdateToDraft(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'omp-wait-1',
        title: 'wait',
        status: 'completed',
        rawOutput: { details: { jobs: [{ id: 'job-a', status: 'completed', resultText: 'RESULTADO-LONGO' }] } },
      },
      NO_IMAGES_SINK,
      memory,
    );
    expect(wait).toMatchObject({ background: { kind: 'job', state: 'completed', jobs: [{ id: 'job-a', status: 'completed' }] } });
    expect(JSON.stringify(wait)).not.toContain('RESULTADO-LONGO');
    expect(validate(wait as Record<string, unknown>).success).toBe(true);
  });

  it('memória só guarda chamadas com background', () => {
    const memory: ToolCallMemory = new Map();
    sessionUpdateToDraft(
      { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', status: 'completed', content: [], locations: [] },
      NO_IMAGES_SINK,
      memory,
    );
    expect(memory.size).toBe(0);
  });
});

const NO_IMAGES_SINK: ImageSink = () => undefined;

describe('listedUpdatedAt', () => {
  it('converte o ISO 8601 do session/list para ms', () => {
    expect(listedUpdatedAt('2026-11-02T10:00:00.000Z')).toBe(Date.parse('2026-11-02T10:00:00.000Z'));
  });

  it('ausente, nulo ou inválido vira null', () => {
    expect(listedUpdatedAt(undefined)).toBeNull();
    expect(listedUpdatedAt(null)).toBeNull();
    expect(listedUpdatedAt('ontem')).toBeNull();
  });
});

describe('sameWorkingDirectory', () => {
  it('ignora barra final e aceita o mesmo caminho', () => {
    expect(sameWorkingDirectory('/home/joao/app', '/home/joao/app/')).toBe(true);
    expect(sameWorkingDirectory('/home/joao/app', '/home/joao/app')).toBe(true);
  });

  it('pastas diferentes não batem', () => {
    expect(sameWorkingDirectory('/home/joao/app', '/home/joao/app2')).toBe(false);
  });

  it('no win32 a comparação ignora maiúsculas e barra final (o Windows não diferencia)', () => {
    const same = process.platform === 'win32';
    expect(sameWorkingDirectory('C:\\Projetos\\App\\', 'c:\\projetos\\app')).toBe(same);
  });
});

describe('newestFirst', () => {
  it('ordena por updatedAt desc e põe as sem data no fim', () => {
    const items = [
      { id: 'sem', updatedAt: null },
      { id: 'velha', updatedAt: 1 },
      { id: 'nova', updatedAt: 2 },
    ];
    expect(items.sort(newestFirst).map((item) => item.id)).toEqual(['nova', 'velha', 'sem']);
  });
});

describe('availableCommandsOf', () => {
  it('traduz nome, descrição e dica do argumento (null sem input)', () => {
    const update: acp.AvailableCommandsUpdate = {
      availableCommands: [
        { name: 'loop', description: 'Repete um prompt', input: { hint: '[intervalo] [prompt]' } },
        { name: 'mcp', description: 'Servidores MCP' },
      ],
    };
    expect(availableCommandsOf(update)).toEqual([
      { name: 'loop', description: 'Repete um prompt', hint: '[intervalo] [prompt]' },
      { name: 'mcp', description: 'Servidores MCP', hint: null },
    ]);
  });

  it('descarta nome vazio e mantém só a primeira ocorrência de cada nome', () => {
    const update: acp.AvailableCommandsUpdate = {
      availableCommands: [
        { name: '', description: 'sem nome' },
        { name: 'review', description: 'primeira' },
        { name: 'review', description: 'repetida' },
      ],
    };
    expect(availableCommandsOf(update)).toEqual([{ name: 'review', description: 'primeira', hint: null }]);
  });

  it('lista vazia quando o agente não anuncia nada', () => {
    expect(availableCommandsOf({ availableCommands: [] })).toEqual([]);
  });
});

describe('isSlashCommand', () => {
  it('reconhece texto que começa com barra seguida de nome', () => {
    expect(isSlashCommand('/loop 5m verificar build')).toBe(true);
    expect(isSlashCommand('/mcp')).toBe(true);
    expect(isSlashCommand('skill:x')).toBe(false);
  });

  it('não conta barra solta, espaço antes da barra nem texto comum', () => {
    expect(isSlashCommand('/')).toBe(false);
    expect(isSlashCommand('/ loop')).toBe(false);
    expect(isSlashCommand(' /loop')).toBe(false);
    expect(isSlashCommand('oi, /loop depois')).toBe(false);
  });
});
