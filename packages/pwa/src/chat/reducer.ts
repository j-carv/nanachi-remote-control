import type { AskUserResult, Background, FileInfo, PreviewInfo, RequestFileResult, SessionEvent, SessionStatus, ToolContent } from '@nanachi/shared';
import { mergeBackground } from './background.js';
import type { LearningNotice } from '@nanachi/shared';

type EventOf<K extends SessionEvent['kind']> = Extract<SessionEvent, { kind: K }>;

export type PlanEntry = EventOf<'plan'>['entries'][number];
export type ToolCallStatus = NonNullable<EventOf<'tool_call'>['status']>;
/** Pedido de permissão ainda sem `permission_resolved`. */
export type PendingPermission = EventOf<'permission_request'>;

/** The original question stays in history; only confirmed replies populate `result`. */
export type UserQuestionItem = Pick<EventOf<'user_question'>, 'requestId' | 'question' | 'options' | 'expiresAt'> & {
  id: string;
  kind: 'user_question';
  result: AskUserResult | null;
  /** The turn ended or the server rejected a stale reply; this is not an inferred answer or cancellation. */
  unavailable: boolean;
};

export type FileRequestItem = Pick<EventOf<'file_request'>, 'requestId' | 'prompt' | 'accept' | 'expiresAt'> & {
  id: string;
  kind: 'file_request';
  result: RequestFileResult | null;
  unavailable: boolean;
};

export type PreviewItem = PreviewInfo & {
  id: string;
  kind: 'preview';
  closedReason: EventOf<'preview_closed'>['reason'] | null;
  unavailable: boolean;
};

/**
 * When a tool call's background work started and last changed. Turn ends are counted in `ChatState.turnEnds`, so
 * "ended since the last update" is a comparison of two counts (see `effectiveState` in background.ts).
 */
export interface BackgroundTiming {
  /** Timestamp (ms) of the first event that reported background work for this tool call. */
  readonly startedAt: number;
  /** Timestamp (ms) of the latest event for this tool call. */
  readonly updatedAt: number;
  /** `turnEnds` when the background work was first reported. */
  readonly startEnds: number;
  /** `turnEnds` when the latest event for this tool call arrived. */
  readonly seenEnds: number;
}

/** Bloco da conversa. Chunks consecutivos de texto já vêm concatenados. */
export type ChatItem =
  /** `loopIteration`: the round number, when the message comes from a loop (absent on ordinary messages). */
  | { id: string; kind: 'user_message'; text: string; attachments?: FileInfo[]; loopIteration?: number }
  | { id: string; kind: 'agent_message'; text: string; lastSeq?: number }
  /** Arquivo que o agente mandou ao celular (evento `file` com direction `to_phone`). */
  | { id: string; kind: 'file'; file: FileInfo; caption: string | null }
  | UserQuestionItem
  | FileRequestItem
  | PreviewItem
  | { id: string; kind: 'agent_thought'; text: string }
  | {
      id: string;
      kind: 'tool_call';
      toolCallId: string;
      title: string;
      toolKind: string | null;
      status: ToolCallStatus | null;
      content: ToolContent[];
      locations: string[];
      /** Tool call that made this one (a subagent's child). Absent for top-level calls. */
      parentToolCallId?: string;
      /** Tool name the agent reports (`Agent`, `Bash`, ...). */
      toolName?: string;
      /** Background work of this tool call, as the daemon derived it. */
      background?: Background;
      /** Present once `background` is present. */
      timing?: BackgroundTiming;
    }
  | { id: string; kind: 'plan'; entries: PlanEntry[] }
  | ({ id: string; kind: 'learning' } & LearningNotice)
  /** The session moved to another account: `label` is the name of the new one. */
  | { id: string; kind: 'account_changed'; label: string }
  | { id: string; kind: 'permission_auto_approved'; title: string }
  | { id: string; kind: 'error'; message: string };

export interface ChatState {
  /** Maior seq já aplicado. Eventos com seq igual ou menor são ignorados. */
  readonly lastSeq: number;
  readonly items: readonly ChatItem[];
  readonly permissions: readonly PendingPermission[];
  readonly status: SessionStatus;
  /** Quantos `turn_end` já passaram nesta conversa. Usado para marcar o trabalho em segundo plano que ficou para trás. */
  readonly turnEnds: number;
}

export function createChatState(status: SessionStatus): ChatState {
  return { lastSeq: 0, items: [], permissions: [], status, turnEnds: 0 };
}

/** Estado mutável interno: `applyEvents` copia uma vez e aplica tudo em cima da cópia. */
interface Draft {
  lastSeq: number;
  items: ChatItem[];
  permissions: PendingPermission[];
  status: SessionStatus;
  turnEnds: number;
}

