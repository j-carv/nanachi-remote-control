import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, ChevronDown, Repeat } from 'lucide-react';
import type { ApiClient } from '../api.js';
import type { PreviewOpenResponse } from '@nanachi/shared';
import { FileAttachment } from '../components/FileAttachment.js';
import { MarkdownText } from '../components/MarkdownText.js';
import { PlanCard } from './PlanCard.js';
import { UserQuestionCardView } from './UserQuestionCard.js';
import { FileRequestCardView } from './FileRequestCard.js';
import { PreviewCard } from './PreviewCard.js';
import { ToolCard } from './ToolCard.js';
import type { ChatNode } from './nesting.js';
import type { BackgroundView } from './background.js';
import { splitCommand } from './commands.js';
import { stripAnsi } from './ansi.js';
import { stripPromptNotes } from './promptNotes.js';
import { splitLoopMarkers } from './loopMarkers.js';
import type { HistoryIds } from './liveItems.js';
import { MessageActionsTrigger, type ActionMessage } from './MessageActionsTrigger.js';
import { LearningNoticeView } from './LearningNotice.js';

interface ChatItemViewProps {
  node: ChatNode;
  api: ApiClient;
  view: BackgroundView;
  workspaceId?: string | undefined;
  onManageLearning?: ((reviewId: string, action: 'approve' | 'reject' | 'revert') => Promise<void>) | undefined;
  /** Rendered as a child of a tool card: flat rows, no card of their own. */
  nested?: boolean;
  /** Items shown with the history (see liveItems.ts); passed down to the rows of a tool card. */
  history?: HistoryIds | null | undefined;
  onMessageActions?: ((message: ActionMessage) => void) | undefined;
  onOpenPreview?: ((previewId: string) => Promise<PreviewOpenResponse>) | undefined;
  onClosePreview?: ((previewId: string) => Promise<void>) | undefined;
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
export const ChatItemView = memo(function ChatItemView({ node, api, view, nested = false, history, onMessageActions, onOpenPreview, onClosePreview, workspaceId, onManageLearning }: ChatItemViewProps) {
  const { t } = useTranslation('chat');
  const { item } = node;
  switch (item.kind) {
    case 'learning':
      return <LearningNoticeView notice={item} api={api} workspaceId={workspaceId} onManage={onManageLearning} />;

    case 'user_message': {
      const text = stripPromptNotes(item.text);
      return (
        <MessageActionsTrigger message={item} onOpen={text.trim() === '' ? undefined : onMessageActions}>
          {item.loopIteration !== undefined && (
            <p data-slot="loop-label" className="mb-1 flex items-center gap-1 self-end text-xs text-muted-foreground">
              <Repeat className="size-3.5" aria-hidden="true" />
              {t('item.loopRound', { number: item.loopIteration })}
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
        </MessageActionsTrigger>
      );
    }

    case 'file':
      return <FileAttachment api={api} file={item.file} caption={item.caption} />;

    case 'user_question':
      // Live questions have one actionable instance outside the transcript window.
      return item.result === null && !item.unavailable
        ? null
        : <UserQuestionCardView request={item} state={{ kind: 'idle' }} />;

    case 'file_request':
      return item.result === null && !item.unavailable
        ? null
        : <FileRequestCardView api={api} request={item} state="idle" />;

    case 'preview':
      return <PreviewCard preview={item} apiBaseUrl={api.baseUrl}
        onOpen={onOpenPreview === undefined ? undefined : () => onOpenPreview(item.previewId)}
        onClose={onClosePreview === undefined ? undefined : () => onClosePreview(item.previewId)} />;

    case 'agent_message': {
      const { text, note } = splitLoopMarkers(item.text);
      return (
        <MessageActionsTrigger message={item} onOpen={text.trim() === '' ? undefined : onMessageActions}>
          <div data-slot="agent-text" className="min-w-0">
            <MarkdownText text={text} />
            {note !== null && (
              <p data-slot="loop-note" className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                <Repeat className="size-3.5" aria-hidden="true" />
                {note}
              </p>
            )}
          </div>
        </MessageActionsTrigger>
      );
    }

    case 'agent_thought':
      return (
        <details className="group text-sm text-muted-foreground">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-medium transition-colors duration-200 hover:text-foreground motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
            <Brain className="size-4 shrink-0" aria-hidden="true" />
            {t('item.thought')}
            <span className="font-normal">· {t('item.thoughtSize', { count: item.text.length })}</span>
            <ChevronDown
              className="ml-auto size-4 shrink-0 transition-transform duration-200 ease-(--ease-out-premium) group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <p className="pb-1 pl-6 whitespace-pre-wrap group-open:animate-enter motion-reduce:animate-none">{stripAnsi(item.text)}</p>
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
          history={history}
          renderNested={(child) => <ChatItemView node={child} api={api} view={view} nested history={history} onOpenPreview={onOpenPreview} onClosePreview={onClosePreview} workspaceId={workspaceId} onManageLearning={onManageLearning} />}
        />
      );

    case 'plan':
      return <PlanCard entries={item.entries} />;

    case 'account_changed':
      return (
        <p data-slot="account-changed" className="self-center px-4 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {t('item.accountChanged', { label: item.label })}
        </p>
      );

    case 'permission_auto_approved':
      return (
        <p data-slot="permission-auto-approved" className="self-center px-4 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {item.title === '' ? t('item.yoloApproved') : t('item.yoloApprovedTool', { title: item.title })}
        </p>
      );

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
