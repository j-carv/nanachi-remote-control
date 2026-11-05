import type * as acp from '@agentclientprotocol/sdk';
import { resolve } from 'node:path';
import {
  AvailableCommandSchema,
  SessionConfigOptionSchema,
  type AvailableCommand,
  type FileInfo,
  type SessionConfigOption,
  type SessionEvent,
  type ToolContent,
} from '@nanachi/shared';
import {
  rememberToolCall,
  trackToolCall,
  type ToolCallMemory,
  type ToolFacts,
  type ToolStatus,
} from './tool-background.js';

/** Distribui Omit sobre a união: remove campos comuns de cada variante de SessionEvent. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Evento antes de receber seq, sessionId e ts (esses são atribuídos ao gravar). */
export type EventDraft = DistributiveOmit<SessionEvent, 'seq' | 'sessionId' | 'ts'>;

type ToolCallStatus = NonNullable<Extract<SessionEvent, { kind: 'tool_call' }>['status']>;

export const MODE_OPTION_ID = 'mode';
const TITLE_MAX_CHARS = 60;
const TOOL_CALL_STATUSES: readonly ToolCallStatus[] = ['pending', 'in_progress', 'completed', 'failed'];

function knownStatus(value: string | null | undefined): ToolCallStatus | undefined {
  return TOOL_CALL_STATUSES.find((status) => status === value);
}

/**
 * Grava uma imagem que o agente mandou (bloco `image`, ou `resource_link`/`resource` de arquivo) como arquivo da
 * sessão. Devolve o arquivo, ou undefined quando o bloco não é imagem aceita (ou não pôde ser gravado): aí some do evento.
 */
export type ImageSink = (block: acp.ContentBlock) => FileInfo | undefined;

const NO_IMAGES: ImageSink = () => undefined;

/** Bloco de conteúdo de tool call: texto ou imagem gravada. Áudio e o resto somem. */
function toolItemOf(block: acp.ContentBlock, images: ImageSink): ToolContent | undefined {
  if (block.type === 'text') return { type: 'text', text: block.text };
  const file = images(block);
  return file === undefined ? undefined : { type: 'image', fileId: file.fileId, mime: file.mime };
}

/** Conteúdo de tool call: texto, diff e imagem; terminal fica de fora. */
export function toolContentOf(
  content: readonly acp.ToolCallContent[] | null | undefined,
  images: ImageSink = NO_IMAGES,
): ToolContent[] {
  const out: ToolContent[] = [];
  for (const item of content ?? []) {
    if (item.type === 'content') {
      const block = toolItemOf(item.content, images);
      if (block !== undefined) out.push(block);
    } else if (item.type === 'diff') {
      out.push({ type: 'diff', path: item.path, oldText: item.oldText ?? null, newText: item.newText });
    }
  }
  return out;
}

/** Chunk de mensagem ou pensamento: texto vira o evento de texto; imagem vira evento `file` (sem legenda). */
function chunkDraft(
  kind: 'agent_message_chunk' | 'agent_thought_chunk',
  block: acp.ContentBlock,
  images: ImageSink,
): EventDraft | undefined {
  if (block.type === 'text') return { kind, text: block.text };
  const file = images(block);
  if (file === undefined) return undefined;
  return { kind: 'file', fileId: file.fileId, name: file.name, mime: file.mime, size: file.size, direction: 'to_phone' };
}

function toSharedOption(option: acp.SessionConfigOption): unknown {
  const base = {
    id: option.id,
    name: option.name,
    description: option.description ?? null,
    category: option.category ?? null,
  };
  if (option.type === 'boolean') {
    return { ...base, type: 'boolean', currentValue: option.currentValue };
  }
  const entries: Array<acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup> = option.options;
  // Grouped options keep the group's display name (e.g. the provider in Oh My Pi); flat options carry no `group`.
  // A blank group name would fail `SelectOptionSchema.group` (min 1) and drop the whole select, so it is omitted.
  const flat = entries.flatMap((entry): Array<{ item: acp.SessionConfigSelectOption; group: string | undefined }> => {
    if (!('group' in entry)) return [{ item: entry, group: undefined }];
    const group = entry.name.trim();
    return entry.options.map((item) => ({ item, group: group === '' ? undefined : group }));
  });
  return {
    ...base,
    type: 'select',
    currentValue: option.currentValue,
    options: flat.map(({ item, group }) => ({
      value: item.value,
      name: item.name,
      description: item.description ?? null,
      ...(group === undefined ? {} : { group }),
    })),
  };
}

