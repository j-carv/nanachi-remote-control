export type PatchLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

/** Linha de um patch unificado. `text` vem sem o marcador (+, -, espaço). */
export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Quantas linhas o cabeçalho `@@ -a,b +c,d @@` ainda promete: `b` (antigo) e `d` (novo).
 * Contagem omitida vale 1. Dentro dessa contagem, `---`/`+++` são conteúdo, não cabeçalho.
 */
function hunkCounts(header: string): { old: number; new: number } {
  const match = HUNK_HEADER.exec(header);
  return {
    old: Number(match?.[1] ?? 1),
    new: Number(match?.[2] ?? 1),
  };
}

/**
 * Parser de patch unificado (saída do `git diff`). Dentro de um hunk, conta as linhas que o
 * cabeçalho promete; fora dele, tudo que não é `@@` é cabeçalho (`diff --git`, `index`, `---`,
 * `+++`, modo, `\ No newline…`). Puro: sem DOM, testável.
 */
export function parseUnifiedPatch(patch: string): PatchLine[] {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const out: PatchLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of lines) {
    const inHunk = oldLeft > 0 || newLeft > 0;

    if (inHunk && line.startsWith('\\')) {
      out.push({ kind: 'meta', text: line });
    } else if (inHunk && line.startsWith('+')) {
      newLeft--;
      out.push({ kind: 'add', text: line.slice(1) });
    } else if (inHunk && line.startsWith('-')) {
      oldLeft--;
      out.push({ kind: 'del', text: line.slice(1) });
    } else if (inHunk && (line.startsWith(' ') || line === '')) {
      oldLeft--;
      newLeft--;
      out.push({ kind: 'ctx', text: line.slice(1) });
    } else if (line.startsWith('@@')) {
      const counts = hunkCounts(line);
      oldLeft = counts.old;
      newLeft = counts.new;
      out.push({ kind: 'hunk', text: line });
    } else {
      out.push({ kind: 'meta', text: line });
    }
  }
  return out;
}
