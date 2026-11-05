import type { Background, FileInfo, SessionEvent, SessionStatus, ToolContent } from '@nanachi/shared';
import { mergeBackground } from './background.js';

type EventOf<K extends SessionEvent['kind']> = Extract<SessionEvent, { kind: K }>;

export type PlanEntry = EventOf<'plan'>['entries'][number];
export type ToolCallStatus = NonNullable<EventOf<'tool_call'>['status']>;
/** Pedido de permissão ainda sem `permission_resolved`. */
export type PendingPermission = EventOf<'permission_request'>;

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
  | { id: string; kind: 'agent_message'; text: string }
  /** Arquivo que o agente mandou ao celular (evento `file` com direction `to_phone`). */
  | { id: string; kind: 'file'; file: FileInfo; caption: string | null }
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
    draft.items[draft.items.length - 1] = { ...last, text: last.text + text };
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

function applyOne(draft: Draft, event: SessionEvent) {
  switch (event.kind) {
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

    case 'turn_end':
      draft.turnEnds += 1;
      return;

    // Saída de terminal (sessão PTY) não entra na conversa; a tela de terminal trata esses eventos.
    case 'terminal_output':
    case 'terminal_exit':
      return;

    case 'status':
      draft.status = event.status;
      return;

    case 'error':
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
  return state.status === status ? state : { ...state, status };
}
