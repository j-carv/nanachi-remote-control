import { useMemo, useState } from 'react';
import { diffRows } from './diffRows.js';
import { clipList } from './clipLines.js';
import { ShowAll } from './ShowAll.js';

interface DiffViewProps {
  path: string;
  oldText: string | null;
  newText: string;
}

const PREFIX: Record<'add' | 'del' | 'ctx', string> = { add: '+', del: '−', ctx: ' ' };

/** Linhas mostradas antes de "Mostrar tudo". Diff grande não toma a conversa inteira. */
export const DIFF_PREVIEW_ROWS = 60;

/** Diff por linha: adições verdes, remoções vermelhas. Arquivo novo = só adições. Rola na horizontal sozinho. */
export function DiffView({ path, oldText, newText }: DiffViewProps) {
  const rows = useMemo(() => diffRows(oldText ?? '', newText), [oldText, newText]);
  const [expanded, setExpanded] = useState(false);
  const clipped = expanded ? { shown: rows, hidden: 0 } : clipList(rows, DIFF_PREVIEW_ROWS);

  return (
    <div className="diff">
      <div className="diff-path">
        {path}
        {oldText === null && <span className="muted"> (novo)</span>}
      </div>
      <pre className="diff-body">
        {clipped.shown.map((row, index) => (
          <span key={index} className={`diff-line diff-${row.kind}`}>
            {PREFIX[row.kind]} {row.text}
          </span>
        ))}
      </pre>
      <ShowAll hidden={clipped.hidden} unit="linhas" onExpand={() => setExpanded(true)} />
    </div>
  );
}
