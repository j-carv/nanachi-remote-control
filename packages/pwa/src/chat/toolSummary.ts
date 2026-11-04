import type { ToolContent } from '@nanachi/shared';
import { diffRows } from '../components/diffRows.js';
import type { ChatItem, ToolCallStatus } from './reducer.js';

export type ToolItem = Extract<ChatItem, { kind: 'tool_call' }>;

export interface ToolSummary {
  /** Título da linha; sem título, o primeiro arquivo. */
  title: string;
  /** Arquivo a mostrar à parte, só quando o título não o contém. */
  file: string | null;
  added: number;
  removed: number;
  statusText: string;
}

const STATUS_TEXT: Record<ToolCallStatus, string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  completed: 'Concluído',
  failed: 'Falhou',
};

/** Contagem de linhas +/− somando todos os diffs do tool call. */
function countChanges(content: readonly ToolContent[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of content) {
    if (part.type !== 'diff') continue;
    for (const row of diffRows(part.oldText ?? '', part.newText)) {
      if (row.kind === 'add') added += 1;
      else if (row.kind === 'del') removed += 1;
    }
  }
  return { added, removed };
}

/** Resumo de uma linha do tool call: título, arquivo, +/− e status em texto. */
export function summarizeTool(item: ToolItem): ToolSummary {
  const firstLocation = item.locations[0] ?? null;
  const title = item.title !== '' ? item.title : (firstLocation ?? 'Ferramenta');
  const file = firstLocation !== null && !title.includes(firstLocation) ? firstLocation : null;
  const { added, removed } = countChanges(item.content);

  return {
    title,
    file,
    added,
    removed,
    statusText: item.status === null ? 'Ferramenta' : STATUS_TEXT[item.status],
  };
}