interface ToolPatch {
  title?: string | undefined;
  toolKind?: string | undefined;
  status?: ToolCallStatus | undefined;
  content?: ToolContent[] | undefined;
  locations?: string[] | undefined;
  parentToolCallId?: string | undefined;
  toolName?: string | undefined;
  background?: Background | undefined;
}

function appendText(draft: Draft, kind: 'agent_message' | 'agent_thought', seq: number, text: string) {
  const last = draft.items.at(-1);
  if (last !== undefined && last.kind === kind && 'text' in last) {
    draft.items[draft.items.length - 1] = last.kind === 'agent_message'
      ? { ...last, text: last.text + text, lastSeq: seq }
      : { ...last, text: last.text + text };
    return;
  }
  draft.items.push({ id: `${kind}-${seq}`, kind, text });
}

function findToolIndex(items: readonly ChatItem[], toolCallId: string): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind === 'tool_call' && item.toolCallId === toolCallId) return index;
  }
  return -1;
}

/** Timing after an event for a tool call: starts with the first background report, then follows every event. */
function trackTiming(
  previous: BackgroundTiming | undefined,
  hasBackground: boolean,
  ts: number,
  turnEnds: number,
): BackgroundTiming | undefined {
  if (previous === undefined) {
    return hasBackground ? { startedAt: ts, updatedAt: ts, startEnds: turnEnds, seenEnds: turnEnds } : undefined;
  }
  return { ...previous, updatedAt: ts, seenEnds: turnEnds };
}

/**
 * Cria o cartão do tool call ou funde o patch nele (campos ausentes mantêm o valor). Campos de aninhamento e de
 * segundo plano só entram no item quando existem, para que um tool call comum continue igual a antes.
 */
function upsertTool(draft: Draft, toolCallId: string, patch: ToolPatch, ts: number) {
  const index = findToolIndex(draft.items, toolCallId);
  const found = index === -1 ? undefined : draft.items[index];
  const existing = found?.kind === 'tool_call' ? found : undefined;
  const parent = patch.parentToolCallId ?? existing?.parentToolCallId;
  const toolName = patch.toolName ?? existing?.toolName;
  const background = mergeBackground(existing?.background, patch.background);
  const timing = trackTiming(existing?.timing, background !== undefined, ts, draft.turnEnds);

  const item: Extract<ChatItem, { kind: 'tool_call' }> = {
    id: existing?.id ?? `tool-${toolCallId}`,
    kind: 'tool_call',
    toolCallId,
    title: patch.title ?? existing?.title ?? '',
    toolKind: patch.toolKind ?? existing?.toolKind ?? null,
    status: patch.status ?? existing?.status ?? null,
    content: patch.content ?? existing?.content ?? [],
    locations: patch.locations ?? existing?.locations ?? [],
    ...(parent !== undefined ? { parentToolCallId: parent } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(timing !== undefined ? { timing } : {}),
  };

  if (index === -1) draft.items.push(item);
  else draft.items[index] = item;
}

function updateQuestion(items: ChatItem[], requestId: string, result: AskUserResult | null): boolean {
  const index = items.findIndex((item) => item.kind === 'user_question' && item.requestId === requestId);
  const item = items[index];
  if (item?.kind !== 'user_question' || item.result !== null || (result === null && item.unavailable)) return false;
  items[index] = { ...item, result, unavailable: true };
  return true;
}

function closeQuestions(items: ChatItem[]): void {
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item?.kind === 'user_question' && item.result === null && !item.unavailable) {
      items[index] = { ...item, unavailable: true };
    } else if (item?.kind === 'file_request' && item.result === null && !item.unavailable) {
      items[index] = { ...item, unavailable: true };
    }
  }
}

function updateFileRequest(items: ChatItem[], requestId: string, result: RequestFileResult | null): boolean {
  const index = items.findIndex((item) => item.kind === 'file_request' && item.requestId === requestId);
  const item = items[index];
  if (item?.kind !== 'file_request' || item.result !== null || (result === null && item.unavailable)) return false;
  items[index] = { ...item, result, unavailable: true };
  return true;
}

function updatePreview(items: ChatItem[], previewId: string, reason: PreviewItem['closedReason']): boolean {
  const index = items.findIndex((item) => item.kind === 'preview' && item.previewId === previewId);
  const item = items[index];
  if (item?.kind !== 'preview' || item.closedReason !== null || (reason === null && item.unavailable)) return false;
  items[index] = { ...item, closedReason: reason, unavailable: true };
  return true;
}

