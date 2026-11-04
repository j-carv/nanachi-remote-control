import { useMemo } from 'react';
import { parseUnifiedPatch, type PatchLineKind } from './unifiedPatch.js';

interface UnifiedPatchViewProps {
  patch: string;
}

/** Marcador exibido antes de cada linha de conteúdo (cabeçalhos ficam sem marcador). */
const MARK: Partial<Record<PatchLineKind, string>> = { add: '+', del: '−', ctx: ' ' };

/** Patch unificado com as mesmas cores do DiffView: adições verdes, remoções vermelhas. */
export function UnifiedPatchView({ patch }: UnifiedPatchViewProps) {
  const lines = useMemo(() => parseUnifiedPatch(patch), [patch]);

  if (lines.length === 0) {
    return <p className="muted small">Sem diff de texto (arquivo binário ou vazio).</p>;
  }

  return (
    <pre className="diff-body diff-unified">
      {lines.map((line, index) => {
        const mark = MARK[line.kind];
        return (
          <span key={index} className={`diff-line diff-${line.kind}`}>
            {mark === undefined ? line.text : `${mark} ${line.text}`}
          </span>
        );
      })}
    </pre>
  );
}
