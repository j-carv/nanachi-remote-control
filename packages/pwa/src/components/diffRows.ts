import { diffLines } from 'diff';

export interface DiffRow {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

/** Diff por linha, achatado em linhas com tipo (para pintar +/− sem `<pre>` aninhado). */
export function diffRows(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const part of diffLines(oldText, newText)) {
    const kind = part.added ? 'add' : part.removed ? 'del' : 'ctx';
    const lines = part.value.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const text of lines) rows.push({ kind, text });
  }
  return rows;
}