function closePreviews(items: ChatItem[]): void {
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item?.kind === 'preview' && item.closedReason === null && !item.unavailable) {
      items[index] = { ...item, unavailable: true };
    }
  }
}

function upsertLearning(items: ChatItem[], notice: LearningNotice): void {
  if ((notice.status === 'applied' || notice.status === 'pending') && notice.memoryCount + notice.skillCount === 0) return;
  const existing = items.findIndex((item) => item.kind === 'learning' && item.reviewId === notice.reviewId);
  const item: ChatItem = { ...notice, id: `learning-${notice.reviewId}`, kind: 'learning' };
  if (existing >= 0) { items[existing] = item; return; }
  // A late review stays with its completed task, before any newer user turn.
  const nextTurn = items.findIndex((candidate) => candidate.kind === 'user_message' && Number(candidate.id.slice('user-'.length)) > notice.sourceTurnSeq);
  if (nextTurn < 0) items.push(item);
  else items.splice(nextTurn, 0, item);
}

/** Confirmed HTTP actions update the original row without advancing the event cursor. */
export function withLearningNotice(state: ChatState, notice: LearningNotice): ChatState {
  const items = [...state.items];
  upsertLearning(items, notice);
  return { ...state, items };
}

function applyOne(draft: Draft, event: SessionEvent) {
  switch (event.kind) {
    case 'learning':
      upsertLearning(draft.items, event);
      return;

    case 'user_message': {
      const attachments = event.attachments;
      const loopIteration = event.loopIteration;
      draft.items.push({
        id: `user-${event.seq}`,
        kind: 'user_message',
        text: event.text,
        ...(attachments === undefined ? {} : { attachments }),
        ...(loopIteration === undefined ? {} : { loopIteration }),
      });
      return;
    }

    case 'file':
      // Anexo do celular já aparece na user_message; só o que vai para o celular vira item.
      if (event.direction !== 'to_phone') return;
      draft.items.push({
        id: `file-${event.seq}`,
        kind: 'file',
        file: { fileId: event.fileId, name: event.name, mime: event.mime, size: event.size },
        caption: event.caption ?? null,
      });
      return;

    case 'agent_message_chunk':
      appendText(draft, 'agent_message', event.seq, event.text);
      return;

    case 'agent_thought_chunk':
      appendText(draft, 'agent_thought', event.seq, event.text);
      return;

    case 'tool_call':
      upsertTool(
        draft,
        event.toolCallId,
        {
          title: event.title,
          toolKind: event.toolKind,
          status: event.status,
          content: event.content,
          locations: event.locations,
          parentToolCallId: event.parentToolCallId,
          toolName: event.toolName,
          background: event.background,
        },
        event.ts,
      );
      return;

    case 'tool_call_update':
      upsertTool(
        draft,
        event.toolCallId,
        {
          title: event.title,
          status: event.status,
          content: event.content,
          parentToolCallId: event.parentToolCallId,
          toolName: event.toolName,
          background: event.background,
        },
        event.ts,
      );
      return;

    case 'plan': {
      const index = draft.items.findIndex((item) => item.kind === 'plan');
      const existing = index === -1 ? undefined : draft.items[index];
      if (existing?.kind === 'plan') {
        draft.items[index] = { ...existing, entries: event.entries };
      } else {
        draft.items.push({ id: `plan-${event.seq}`, kind: 'plan', entries: event.entries });
      }
      return;
    }

    case 'permission_request':
      draft.permissions = [
        ...draft.permissions.filter((pending) => pending.requestId !== event.requestId),
        event,
      ];
      return;

    case 'permission_resolved':
      draft.permissions = draft.permissions.filter(
        (pending) => pending.requestId !== event.requestId,
      );
      return;

    case 'user_question':
      // A replay with a newer sequence must not replace the original prompt or revive a completed question.
      if (draft.items.some((item) => item.kind === 'user_question' && item.requestId === event.requestId)) return;
      draft.items.push({
        id: `question-${event.requestId}`,
        kind: 'user_question',
        requestId: event.requestId,
        question: event.question,
        options: event.options,
        expiresAt: event.expiresAt,
        result: null,
        unavailable: draft.status === 'stopped' || draft.status === 'error',
      });
      return;

    case 'user_question_resolved':
      updateQuestion(draft.items, event.requestId, event.result);
      return;

    case 'file_request':
      if (draft.items.some((item) => item.kind === 'file_request' && item.requestId === event.requestId)) return;
      draft.items.push({
        id: `file-request-${event.requestId}`,
        kind: 'file_request',
        requestId: event.requestId,
        prompt: event.prompt,
        ...(event.accept === undefined ? {} : { accept: event.accept }),
        expiresAt: event.expiresAt,
        result: null,
        unavailable: draft.status === 'stopped' || draft.status === 'error',
      });
      return;

    case 'file_request_resolved':
      updateFileRequest(draft.items, event.requestId, event.result);
      return;

    case 'preview':
      if (draft.items.some((item) => item.kind === 'preview' && item.previewId === event.previewId)) return;
      draft.items.push({
        id: `preview-${event.previewId}`,
        kind: 'preview',
        previewId: event.previewId,
        port: event.port,
        title: event.title,
        path: event.path,
        expiresAt: event.expiresAt,
        closedReason: null,
        unavailable: draft.status === 'stopped' || draft.status === 'error',
      });
      return;

    case 'preview_closed':
      updatePreview(draft.items, event.previewId, event.reason);
      return;

    case 'turn_end':
      draft.turnEnds += 1;
      closeQuestions(draft.items);
      return;

    // Saída de terminal (sessão PTY) não entra na conversa; a tela de terminal trata esses eventos.
    case 'terminal_output':
    case 'terminal_exit':
      return;

    case 'account_changed':
      draft.items.push({ id: `account-${event.seq}`, kind: 'account_changed', label: event.label });
      return;

    case 'permission_auto_approved':
      draft.items.push({ id: `permission-${event.seq}`, kind: event.kind, title: event.title });
      return;

    case 'status':
      draft.status = event.status;
      if (event.status === 'stopped' || event.status === 'error' || event.status === 'idle') closeQuestions(draft.items);
      if (event.status === 'stopped' || event.status === 'error') closePreviews(draft.items);
      return;

    case 'error':
      closeQuestions(draft.items);
      draft.items.push({ id: `error-${event.seq}`, kind: 'error', message: event.message });
      return;
  }
}

