import { ShellIdSchema, type ShellId, type ShellsResponse } from '@nanachi/shared';

export type ShellEntry = ShellsResponse['shells'][number];

/** Prefixo do título de um terminal de workspace (o daemon grava `Terminal · <id do shell>`). */
export const SHELL_TITLE_PREFIX = 'Terminal · ';

/** Shell de um terminal pelo título da sessão, para abrir outro igual ("Abrir novo terminal"). */
export function shellIdFromTitle(title: string): ShellId | null {
  if (!title.startsWith(SHELL_TITLE_PREFIX)) return null;
  const parsed = ShellIdSchema.safeParse(title.slice(SHELL_TITLE_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

/** Shell padrão primeiro; os demais seguem a ordem que o daemon mandou. */
export function orderShells(shells: readonly ShellEntry[]): ShellEntry[] {
  return [...shells.filter((shell) => shell.isDefault), ...shells.filter((shell) => !shell.isDefault)];
}
