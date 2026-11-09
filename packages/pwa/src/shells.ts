import type { ShellsResponse } from '@nanachi/shared';

export type ShellEntry = ShellsResponse['shells'][number];

/** Shell padrão primeiro; os demais seguem a ordem que o daemon mandou. */
export function orderShells(shells: readonly ShellEntry[]): ShellEntry[] {
  return [...shells.filter((shell) => shell.isDefault), ...shells.filter((shell) => !shell.isDefault)];
}