/**
 * Aplica eventos em ordem. Idempotente: só aplica seq maior que `lastSeq`, então repetido
 * ou antigo não muda nada. Não exige seq contíguo, porque o seq é global do daemon
 * (várias sessões gravam na mesma sequência). Sem nenhuma mudança, devolve o mesmo objeto.
 */
export function applyEvents(state: ChatState, events: readonly SessionEvent[]): ChatState {
  const draft: Draft = {
    lastSeq: state.lastSeq,
    items: [...state.items],
    permissions: [...state.permissions],
    status: state.status,
    turnEnds: state.turnEnds,
  };

  let changed = false;
  for (const event of events) {
    if (event.seq <= draft.lastSeq) continue;
    applyOne(draft, event);
    draft.lastSeq = event.seq;
    changed = true;
  }

  if (!changed) return state;
  return {
    lastSeq: draft.lastSeq,
    items: draft.items,
    permissions: draft.permissions,
    status: draft.status,
    turnEnds: draft.turnEnds,
  };
}

export function applyEvent(state: ChatState, event: SessionEvent): ChatState {
  return applyEvents(state, [event]);
}

/** Status vindo da mensagem `session` (broadcast do daemon). */
export function withStatus(state: ChatState, status: SessionStatus): ChatState {
  const terminal = status === 'stopped' || status === 'error' || status === 'idle';
  const hasPending = terminal && state.items.some(
    (item) => ((item.kind === 'file_request' || item.kind === 'user_question') && item.result === null && !item.unavailable)
      || ((status === 'stopped' || status === 'error') && item.kind === 'preview' && item.closedReason === null && !item.unavailable),
  );
  if (state.status === status && !hasPending) return state;
  if (!hasPending) return { ...state, status };
  const items = [...state.items];
  closeQuestions(items);
  if (status === 'stopped' || status === 'error') closePreviews(items);
  return { ...state, items, status };
}

/** Applies the HTTP confirmation without advancing the event cursor. Null means unavailable, never an answer. */
export function withUserQuestionResult(state: ChatState, requestId: string, result: AskUserResult | null): ChatState {
  const items = [...state.items];
  return updateQuestion(items, requestId, result) ? { ...state, items } : state;
}

export function withFileRequestResult(state: ChatState, requestId: string, result: RequestFileResult | null): ChatState {
  const items = [...state.items];
  return updateFileRequest(items, requestId, result) ? { ...state, items } : state;
}

/** Null marks stale history unavailable without inventing a server close reason. */
export function withPreviewClosed(state: ChatState, previewId: string, reason: PreviewItem['closedReason']): ChatState {
  const items = [...state.items];
  return updatePreview(items, previewId, reason) ? { ...state, items } : state;
}
