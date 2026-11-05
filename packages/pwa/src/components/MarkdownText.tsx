import { memo, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { stripAnsi } from '../chat/ansi.js';
import { splitMarkdownBlocks } from './markdownBlocks.js';

const REMARK_PLUGINS = [remarkGfm];

/**
 * Typography for the markdown elements, without @tailwindcss/typography: descendant variants on the wrapper.
 * `[&_:not(pre)>code]` is inline code; code inside a block is styled by the `pre` rule.
 */
const MARKDOWN_CLASS = [
  'space-y-3 break-words text-base leading-6 text-foreground',
  '[&_h1]:pt-2 [&_h1]:text-xl [&_h1]:leading-7 [&_h1]:font-semibold [&_h1]:tracking-tight',
  '[&_h2]:pt-2 [&_h2]:text-lg [&_h2]:leading-7 [&_h2]:font-semibold',
  '[&_h3]:font-semibold [&_h4]:font-semibold',
  '[&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5',
  '[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-muted-foreground',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_hr]:border-border',
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5',
  '[&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.875em]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3',
  '[&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-5 [&_pre]:whitespace-pre',
  '[&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:overflow-x-auto',
  '[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold',
  '[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top',
].join(' ');

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

/**
 * Markdown do agente (GFM). HTML cru não é renderizado. Escapes ANSI (cores do omp `/usage`) saem antes do parse;
 * o texto guardado continua cru.
 */
export function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(stripAnsi(text)), [text]);
  return (
    <div data-slot="markdown" className={MARKDOWN_CLASS}>
      {blocks.map((block, index) => (
        // Blocos só são acrescentados ao fim (o texto do agente cresce), então o índice é uma chave estável.
        <MarkdownBlock key={index} text={block} />
      ))}
    </div>
  );
}
