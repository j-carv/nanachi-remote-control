import type { FileInfo, SessionEvent, SessionStatus, ToolContent } from '@nanachi/shared';

type EventOf<K extends SessionEvent['kind']> = Extract<SessionEvent, { kind: K }>;

export type PlanEntry = EventOf<'plan'>['entries'][number];
export type ToolCallStatus = NonNullable<EventOf<'tool_call'>['status']>;
/** Pedido de permissão ainda sem `permission_resolved`. */
export type PendingPermission = EventOf<'permission_request'>;

/** Bloco da conversa. Chunks consecutivos de texto já vêm concatenados. */
export type ChatItem =
  | { id: string; kind: 'user_message'; text: string; attachments?: FileInfo[] }
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
    }
  | { id: string; kind: 'plan'; entries: PlanEntry[] }
  | { id: string; kind: 'error'; message: string };

export interface ChatState {
  /** Maior seq já aplicado. Eventos com seq igual ou menor são ignorados. */
  readonly lastSeq: number;
  readonly items: readonly ChatItem[];
  readonly permissions: readonly PendingPermission[];
  readonly status: SessionStatus;
}

export function createChatState(status: SessionStatus): ChatState {
  return { lastSeq: 0, items: [], permissions: [], status };
}

/** Estado mutável interno: `applyEvents` copia uma vez e aplica tudo em cima da cópia. */
interface Draft {
  lastSeq: number;
  items: ChatItem[];
  permissions: PendingPermission[];
  status: SessionStatus;
}

interface ToolPatch {
  title?: string | undefined;
  toolKind?: string | undefined;
  status?: ToolCallStatus | undefined;
  content?: ToolContent[] | undefined;
  locations?: string[] | undefined;
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

/** Cria o cartão do tool call ou funde o patch nele (campos ausentes mantêm o valor). */
function upsertTool(draft: Draft, toolCallId: string, patch: ToolPatch) {
  const index = findToolIndex(draft.items, toolCallId);
  const existing = index === -1 ? undefined : draft.items[index];

  if (existing?.kind !== 'tool_call') {
    draft.items.push({
      id: `tool-${toolCallId}`,
      kind: 'tool_call',
      toolCallId,
      title: patch.title ?? '',
      toolKind: patch.toolKind ?? null,
      status: patch.status ?? null,
      content: patch.content ?? [],
      locations: patch.locations ?? [],
    });
    return;
  }

  draft.items[index] = {
    ...existing,
    title: patch.title ?? existing.title,
    toolKind: patch.toolKind ?? existing.toolKind,
    status: patch.status ?? existing.status,
    content: patch.content ?? existing.content,
    locations: patch.locations ?? existing.locations,
  };
}

function applyOne(draft: Draft, event: SessionEvent) {
  switch (event.kind) {
    case 'user_message': {
      const attachments = event.attachments;
      draft.items.push({
        id: `user-${event.seq}`,
        kind: 'user_message',
        text: event.text,
        ...(attachments === undefined ? {} : { attachments }),
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
      upsertTool(draft, event.toolCallId, {
        title: event.title,
        toolKind: event.toolKind,
        status: event.status,
        content: event.content,
        locations: event.locations,
      });
      return;

    case 'tool_call_update':
      upsertTool(draft, event.toolCallId, {
        title: event.title,
        status: event.status,
        content: event.content,
      });
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
  };
}

export function applyEvent(state: ChatState, event: SessionEvent): ChatState {
  return applyEvents(state, [event]);
}

/** Status vindo da mensagem `session` (broadcast do daemon). */
export function withStatus(state: ChatState, status: SessionStatus): ChatState {
  return state.status === status ? state : { ...state, status };
}
