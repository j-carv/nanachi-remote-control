import { memo, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMarkdownBlocks } from './markdownBlocks.js';

const REMARK_PLUGINS = [remarkGfm];

interface ImageProps {
  src?: string | undefined;
  alt?: string | undefined;
}

/**
 * Imagem do markdown não é carregada: carregar uma URL remota expõe o IP do iPhone e permite rastreio.
 * Vira um link de texto que abre em outra aba.
 */
function ImageAsLink({ src, alt }: ImageProps) {
  const label = alt === undefined || alt.length === 0 ? 'imagem' : `imagem: ${alt}`;
  return (
    <a href={src || undefined} rel="noopener noreferrer" target="_blank">
      {label}
    </a>
  );
}

const COMPONENTS = { img: ImageAsLink };

/** Um bloco de markdown. Memorizado: bloco já completo não é reanalisado quando o texto cresce. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {text}
    </Markdown>
  );
});

/** Markdown do agente (GFM). HTML cru não é renderizado. */
export function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <div className="markdown">
      {blocks.map((block, index) => (
        // Blocos só são acrescentados ao fim (o texto do agente cresce), então o índice é uma chave estável.
        <MarkdownBlock key={index} text={block} />
      ))}
    </div>
  );
}
