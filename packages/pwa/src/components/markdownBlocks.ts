const FENCE = /^\s*(```|~~~)/;

/**
 * Divide o markdown em blocos separados por linha em branco, sem separar um bloco de código.
 * Cada bloco é renderizado à parte e memorizado: num texto em streaming só o último bloco muda.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const close = () => {
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };

  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? '';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }

    if (fence === null && line.trim() === '') {
      close();
      continue;
    }
    current.push(line);
  }
  close();

  return blocks;
}
