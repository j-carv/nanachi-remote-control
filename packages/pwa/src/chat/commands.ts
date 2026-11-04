import type { AvailableCommand } from '@nanachi/shared';

/**
 * Lógica do menu de comandos do agente (sem React). Um comando vai como texto `/<nome> <args>`: o daemon não
 * conhece comandos, então tudo aqui é sobre o texto do composer.
 */

/**
 * Busca do menu quando o texto antes do cursor é `/` seguido de nome, sem espaço nem quebra de linha, e a barra é
 * o primeiro caractere. Devolve a busca (o que vem depois da barra), ou undefined se o menu não deve abrir.
 */
export function slashQuery(text: string, caret: number): string | undefined {
  const head = text.slice(0, caret);
  const match = /^\/(\S*)$/.exec(head);
  return match?.[1];
}

/** Rank de um comando para a busca: 0 nome começa com ela, 1 nome contém, 2 descrição contém, undefined não casa. */
function rankOf(command: AvailableCommand, query: string): number | undefined {
  const name = command.name.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (command.description.toLowerCase().includes(query)) return 2;
  return undefined;
}

/**
 * Filtra e ranqueia os comandos pela busca (sem diferença de maiúsculas). Empate mantém a ordem do agente.
 * Busca vazia devolve todos, na ordem do agente.
 */
export function filterCommands(commands: readonly AvailableCommand[], query: string): AvailableCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...commands];
  const ranked: Array<{ command: AvailableCommand; rank: number }> = [];
  for (const command of commands) {
    const rank = rankOf(command, needle);
    if (rank !== undefined) ranked.push({ command, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.command);
}

export interface InsertResult {
  text: string;
  caret: number;
}

/**
 * Insere `/<nome> ` no composer.
 * - `typed`: o menu abriu porque o usuário digitou `/busca` no começo. Esse trecho é trocado pelo comando e o resto
 *   do texto (depois do cursor) continua depois dele.
 * - `prefix`: o menu abriu pelo botão `/`. O comando vai antes do texto que já estava digitado.
 */
export function insertCommand(text: string, caret: number, name: string, mode: 'typed' | 'prefix'): InsertResult {
  const command = `/${name} `;
  if (mode === 'typed') {
    const rest = text.slice(caret).replace(/^ /, '');
    return { text: `${command}${rest}`, caret: command.length };
  }
  const rest = text.replace(/^\s+/, '');
  return { text: `${command}${rest}`, caret: command.length };
}

/** Primeiro token de uma mensagem que começa com `/nome`, e o resto. Undefined se a mensagem não é um comando. */
export function splitCommand(text: string): { command: string; rest: string } | undefined {
  const match = /^(\/\S+)([\s\S]*)$/.exec(text);
  if (match === null) return undefined;
  return { command: match[1] ?? '', rest: match[2] ?? '' };
}
