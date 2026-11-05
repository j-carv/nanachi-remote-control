import { useMemo, useState } from 'react';
import type { ToolContent } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { toolImageInfo } from '../files/toolImage.js';
import { clipText } from './clipLines.js';
import { DiffView } from './DiffView.js';
import { ImageThumb } from './ImageThumb.js';
import { ShowAll } from './ShowAll.js';

interface ToolContentViewProps {
  api: ApiClient;
  content: ToolContent;
}

/** Linhas de saída de texto mostradas antes de "Mostrar tudo". */
export const OUTPUT_PREVIEW_LINES = 12;

/** Saída de texto longa: primeiras linhas e "Mostrar tudo". Rola na horizontal dentro do bloco. */
function TextOutput({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const clipped = useMemo(() => clipText(text, OUTPUT_PREVIEW_LINES), [text]);
  const shown = expanded ? text : clipped.text;

  return (
    <>
      <pre className="m-0 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[13px] leading-5 whitespace-pre text-foreground">
        {shown}
      </pre>
      <ShowAll hidden={expanded ? 0 : clipped.hidden} onExpand={() => setExpanded(true)} />
    </>
  );
}

/** Conteúdo de tool call ou de pedido de permissão: texto, diff, ou imagem como miniatura. */
export function ToolContentView({ api, content }: ToolContentViewProps) {
  if (content.type === 'text') return <TextOutput text={content.text} />;
  if (content.type === 'image') return <ImageThumb api={api} file={toolImageInfo(content.fileId, content.mime)} />;
  return <DiffView path={content.path} oldText={content.oldText} newText={content.newText} />;
}
