import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { diffBodyClass, DiffLine, type DiffLineKind } from './DiffLine.js';
import { parseUnifiedPatch } from './unifiedPatch.js';

interface UnifiedPatchViewProps {
  patch: string;
}

/** Marcador exibido antes de cada linha de conteúdo (cabeçalhos ficam sem marcador). */
const MARK: Partial<Record<DiffLineKind, string>> = { add: '+', del: '−', ctx: ' ' };

/** Patch unificado com as mesmas cores do DiffView: adições verdes, remoções vermelhas. */
export function UnifiedPatchView({ patch }: UnifiedPatchViewProps) {
  const lines = useMemo(() => parseUnifiedPatch(patch), [patch]);

  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">Sem diff de texto (arquivo binário ou vazio).</p>;
  }

  return (
    <pre data-slot="diff" className={cn(diffBodyClass, 'rounded-md border border-border')}>
      {lines.map((line, index) => {
        const mark = MARK[line.kind];
        return (
          <DiffLine key={index} kind={line.kind}>
            {mark === undefined ? line.text : `${mark} ${line.text}`}
          </DiffLine>
        );
      })}
    </pre>
  );
}
