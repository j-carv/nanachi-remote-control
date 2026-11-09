import type { SessionEvent } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applyEvents,
  createChatState,
  withStatus,
  withUserQuestionResult,
  withFileRequestResult,
  withPreviewClosed,
  type ChatItem,
} from './reducer.js';

type Body = DistributiveOmit<SessionEvent, 'seq' | 'sessionId' | 'ts'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function ev(seq: number, body: Body): SessionEvent {
  return { seq, sessionId: 's-1', ts: 1_700_000_000_000 + seq, ...body } as SessionEvent;
}

function run(events: SessionEvent[]) {
  return applyEvents(createChatState('idle'), events);
}

const TOOL_DIFF = { type: 'diff', path: 'a.ts', oldText: 'a', newText: 'b' } as const;

describe('createChatState', () => {
  it('começa vazio, com seq 0 e o status dado', () => {
    const state = createChatState('starting');
    expect(state).toEqual({ lastSeq: 0, items: [], permissions: [], status: 'starting', turnEnds: 0 });
  });
});

describe('user_message de iteração de loop', () => {
  it('leva o número da rodada do loop para o item', () => {
    const state = run([ev(1, { kind: 'user_message', text: 'revise', loop: true, loopIteration: 2 })]);
    expect(state.items).toEqual([
      { id: 'user-1', kind: 'user_message', text: 'revise', loopIteration: 2 },
    ]);
  });

  it('mensagem comum não ganha campo de loop', () => {
    const state = run([ev(1, { kind: 'user_message', text: 'oi' })]);
    expect(state.items[0]).not.toHaveProperty('loopIteration');
  });
});

describe('idempotência por seq', () => {
  it('evento repetido é ignorado e devolve o mesmo estado', () => {
    const first = applyEvent(createChatState('idle'), ev(1, { kind: 'user_message', text: 'oi' }));
    const again = applyEvent(first, ev(1, { kind: 'user_message', text: 'oi' }));
    expect(again).toBe(first);
    expect(again.items).toHaveLength(1);
  });

  it('evento antigo (seq menor que o último) é ignorado', () => {
    const state = run([ev(5, { kind: 'user_message', text: 'novo' })]);
    const late = applyEvent(state, ev(3, { kind: 'user_message', text: 'velho' }));
    expect(late).toBe(state);
    expect(late.items.map((item) => item.kind)).toEqual(['user_message']);
  });

  it('aceita saltos de seq (seq é global, não contíguo por sessão)', () => {
    const state = run([
      ev(1, { kind: 'user_message', text: 'a' }),
      ev(4, { kind: 'user_message', text: 'b' }),
    ]);
    expect(state.lastSeq).toBe(4);
    expect(state.items).toHaveLength(2);
  });

  it('applyEvents equivale a aplicar um por um, na ordem', () => {
    const events = [
      ev(1, { kind: 'agent_message_chunk', text: 'Oi' }),
      ev(2, { kind: 'agent_message_chunk', text: ' mundo' }),
    ];
    const batch = run(events);
    const stepwise = events.reduce(applyEvent, createChatState('idle'));
    expect(batch).toEqual(stepwise);
  });
});

