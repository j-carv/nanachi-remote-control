/** Contagem de arquivos alterados no workspace, em pt-BR. */
export function changesLabel(count: number): string {
  if (count === 0) return 'sem alterações';
  if (count === 1) return '1 alteração';
  return `${count} alterações`;
}
