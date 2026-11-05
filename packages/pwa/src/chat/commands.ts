import type { AvailableCommand, SessionConfigOption } from '@nanachi/shared';
import { choiceLabel, modelGroupsOf } from './modelSource.js';

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

/**
 * Config option that a command opens as a native picker (the header selector's option, through the same setConfig).
 * Only the categories the agents use: omp and claude send `model`, `thought_level` and `mode`.
 */
const NATIVE_PICKER_CATEGORY: Record<string, string> = {
  model: 'model',
  effort: 'thought_level',
  mode: 'mode',
  permissions: 'mode',
  approvals: 'mode',
};

/**
 * The select option that a bare command should open as a sheet, or undefined when the command sends text as usual.
 * Only select options count (a boolean with the same category has no list to show).
 */
export function nativePickerFor(
  commandName: string,
  configOptions: readonly SessionConfigOption[],
): Extract<SessionConfigOption, { type: 'select' }> | undefined {
  const category = NATIVE_PICKER_CATEGORY[commandName];
  if (category === undefined) return undefined;
  const found = configOptions.find((option) => option.category === category && option.type === 'select');
  return found?.type === 'select' ? found : undefined;
}

export interface HintChoice {
  /** Literal word the command takes (`reconnect`). */
  value: string;
  /** The choice takes more text after it (`enable [<server>|all]`): the composer gets the rest. */
  takesArgument: boolean;
}

export interface HintChoices {
  /** `[...]` in the hint: the command also works with no argument. `<...>` is required. */
  optional: boolean;
  choices: HintChoice[];
}

const OPENERS = '[<';
const CLOSERS = ']>';
const LITERAL_WORD = /^\w[\w.-]*/;

/** Index of the bracket that closes the group opened at position 0, or -1. Nested `[`/`<` groups are counted. */
function closingIndex(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

/** Splits on `|` outside nested brackets. */
function splitAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner.charAt(index);
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) depth -= 1;
    else if (char === '|' && depth === 0) {
      parts.push(inner.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

/**
 * Choices of a command hint, for the subcommand sheet. Only a hint that is one group, `[a|b]` or `<a|b>`, counts,
 * with literal words as alternatives; a single `[word]` counts too. Placeholders (`<subcommand>`, `<model>`),
 * `key=value`, free text and hints with more than one group (`[interval] [prompt]`) are not choices.
 */
export function parseHintChoices(hint: string | null): HintChoices | undefined {
  if (hint === null) return undefined;
  const text = hint.trim();
  const opener = text.charAt(0);
  if (opener !== '[' && opener !== '<') return undefined;
  const end = closingIndex(text);
  if (end === -1 || end !== text.length - 1) return undefined;

  const alternatives = splitAlternatives(text.slice(1, end));
  // `<word>` alone is a placeholder, not a choice; `[word]` alone is a choice (`[reconnect]`).
  if (alternatives.length === 1 && opener === '<') return undefined;

  const parsed: Array<{ value: string; rest: string }> = [];
  for (const alternative of alternatives) {
    const trimmed = alternative.trim();
    const word = LITERAL_WORD.exec(trimmed)?.[0];
    if (word === undefined) return undefined;
    const rest = trimmed.slice(word.length).trim();
    if (rest !== '' && rest.charAt(0) !== '[' && rest.charAt(0) !== '<') return undefined;
    parsed.push({ value: word, rest });
  }

  // The hint does not say which alternatives take the trailing argument. A tail with a placeholder (`[<server>|all]`)
  // is read as shared by the alternatives after the first one: `[reconnect|enable|disable [<server>|all]]` means enable
  // and disable take it, reconnect does not. A tail with only literals (`[on|off]`) belongs to its own alternative.
  const last = parsed[parsed.length - 1]?.rest ?? '';
  const sharedTail = last.includes('<') ? last : '';
  const choices: HintChoice[] = parsed.map((entry, index) => ({
    value: entry.value,
    takesArgument: entry.rest !== '' || (index > 0 && sharedTail !== ''),
  }));
  return { optional: opener === '[', choices };
}

/** Name of a message that is only `/name` (surrounding spaces allowed). Undefined if it has arguments or no name. */
export function bareCommandName(text: string): string | undefined {
  const match = /^\/(\S+)$/.exec(text.trim());
  return match?.[1];
}

/** One row of the native picker sheet: a choice of a select option, ready to become an action sheet item. */
export interface ConfigSheetChoice {
  value: string;
  label: string;
  detail: string | undefined;
  /** The option's current value. */
  checked: boolean;
  /** Provider header (model picker spanning several providers); undefined for flat lists. */
  section: string | undefined;
}

/**
 * Rows of the native picker sheet for a select option. A model picker that spans providers gets one section per
 * provider, in the order of the select's `<optgroup>`s, with `name · vendor` labels. Every other list stays flat.
 */
export function configSheetChoices(
  option: Extract<SessionConfigOption, { type: 'select' }>,
): ConfigSheetChoice[] {
  const groups = modelGroupsOf(option);
  const row = (choice: (typeof option.options)[number], section: string | undefined): ConfigSheetChoice => ({
    value: choice.value,
    label: groups === undefined ? choice.name : choiceLabel(choice),
    detail: choice.description ?? undefined,
    checked: choice.value === option.currentValue,
    section,
  });
  return groups === undefined
    ? option.options.map((choice) => row(choice, undefined))
    : groups.flatMap((group) => group.options.map((choice) => row(choice, group.providerLabel)));
}

/** A sheet that a picked or sent command opens instead of going into the composer as text. */
export type CommandSheet =
  | { kind: 'config'; name: string; option: Extract<SessionConfigOption, { type: 'select' }> }
  | { kind: 'choices'; name: string; hint: HintChoices };

/**
 * The sheet for a command picked from the slash menu: the native picker when the session has the option, else the
 * subcommand sheet when the hint has choices. Undefined keeps today's behavior (insert the command in the composer).
 */
export function commandSheetFor(
  command: Pick<AvailableCommand, 'name' | 'hint'>,
  configOptions: readonly SessionConfigOption[],
): CommandSheet | undefined {
  const option = nativePickerFor(command.name, configOptions);
  if (option !== undefined) return { kind: 'config', name: command.name, option };
  const hint = parseHintChoices(command.hint);
  return hint === undefined ? undefined : { kind: 'choices', name: command.name, hint };
}
