export interface Clipped<T> {
  shown: T[];
  hidden: number;
}

/** Mantém só os primeiros `max` itens e conta o resto (para "Mostrar tudo (N)"). */
export function clipList<T>(items: readonly T[], max: number): Clipped<T> {
  return { shown: items.slice(0, max), hidden: Math.max(0, items.length - max) };
}

export interface ClippedText {
  text: string;
  hidden: number;
}

/** Mesmo corte, por linha. Texto vazio tem zero linhas. */
export function clipText(text: string, maxLines: number): ClippedText {
  if (text === '') return { text: '', hidden: 0 };
  const lines = text.split('\n');
  const kept = clipList(lines, maxLines);
  return { text: kept.shown.join('\n'), hidden: kept.hidden };
}
