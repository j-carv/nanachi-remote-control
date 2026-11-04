import { memo } from 'react';
import type { ApiClient } from '../api.js';
import { FileAttachment } from '../components/FileAttachment.js';
import { MarkdownText } from '../components/MarkdownText.js';
import { PlanCard } from './PlanCard.js';
import { ToolCard } from './ToolCard.js';
import type { ChatItem } from './reducer.js';
import { splitCommand } from './commands.js';

interface ChatItemViewProps {
  item: ChatItem;
  api: ApiClient;
}

/** Texto do usuário. Mensagem que começa com `/comando` destaca o comando (mono) e segue como texto normal. */
function UserText({ text }: { text: string }) {
  const parts = splitCommand(text);
  if (parts === undefined) return <p className="pre-wrap">{text}</p>;
  return (
    <p className="pre-wrap">
      <span className="command-token">{parts.command}</span>
      {parts.rest}
    </p>
  );
}

/**
 * Memorizado: o reducer troca só o item que mudou (o último em streaming), então os outros não são
 * reconciliados nem reanalisados a cada chunk.
 */
export const ChatItemView = memo(function ChatItemView({ item, api }: ChatItemViewProps) {
  switch (item.kind) {
    case 'user_message':
      return (
        <div className="bubble-user">
          {item.text !== '' && <UserText text={item.text} />}
          {item.attachments?.map((file) => (
            <FileAttachment key={file.fileId} api={api} file={file} />
          ))}
        </div>
      );

    case 'file':
      return <FileAttachment api={api} file={item.file} caption={item.caption} />;

    case 'agent_message':
      return (
        <div className="agent-text">
          <MarkdownText text={item.text} />
        </div>
      );

    case 'agent_thought':
      return (
        <details className="thought">
          <summary>
            Pensamento <span className="muted small">· {item.text.length} caracteres</span>
          </summary>
          <p className="pre-wrap muted">{item.text}</p>
        </details>
      );

    case 'tool_call':
      return <ToolCard api={api} item={item} />;

    case 'plan':
      return <PlanCard entries={item.entries} />;

    case 'error':
      return (
        <p className="chat-error" role="alert">
          {item.message}
        </p>
      );
  }
});
