import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { diffRows } from './diffRows.js';
import { clipList } from './clipLines.js';
import { diffBodyClass, DiffLine } from './DiffLine.js';
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
  const { t } = useTranslation('workspace');
  const rows = useMemo(() => diffRows(oldText ?? '', newText), [oldText, newText]);
  const [expanded, setExpanded] = useState(false);
  const clipped = expanded ? { shown: rows, hidden: 0 } : clipList(rows, DIFF_PREVIEW_ROWS);

  return (
    <div data-slot="diff" className="overflow-hidden rounded-md border border-border">
      <p className="border-b border-border px-3 py-2 font-mono text-xs break-all">
        {path}
        {oldText === null && <span className="font-sans text-muted-foreground">{` ${t('diff.newFile')}`}</span>}
      </p>
      <pre className={diffBodyClass}>
        {clipped.shown.map((row, index) => (
          <DiffLine key={index} kind={row.kind}>
            {`${PREFIX[row.kind]} ${row.text}`}
          </DiffLine>
        ))}
      </pre>
      <ShowAll hidden={clipped.hidden} onExpand={() => setExpanded(true)} />
    </div>
  );
}
