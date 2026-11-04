import { useMemo, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import type { ApiClient } from '../api.js';
import { ToolContentView } from '../components/ToolContentView.js';
import { summarizeTool, type ToolItem } from './toolSummary.js';

export type { ToolItem } from './toolSummary.js';

/**
 * Tool call: uma linha de resumo (status, título, arquivo, +/−). Aberto enquanto está em andamento; depois de
 * concluído recolhe sozinho, a não ser que o usuário tenha aberto ou fechado à mão.
 */
export function ToolCard({ api, item }: { api: ApiClient; item: ToolItem }) {
  const live = item.status === 'pending' || item.status === 'in_progress';
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? live;
  const summary = useMemo(() => summarizeTool(item), [item]);
  const hasChanges = summary.added > 0 || summary.removed > 0;

  return (
    <details className="tool-card" open={open} onToggle={(event) => setChoice(event.currentTarget.open)}>
      <summary className="tool-summary">
        <span className={`badge badge-${item.status ?? 'none'}`}>{summary.statusText}</span>
        <span className="tool-main">
          <span className="tool-title">{summary.title}</span>
          {summary.file !== null && <span className="tool-file">{summary.file}</span>}
        </span>
        {hasChanges && (
          <span className="tool-delta" aria-label={`${summary.added} linhas acrescentadas, ${summary.removed} removidas`}>
            <span className="delta-add">+{summary.added}</span>
            <span className="delta-del">−{summary.removed}</span>
          </span>
        )}
        <CaretDown size={16} weight="bold" className="tool-chevron" aria-hidden="true" />
      </summary>

      <div className="tool-body">
        {item.locations.length > 0 && (
          <ul className="locations">
            {item.locations.map((location) => (
              <li key={location}>{location}</li>
            ))}
          </ul>
        )}
        {item.content.map((content, index) => (
          <ToolContentView key={index} api={api} content={content} />
        ))}
      </div>
    </details>
  );
}
