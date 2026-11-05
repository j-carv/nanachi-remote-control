import { memo } from 'react';
import { Brain, ChevronDown, Repeat } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { FileAttachment } from '../components/FileAttachment.js';
import { MarkdownText } from '../components/MarkdownText.js';
import { PlanCard } from './PlanCard.js';
import { ToolCard } from './ToolCard.js';
import type { ChatNode } from './nesting.js';
import type { BackgroundView } from './background.js';
import { splitCommand } from './commands.js';
import { stripAnsi } from './ansi.js';
import { stripPromptNotes } from './promptNotes.js';
import { splitLoopMarkers } from './loopMarkers.js';

interface ChatItemViewProps {
  node: ChatNode;
  api: ApiClient;
  view: BackgroundView;
  /** Rendered as a child of a tool card: flat rows, no card of their own. */
  nested?: boolean;
}

/** Texto do usuário. Mensagem que começa com `/comando` destaca o comando (mono) e segue como texto normal. */
function UserText({ text }: { text: string }) {
  const parts = splitCommand(text);
  if (parts === undefined) return <p className="whitespace-pre-wrap">{text}</p>;
  return (
    <p className="whitespace-pre-wrap">
      <span data-slot="command-token" className="rounded-md bg-primary-foreground/20 px-1 font-mono font-semibold">
        {parts.command}
      </span>
      {parts.rest}
    </p>
  );
}

/**
 * Memorizado: o reducer troca só o item que mudou (o último em streaming), então os outros não são
 * reconciliados nem reanalisados a cada chunk.
 */
export const ChatItemView = memo(function ChatItemView({ node, api, view, nested = false }: ChatItemViewProps) {
  const { item } = node;
  switch (item.kind) {
    case 'user_message': {
      const text = stripPromptNotes(item.text);
      return (
        <>
          {item.loopIteration !== undefined && (
            <p data-slot="loop-label" className="mb-1 flex items-center gap-1 self-end text-xs text-muted-foreground">
              <Repeat className="size-3.5" aria-hidden="true" />
              Loop #{item.loopIteration}
            </p>
          )}
          <div
            data-slot="bubble-user"
            className="flex max-w-[82%] flex-col gap-2 self-end rounded-[18px_18px_4px_18px] bg-primary px-3.5 py-2.5 leading-snug text-primary-foreground [overflow-wrap:anywhere] [&_[data-slot=file-caption]]:text-primary-foreground/85"
          >
            {text !== '' && <UserText text={text} />}
            {item.attachments?.map((file) => (
              <FileAttachment key={file.fileId} api={api} file={file} />
            ))}
          </div>
        </>
      );
    }

    case 'file':
      return <FileAttachment api={api} file={item.file} caption={item.caption} />;

    case 'agent_message': {
      const { text, note } = splitLoopMarkers(item.text);
      return (
        <div data-slot="agent-text" className="min-w-0">
          <MarkdownText text={text} />
          {note !== null && (
            <p data-slot="loop-note" className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <Repeat className="size-3.5" aria-hidden="true" />
              {note}
            </p>
          )}
        </div>
      );
    }

    case 'agent_thought':
      return (
        <details className="group text-sm text-muted-foreground">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
            <Brain className="size-4 shrink-0" aria-hidden="true" />
            Pensamento
            <span className="font-normal">· {item.text.length} caracteres</span>
            <ChevronDown
              className="ml-auto size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <p className="pb-1 pl-6 whitespace-pre-wrap">{stripAnsi(item.text)}</p>
        </details>
      );

    case 'tool_call':
      return (
        <ToolCard
          api={api}
          item={item}
          nested={node.children}
          flat={nested}
          view={view}
          renderNested={(child) => <ChatItemView node={child} api={api} view={view} nested />}
        />
      );

    case 'plan':
      return <PlanCard entries={item.entries} />;

    case 'error':
      return (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3.5 py-3 text-destructive [overflow-wrap:anywhere]"
        >
          {item.message}
        </p>
      );
  }
});