/**
 * `configOptions` do ACP para o formato do shared: achata grupos e descarta opções que não passam no schema.
 */
export function flattenConfigOptions(options: readonly acp.SessionConfigOption[]): SessionConfigOption[] {
  const out: SessionConfigOption[] = [];
  for (const option of options) {
    const parsed = SessionConfigOptionSchema.safeParse(toSharedOption(option));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Como retomar uma sessão: `session/load` (reenvia o histórico) ou `session/resume` (não reenvia). */
export type RestoreMethod = 'load' | 'resume';

/** `loadSession` vence; senão `sessionCapabilities.resume`; senão o agente não retoma. */
export function restoreMethodOf(capabilities: acp.AgentCapabilities | undefined): RestoreMethod | undefined {
  if (capabilities?.loadSession === true) return 'load';
  if (capabilities?.sessionCapabilities?.resume) return 'resume';
  return undefined;
}

/** Agente que só informa `modes`: sintetiza a opção de categoria `mode` (trocada com session/set_mode). */
export function modeConfigOption(modes: acp.SessionModeState): SessionConfigOption | undefined {
  const parsed = SessionConfigOptionSchema.safeParse({
    id: MODE_OPTION_ID,
    name: 'Modo',
    description: null,
    category: 'mode',
    type: 'select',
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description ?? null,
    })),
  });
  return parsed.success ? parsed.data : undefined;
}

/** Texto dos blocos de texto de um tool call (o que a derivação de background lê). Imagens e diffs ficam de fora. */
function textsOfContent(content: readonly acp.ToolCallContent[] | null | undefined): string[] {
  const texts: string[] = [];
  for (const item of content ?? []) {
    if (item.type === 'content' && item.content.type === 'text') texts.push(item.content.text);
  }
  return texts;
}

/** Fatos de um update de tool call para a derivação (ver tool-background.ts). `rawInput`/`rawOutput` não são guardados. */
function toolFactsOf(update: acp.ToolCall | acp.ToolCallUpdate, status: ToolStatus | undefined): ToolFacts {
  return {
    meta: update._meta,
    title: update.title,
    status,
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
    texts: textsOfContent(update.content),
  };
}

/**
 * Traduz um `session/update` para o evento gravado. Devolve undefined para o que não vira evento
 * (chunks sem texto nem imagem, updates de config/modo, e os que o protocolo tem mas o PWA não usa).
 * `images` grava as imagens que o agente manda; sem ele, imagens são ignoradas.
 * `memory` é o que a sessão lembra de tool calls com background (`trackToolCall`); esta função o atualiza.
 */
export function sessionUpdateToDraft(
  update: acp.SessionUpdate,
  images: ImageSink = NO_IMAGES,
  memory: ToolCallMemory = new Map(),
): EventDraft | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return chunkDraft('agent_message_chunk', update.content, images);
    case 'agent_thought_chunk':
      return chunkDraft('agent_thought_chunk', update.content, images);
    case 'tool_call': {
      const status = knownStatus(update.status);
      const tracking = trackToolCall(toolFactsOf(update, status), memory.get(update.toolCallId));
      rememberToolCall(memory, update.toolCallId, tracking);
      return {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title,
        content: toolContentOf(update.content, images),
        locations: (update.locations ?? []).map((location) => location.path),
        ...(update.kind !== undefined ? { toolKind: update.kind } : {}),
        ...(status !== undefined ? { status } : {}),
        ...tracking,
      };
    }
    case 'tool_call_update': {
      const status = knownStatus(update.status);
      const tracking = trackToolCall(toolFactsOf(update, status), memory.get(update.toolCallId));
      rememberToolCall(memory, update.toolCallId, tracking);
      return {
        kind: 'tool_call_update',
        toolCallId: update.toolCallId,
        ...(update.title != null ? { title: update.title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(update.content != null ? { content: toolContentOf(update.content, images) } : {}),
        ...tracking,
      };
    }
    case 'plan':
      return {
        kind: 'plan',
        entries: update.entries.map((entry) => ({
          content: entry.content,
          status: entry.status,
          priority: entry.priority,
        })),
      };
    default:
      return undefined;
  }
}