describe('chunks', () => {
  it('concatena chunks consecutivos de agent_message num bloco só', () => {
    const state = run([
      ev(1, { kind: 'agent_message_chunk', text: '# Título\n' }),
      ev(2, { kind: 'agent_message_chunk', text: 'corpo ' }),
      ev(3, { kind: 'agent_message_chunk', text: 'final' }),
    ]);
    expect(state.items).toEqual([
      expect.objectContaining({ kind: 'agent_message', text: '# Título\ncorpo final' }),
    ]);
  });

  it('pensamento é um bloco separado da mensagem', () => {
    const state = run([
      ev(1, { kind: 'agent_thought_chunk', text: 'hmm' }),
      ev(2, { kind: 'agent_thought_chunk', text: '...' }),
      ev(3, { kind: 'agent_message_chunk', text: 'pronto' }),
    ]);
    expect(state.items.map((item) => [item.kind, textOf(item)])).toEqual([
      ['agent_thought', 'hmm...'],
      ['agent_message', 'pronto'],
    ]);
  });

  it('mensagem do usuário quebra a concatenação', () => {
    const state = run([
      ev(1, { kind: 'agent_message_chunk', text: 'um' }),
      ev(2, { kind: 'user_message', text: 'pergunta' }),
      ev(3, { kind: 'agent_message_chunk', text: 'dois' }),
    ]);
    expect(state.items.map((item) => textOf(item))).toEqual(['um', 'pergunta', 'dois']);
  });

  it('chunks que intercalam pensamento e mensagem viram blocos alternados', () => {
    const state = run([
      ev(1, { kind: 'agent_message_chunk', text: 'a' }),
      ev(2, { kind: 'agent_thought_chunk', text: 'b' }),
      ev(3, { kind: 'agent_message_chunk', text: 'c' }),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual([
      'agent_message',
      'agent_thought',
      'agent_message',
    ]);
  });
});

describe('tool calls', () => {
  it('tool_call cria um cartão com status, tipo, conteúdo e locais', () => {
    const state = run([
      ev(1, {
        kind: 'tool_call',
        toolCallId: 't-1',
        title: 'Editar a.ts',
        toolKind: 'edit',
        status: 'pending',
        content: [TOOL_DIFF],
        locations: ['a.ts'],
      }),
    ]);
    expect(state.items).toEqual([
      {
        id: 'tool-t-1',
        kind: 'tool_call',
        toolCallId: 't-1',
        title: 'Editar a.ts',
        toolKind: 'edit',
        status: 'pending',
        content: [TOOL_DIFF],
        locations: ['a.ts'],
      },
    ]);
  });

  it('tool_call_update funde no cartão pelo toolCallId', () => {
    const state = run([
      ev(1, {
        kind: 'tool_call',
        toolCallId: 't-1',
        title: 'Editar a.ts',
        toolKind: 'edit',
        status: 'pending',
        content: [],
        locations: ['a.ts'],
      }),
      ev(2, {
        kind: 'tool_call_update',
        toolCallId: 't-1',
        status: 'completed',
        content: [TOOL_DIFF],
      }),
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: 'tool_call',
      title: 'Editar a.ts',
      toolKind: 'edit',
      status: 'completed',
      content: [TOOL_DIFF],
      locations: ['a.ts'],
    });
  });

  it('update sem campos mantém título, status e conteúdo anteriores', () => {
    const state = run([
      ev(1, {
        kind: 'tool_call',
        toolCallId: 't-1',
        title: 'Ler',
        status: 'in_progress',
        content: [{ type: 'text', text: 'parcial' }],
        locations: [],
      }),
      ev(2, { kind: 'tool_call_update', toolCallId: 't-1' }),
    ]);
    expect(state.items[0]).toMatchObject({
      title: 'Ler',
      status: 'in_progress',
      content: [{ type: 'text', text: 'parcial' }],
    });
  });

  it('update de tool call desconhecido cria o cartão mesmo assim', () => {
    const state = run([
      ev(1, { kind: 'tool_call_update', toolCallId: 'x', title: 'Rodar', status: 'failed' }),
    ]);
    expect(state.items).toEqual([
      expect.objectContaining({ kind: 'tool_call', toolCallId: 'x', title: 'Rodar', status: 'failed' }),
    ]);
  });

  it('ids diferentes geram cartões diferentes, na ordem de chegada', () => {
    const state = run([
      ev(1, { kind: 'tool_call', toolCallId: 'a', title: 'A', content: [], locations: [] }),
      ev(2, { kind: 'tool_call', toolCallId: 'b', title: 'B', content: [], locations: [] }),
      ev(3, { kind: 'tool_call_update', toolCallId: 'a', status: 'completed' }),
    ]);
    expect(state.items.map((item) => (item.kind === 'tool_call' ? item.toolCallId : item.kind))).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('plano', () => {
  it('plano novo vira item; novo plano substitui as entradas no mesmo lugar', () => {
    const state = run([
      ev(1, { kind: 'agent_message_chunk', text: 'vou fazer' }),
      ev(2, {
        kind: 'plan',
        entries: [{ content: 'passo 1', status: 'in_progress', priority: 'high' }],
      }),
      ev(3, { kind: 'user_message', text: 'ok' }),
      ev(4, {
        kind: 'plan',
        entries: [
          { content: 'passo 1', status: 'completed', priority: 'high' },
          { content: 'passo 2', status: 'pending', priority: 'low' },
        ],
      }),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(['agent_message', 'plan', 'user_message']);
    expect(state.items[1]).toMatchObject({
      kind: 'plan',
      entries: [
        { content: 'passo 1', status: 'completed', priority: 'high' },
        { content: 'passo 2', status: 'pending', priority: 'low' },
      ],
    });
  });
});

describe('permissões', () => {
  const request = (requestId: string, seq: number) =>
    ev(seq, {
      kind: 'permission_request',
      requestId,
      title: `Rodar ${requestId}`,
      content: [],
      options: [
        { optionId: 'allow', name: 'Permitir', kind: 'allow_once' },
        { optionId: 'reject', name: 'Recusar', kind: 'reject_once' },
      ],
    });

  it('permission_request fica pendente até o permission_resolved', () => {
    const pending = run([request('r-1', 1)]);
    expect(pending.permissions.map((p) => p.requestId)).toEqual(['r-1']);

    const resolved = applyEvent(
      pending,
      ev(2, { kind: 'permission_resolved', requestId: 'r-1', optionId: 'allow' }),
    );
    expect(resolved.permissions).toEqual([]);
  });

  it('mantém várias pendentes e resolve só a indicada', () => {
    const state = run([
      request('r-1', 1),
      request('r-2', 2),
      ev(3, { kind: 'permission_resolved', requestId: 'r-1', optionId: null }),
    ]);
    expect(state.permissions.map((p) => p.requestId)).toEqual(['r-2']);
  });

  it('permission_resolved de id desconhecido não muda nada', () => {
    const state = run([request('r-1', 1)]);
    const next = applyEvent(state, ev(2, { kind: 'permission_resolved', requestId: 'zzz', optionId: 'x' }));
    expect(next.permissions.map((p) => p.requestId)).toEqual(['r-1']);
  });

  it('guarda opções e conteúdo para o cartão', () => {
    const state = run([request('r-1', 1)]);
    expect(state.permissions[0]?.options.map((o) => o.optionId)).toEqual(['allow', 'reject']);
  });
});

describe('user questions', () => {
  const options = [{ id: 'a', label: 'First option' }, { id: 'b', label: 'Second option' }];
  const answered = { status: 'answered', option: options[0]! } as const;
  const question = (requestId: string, seq: number) => ev(seq, {
    kind: 'user_question', requestId, question: 'Which approach?', options, expiresAt: 1_800_000_300_000,
  });
  const pending = () => applyEvent(createChatState('running'), question('q-1', 1));

  it('preserves the original question and every option when the confirmed choice arrives', () => {
    const state = applyEvent(pending(), ev(2, { kind: 'user_question_resolved', requestId: 'q-1', result: answered }));
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: 'user_question', requestId: 'q-1', question: 'Which approach?', options, result: answered,
    });
    expect(state.status).toBe('running');
    expect(state.permissions).toEqual([]);
  });

  it('never resolves a security permission or changes its waiting status when a question is answered', () => {
    const state = applyEvents(pending(), [
      ev(2, {
        kind: 'permission_request', requestId: 'permission-1', title: 'Execute command', content: [],
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
      }),
      ev(3, { kind: 'status', status: 'awaiting_permission' }),
      ev(4, { kind: 'user_question_resolved', requestId: 'q-1', result: answered }),
    ]);
    expect(state.status).toBe('awaiting_permission');
    expect(state.permissions.map((permission) => permission.requestId)).toEqual(['permission-1']);
    expect(state.items[0]).toMatchObject({ result: answered });
  });

  it('resolves only the exact question and keeps explicit cancellation distinct from a choice', () => {
    const state = applyEvents(pending(), [
      question('q-2', 2),
      ev(3, { kind: 'user_question_resolved', requestId: 'q-1', result: { status: 'cancelled', reason: 'user_cancelled' } }),
      ev(4, { kind: 'user_question_resolved', requestId: 'unknown', result: answered }),
    ]);
    expect(state.items[0]).toMatchObject({ result: { status: 'cancelled', reason: 'user_cancelled' } });
    expect(state.items[1]).toMatchObject({ requestId: 'q-2', result: null, unavailable: false });
    expect(state.items).toHaveLength(2);
  });

  it('never revives or replaces a question on replay, even with a new event sequence', () => {
    const events = [
      question('q-1', 1),
      ev(2, { kind: 'user_question_resolved', requestId: 'q-1', result: answered }),
      ev(3, { kind: 'user_question', requestId: 'q-1', question: 'Replacement?', options: [...options].reverse(), expiresAt: 9 }),
    ];
    const once = run(events);
    expect(once.items).toHaveLength(1);
    expect(once.items[0]).toMatchObject({ question: 'Which approach?', options, result: answered });
    expect(applyEvents(once, events)).toBe(once);
  });

  it.each<Body>([
    { kind: 'turn_end', stopReason: 'end_turn' },
    { kind: 'status', status: 'stopped' },
    { kind: 'status', status: 'error' },
    { kind: 'status', status: 'idle' },
    { kind: 'error', message: 'Agent lost' },
  ])('makes a pending question unavailable on $kind without inventing a result', (body) => {
    const state = applyEvent(pending(), ev(2, body));
    expect(state.items[0]).toMatchObject({ unavailable: true, result: null });
  });

  it('also closes questions on a session broadcast, including an unchanged stopped status', () => {
    const state = withStatus(pending(), 'stopped');
    expect(state.items[0]).toMatchObject({ unavailable: true, result: null });
    expect(withStatus(state, 'stopped')).toBe(state);
    expect(applyEvent(state, question('q-2', 2)).items[1]).toMatchObject({ unavailable: true, result: null });
  });

  it('keeps a question pending across permission auto-approval and unrelated streamed history', () => {
    const state = applyEvents(pending(), [
      ev(2, { kind: 'permission_auto_approved', toolCallId: 'read-1', title: 'Read file', optionId: 'allow-once' }),
      ...Array.from({ length: 300 }, (_, index) => ev(index + 3, { kind: 'user_message', text: `Message ${index}` })),
    ]);
    expect(state.items[0]).toMatchObject({ requestId: 'q-1', result: null, unavailable: false });
    expect(state.items.slice(-200).some((item) => item.kind === 'user_question')).toBe(false);
  });

  it('applies HTTP confirmation without advancing replay and ignores duplicate or contradictory confirmations', () => {
    const state = pending();
    expect(withUserQuestionResult(state, 'unknown', answered)).toBe(state);
    const confirmed = withUserQuestionResult(state, 'q-1', answered);
    expect(confirmed.lastSeq).toBe(state.lastSeq);
    expect(withUserQuestionResult(confirmed, 'q-1', { status: 'cancelled', reason: 'expired' })).toBe(confirmed);
    const replayed = applyEvents(confirmed, [
      ev(2, { kind: 'user_question_resolved', requestId: 'q-1', result: answered }),
      ev(3, { kind: 'agent_message_chunk', text: 'Continuing the same turn' }),
    ]);
    expect(replayed.items[0]).toMatchObject({ result: answered });
    expect(replayed.items[1]).toMatchObject({ kind: 'agent_message', text: 'Continuing the same turn' });
    expect(replayed.status).toBe('running');
  });

  it('accepts the authoritative resolution after a stale response or lifecycle boundary made the card unavailable', () => {
    const unavailable = withUserQuestionResult(pending(), 'q-1', null);
    expect(unavailable.items[0]).toMatchObject({ unavailable: true, result: null });
    const resolved = applyEvent(unavailable, ev(2, { kind: 'user_question_resolved', requestId: 'q-1', result: answered }));
    expect(resolved.items[0]).toMatchObject({ result: answered });
  });
});

describe('requested files', () => {
  const file = { fileId: 'f-request', name: 'report.pdf', mime: 'application/pdf', size: 42 };
  const received = { status: 'received', file } as const;
  const request = (seq = 1) => ev(seq, {
    kind: 'file_request', requestId: 'r-1', prompt: 'Choose the report', accept: ['.pdf'], expiresAt: 1_800_000_300_000,
  });
  const pending = () => applyEvent(createChatState('running'), request());

  it('does not answer from upload events, unrelated attachments, auto-approval or long streamed history', () => {
    const state = applyEvents(pending(), [
      ev(2, { kind: 'file', ...file, direction: 'from_phone' }),
      ev(3, { kind: 'user_message', text: 'Other prompt', attachments: [file] }),
      ev(4, { kind: 'permission_auto_approved', toolCallId: 'tool-1', title: 'Read', optionId: 'allow' }),
      ...Array.from({ length: 300 }, (_, index) => ev(index + 5, { kind: 'agent_message_chunk', text: 'chunk' })),
    ]);
    expect(state.items[0]).toMatchObject({ result: null, unavailable: false, prompt: 'Choose the report' });
    expect(state.status).toBe('running');
  });

  it('replays pending and resolved history without reviving requests or enqueuing a prompt', () => {
    const state = applyEvents(pending(), [
      ev(2, { kind: 'file_request_resolved', requestId: 'r-1', result: received }),
      request(3),
      ev(4, { kind: 'file_request_resolved', requestId: 'r-1', result: { status: 'cancelled', reason: 'expired' } }),
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ result: received, unavailable: true });
    expect(state.status).toBe('running');
    expect(state.permissions).toEqual([]);
  });

  it.each<Body>([
    { kind: 'turn_end', stopReason: 'end_turn' },
    { kind: 'status', status: 'idle' },
    { kind: 'status', status: 'stopped' },
    { kind: 'error', message: 'Disconnected' },
  ])('settles lifecycle boundaries without inventing received or cancelled on $kind', (body) => {
    const state = applyEvent(pending(), ev(2, body));
    expect(state.items[0]).toMatchObject({ result: null, unavailable: true });
    const resolved = applyEvent(state, ev(3, { kind: 'file_request_resolved', requestId: 'r-1', result: { status: 'cancelled', reason: 'disconnected' } }));
    expect(resolved.items[0]).toMatchObject({ result: { status: 'cancelled', reason: 'disconnected' } });
  });

  it('applies exact HTTP confirmation without advancing the cursor and accepts later authoritative events after stale errors', () => {
    const state = pending();
    const unavailable = withFileRequestResult(state, 'r-1', null);
    expect(unavailable.lastSeq).toBe(state.lastSeq);
    const resolved = applyEvent(unavailable, ev(2, { kind: 'file_request_resolved', requestId: 'r-1', result: received }));
    expect(resolved.items[0]).toMatchObject({ result: received });
    expect(withFileRequestResult(resolved, 'r-1', { status: 'cancelled', reason: 'user_cancelled' })).toBe(resolved);
    expect(withFileRequestResult(state, 'unknown', received)).toBe(state);
    expect(withStatus(state, 'stopped').items[0]).toMatchObject({ result: null, unavailable: true });
  });
});

describe('preview history', () => {
  const preview = (seq = 1) => ev(seq, {
    kind: 'preview', previewId: 'p-1', title: 'Local app', port: 3000, path: '/demo?q=1', expiresAt: 1_800_001_800_000,
  });

  it('keeps the dev app available after turn end and idle, without modifying the plan or questions', () => {
    const state = applyEvents(createChatState('running'), [
      preview(), ev(2, { kind: 'turn_end', stopReason: 'end_turn' }), ev(3, { kind: 'status', status: 'idle' }),
    ]);
    expect(state.items[0]).toMatchObject({ closedReason: null, unavailable: false });
    expect(withStatus(state, 'idle')).toBe(state);
  });

  it('retains revoked history, ignores duplicate creation and accepts server closure after stale restart state', () => {
    const pending = applyEvent(createChatState('running'), preview());
    const stale = withPreviewClosed(pending, 'p-1', null);
    expect(stale.lastSeq).toBe(pending.lastSeq);
    const closed = applyEvents(stale, [
      ev(2, { kind: 'preview_closed', previewId: 'p-1', reason: 'expired' }), preview(3),
    ]);
    expect(closed.items).toHaveLength(1);
    expect(closed.items[0]).toMatchObject({ closedReason: 'expired', unavailable: true });
    expect(withPreviewClosed(closed, 'p-1', 'closed')).toBe(closed);
    expect(withStatus(pending, 'stopped').items[0]).toMatchObject({ closedReason: null, unavailable: true });
  });
});

describe('status e erros', () => {
  it('evento status atualiza o status da sessão', () => {
    const state = run([ev(1, { kind: 'status', status: 'running' })]);
    expect(state.status).toBe('running');
  });

  it('withStatus aplica status vindo da mensagem session', () => {
    const state = withStatus(createChatState('idle'), 'awaiting_permission');
    expect(state.status).toBe('awaiting_permission');
  });

  it('turn_end não cria item nem muda status', () => {
    const before = run([ev(1, { kind: 'status', status: 'running' })]);
    const after = applyEvent(before, ev(2, { kind: 'turn_end', stopReason: 'end_turn' }));
    expect(after.items).toEqual([]);
    expect(after.status).toBe('running');
    expect(after.lastSeq).toBe(2);
  });

  it('error vira item de erro', () => {
    const state = run([ev(1, { kind: 'error', message: 'falhou' })]);
    expect(state.items).toEqual([expect.objectContaining({ kind: 'error', message: 'falhou' })]);
  });

  it('ids dos itens são únicos', () => {
    const state = run([
      ev(1, { kind: 'user_message', text: 'a' }),
      ev(2, { kind: 'agent_message_chunk', text: 'b' }),
      ev(3, { kind: 'agent_thought_chunk', text: 'c' }),
    ]);
    const ids = state.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('arquivos', () => {
  const FILE = { fileId: 'f-1', name: 'print.png', mime: 'image/png', size: 2048 };

  it('file to_phone vira item de arquivo com nome, tipo e tamanho', () => {
    const state = run([ev(1, { kind: 'file', ...FILE, direction: 'to_phone' })]);
    expect(state.items).toEqual([
      { id: 'file-1', kind: 'file', file: FILE, caption: null },
    ]);
  });

  it('legenda (caption) vai junto com o arquivo', () => {
    const state = run([
      ev(1, { kind: 'file', ...FILE, direction: 'to_phone', caption: 'Tela do erro' }),
    ]);
    expect(state.items).toEqual([
      expect.objectContaining({ kind: 'file', caption: 'Tela do erro' }),
    ]);
  });

  it('file from_phone não vira item: o anexo já aparece na user_message', () => {
    const before = run([ev(1, { kind: 'user_message', text: 'veja', attachments: [FILE] })]);
    const after = applyEvent(before, ev(2, { kind: 'file', ...FILE, direction: 'from_phone' }));
    expect(after.items).toHaveLength(1);
    expect(after.lastSeq).toBe(2);
  });

  it('user_message com anexos guarda os anexos no item', () => {
    const state = run([ev(1, { kind: 'user_message', text: '', attachments: [FILE] })]);
    expect(state.items).toEqual([
      { id: 'user-1', kind: 'user_message', text: '', attachments: [FILE] },
    ]);
  });

  it('user_message sem anexos não ganha a chave attachments', () => {
    const state = run([ev(1, { kind: 'user_message', text: 'oi' })]);
    expect(state.items[0]).not.toHaveProperty('attachments');
  });
});

describe('nesting and background work on tool items', () => {
  const TS = (seq: number) => 1_700_000_000_000 + seq;

  it('keeps parentToolCallId and toolName from the event', () => {
    const state = run([
      ev(1, {
        kind: 'tool_call',
        toolCallId: 'child',
        title: 'Ler parser.ts',
        parentToolCallId: 'parent',
        toolName: 'Read',
        content: [],
        locations: [],
      }),
    ]);
    expect(state.items[0]).toMatchObject({ parentToolCallId: 'parent', toolName: 'Read' });
  });

  it('an update without lineage fields keeps the ones already known', () => {
    const state = run([
      ev(1, {
        kind: 'tool_call',
        toolCallId: 'child',
        title: 'Ler',
        parentToolCallId: 'parent',
        toolName: 'Read',
        content: [],
        locations: [],
      }),
      ev(2, { kind: 'tool_call_update', toolCallId: 'child', status: 'completed' }),
    ]);
    expect(state.items[0]).toMatchObject({ parentToolCallId: 'parent', toolName: 'Read', status: 'completed' });
  });

  it('a later background replaces the earlier one', () => {
    const state = run([
      ev(1, {
        kind: 'tool_call',
        toolCallId: 'sub',
        title: 'Agent',
        background: { kind: 'subagent', state: 'running', label: 'Antes' },
        content: [],
        locations: [],
      }),
      ev(2, {
        kind: 'tool_call_update',
        toolCallId: 'sub',
        background: { kind: 'subagent', state: 'completed', label: 'Depois', agentType: 'Explore' },
      }),
    ]);
    expect(state.items[0]).toMatchObject({
      background: { kind: 'subagent', state: 'completed', label: 'Depois', agentType: 'Explore' },
    });
  });

  it('jobs merge by id: a newer status wins, a label survives when the newer job has none', () => {
    const state = run([
      ev(1, {
        kind: 'tool_call',
        toolCallId: 'task',
        title: 'Compilar e testar',
        background: {
          kind: 'job',
          state: 'running',
          jobs: [
            { id: 'j1', label: 'Compilar', status: 'running' },
            { id: 'j2', label: 'Testes', status: 'running' },
          ],
        },
        content: [],
        locations: [],
      }),
      ev(2, {
        kind: 'tool_call_update',
        toolCallId: 'task',
        background: {
          kind: 'job',
          state: 'running',
          jobs: [
            { id: 'j1', status: 'completed' },
            { id: 'j3', label: 'Lint', status: 'running' },
          ],
        },
      }),
    ]);
    expect(state.items[0]).toMatchObject({
      background: {
        jobs: [
          { id: 'j1', label: 'Compilar', status: 'completed' },
          { id: 'j2', label: 'Testes', status: 'running' },
          { id: 'j3', label: 'Lint', status: 'running' },
        ],
      },
    });
  });

  it('an update whose background has no jobs keeps the jobs already known', () => {
    const state = run([
      ev(1, {
        kind: 'tool_call',
        toolCallId: 'task',
        title: 'task',
        background: { kind: 'job', state: 'running', jobs: [{ id: 'j1', status: 'running' }] },
        content: [],
        locations: [],
      }),
      ev(2, {
        kind: 'tool_call_update',
        toolCallId: 'task',
        background: { kind: 'job', state: 'completed' },
      }),
    ]);
    expect(state.items[0]).toMatchObject({
      background: { state: 'completed', jobs: [{ id: 'j1', status: 'running' }] },
    });
  });

  it('records when the background started and when the tool call last changed', () => {
    const state = run([
      ev(1, { kind: 'tool_call', toolCallId: 'bash', title: 'Bash', content: [], locations: [] }),
      ev(2, {
        kind: 'tool_call_update',
        toolCallId: 'bash',
        background: { kind: 'shell', state: 'running' },
      }),
      ev(5, { kind: 'tool_call_update', toolCallId: 'bash', title: 'Bash · npm test' }),
    ]);
    expect(state.items[0]).toMatchObject({
      timing: { startedAt: TS(2), updatedAt: TS(5), startEnds: 0, seenEnds: 0 },
    });
  });

  it('a tool call without background has no timing and no background keys', () => {
    const state = run([ev(1, { kind: 'tool_call', toolCallId: 'plain', title: 'Ler', content: [], locations: [] })]);
    expect(state.items[0]).not.toHaveProperty('timing');
    expect(state.items[0]).not.toHaveProperty('background');
    expect(state.items[0]).not.toHaveProperty('parentToolCallId');
  });

  it('each turn_end counts one turn end, and later updates record the count they saw', () => {
    const state = run([
      ev(1, { kind: 'tool_call', toolCallId: 'bash', title: 'Bash', background: { kind: 'shell', state: 'running' }, content: [], locations: [] }),
      ev(2, { kind: 'turn_end', stopReason: 'end_turn' }),
      ev(3, { kind: 'turn_end', stopReason: 'end_turn' }),
      ev(4, { kind: 'tool_call_update', toolCallId: 'bash', title: 'Bash' }),
    ]);
    expect(state.turnEnds).toBe(2);
    expect(state.items[0]).toMatchObject({ timing: { startEnds: 0, seenEnds: 2 } });
  });
});

function textOf(item: ChatItem): string | undefined {
  return 'text' in item ? item.text : undefined;
}

describe('account_changed', () => {
  it('vira uma linha da conversa com o nome da conta nova', () => {
    const state = run([
      ev(1, { kind: 'agent_message_chunk', text: 'oi' }),
      ev(2, { kind: 'account_changed', accountId: 'a-1', label: 'Trabalho' }),
    ]);
    expect(state.items).toEqual([
      { id: 'agent_message-1', kind: 'agent_message', text: 'oi' },
      { id: 'account-2', kind: 'account_changed', label: 'Trabalho' },
    ]);
  });

  it('voltar para a principal também vira linha (accountId null)', () => {
    const state = run([ev(1, { kind: 'account_changed', accountId: null, label: 'Principal' })]);
    expect(state.items).toEqual([{ id: 'account-1', kind: 'account_changed', label: 'Principal' }]);
  });

  it('o texto que vem depois do evento abre uma mensagem nova, sem grudar na anterior', () => {
    const state = run([
      ev(1, { kind: 'agent_message_chunk', text: 'antes' }),
      ev(2, { kind: 'account_changed', accountId: 'a-1', label: 'Trabalho' }),
      ev(3, { kind: 'agent_message_chunk', text: 'depois' }),
    ]);
    expect(state.items.map((item) => item.kind)).toEqual(['agent_message', 'account_changed', 'agent_message']);
  });

  it('é idempotente: o mesmo seq de novo não repete a linha', () => {
    const event = ev(2, { kind: 'account_changed', accountId: 'a-1', label: 'Trabalho' });
    const once = run([event]);
    expect(applyEvents(once, [event])).toBe(once);
    expect(once.items).toHaveLength(1);
  });

  it('não muda o status nem os pedidos de permissão', () => {
    const state = run([ev(1, { kind: 'account_changed', accountId: 'a-1', label: 'Trabalho' })]);
    expect(state.status).toBe('idle');
    expect(state.permissions).toEqual([]);
  });
});