/**
 * Comandos do `available_commands_update` no formato do shared. Item inválido (nome vazio) sai; nome repetido
 * fica só na primeira ocorrência (o menu do PWA usa o nome como chave).
 */
export function availableCommandsOf(update: acp.AvailableCommandsUpdate): AvailableCommand[] {
  const seen = new Set<string>();
  const out: AvailableCommand[] = [];
  for (const command of update.availableCommands) {
    const parsed = AvailableCommandSchema.safeParse({
      name: command.name,
      description: command.description,
      hint: command.input?.hint ?? null,
    });
    if (!parsed.success || seen.has(parsed.data.name)) continue;
    seen.add(parsed.data.name);
    out.push(parsed.data);
  }
  return out;
}

/** Prompt de comando: texto que começa com `/` seguido de nome (`/loop 5m ...`). Barra solta não conta. */
export function isSlashCommand(text: string): boolean {
  return /^\/\S/.test(text);
}

/** Título = primeiros 60 caracteres do prompt, com espaços colapsados. Undefined se sobrar vazio. */
export function titleFromPrompt(text: string): string | undefined {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return Array.from(collapsed).slice(0, TITLE_MAX_CHARS).join('');
}

/** Imagens raster que vão inline no prompt (quando o agente anuncia `promptCapabilities.image`). */
const PROMPT_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function isPromptImage(mime: string): boolean {
  return PROMPT_IMAGE_MIMES.includes(mime);
}

/** Anexo já pronto para o prompt. `imageData` (base64) só vem preenchido quando vai inline. */
export interface PromptAttachment {
  path: string;
  mime: string;
  imageData?: string;
}

/**
 * Aviso do phone-send, no primeiro prompt de sessão criada pelo app (ver PLAN.md, Extra 03/11). Vai como bloco de
 * texto próprio, depois do que o usuário digitou; o user_message gravado não o contém.
 */
export const PHONE_SEND_HINT =
  '[Nanachi Remote] O usuário está no celular. Para mandar um arquivo ou imagem a ele, rode no terminal: phone-send "<caminho>" (opcional: --caption "texto"). Para mandar uma print da tela do PC: phone-send --screenshot.';

/**
 * Blocos do `session/prompt`: um bloco de texto (o do usuário + um `[Arquivo anexado: <caminho>]` por anexo
 * que não vai inline) e, depois, uma imagem por anexo com `imageData`. Sem texto nem caminhos, não há bloco de texto.
 * `hint` (se houver) vai por último, como bloco de texto próprio.
 */
export function promptBlocks(text: string, attachments: readonly PromptAttachment[], hint?: string): acp.ContentBlock[] {
  const paths = attachments
    .filter((attachment) => attachment.imageData === undefined)
    .map((attachment) => `[Arquivo anexado: ${attachment.path}]`);
  const textParts = [text, ...paths].filter((part) => part.length > 0);
  const blocks: acp.ContentBlock[] = [];
  if (textParts.length > 0) blocks.push({ type: 'text', text: textParts.join('\n\n') });

  for (const attachment of attachments) {
    if (attachment.imageData !== undefined) {
      blocks.push({ type: 'image', data: attachment.imageData, mimeType: attachment.mime });
    }
  }
  if (hint !== undefined) blocks.push({ type: 'text', text: hint });
  return blocks;
}

/** `updatedAt` do session/list (ISO 8601) em ms. Ausente ou inválido vira null. */
export function listedUpdatedAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Mesma pasta para o daemon: normaliza (barra final, `..`) e ignora maiúsculas no win32. */
export function sameWorkingDirectory(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Comparador para `sort`: updatedAt mais novo primeiro; sem data no fim. */
export function newestFirst<T extends { updatedAt: number | null }>(a: T, b: T): number {
  if (a.updatedAt === b.updatedAt) return 0;
  if (a.updatedAt === null) return 1;
  if (b.updatedAt === null) return -1;
  return b.updatedAt - a.updatedAt;
}
