import type { AvailableCommand, SessionConfigOption } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import {
  bareCommandName,
  commandSheetFor,
  configSheetChoices,
  filterCommands,
  insertCommand,
  nativePickerFor,
  parseHintChoices,
  slashQuery,
  splitCommand,
} from './commands.js';

const COMMANDS: AvailableCommand[] = [
  { name: 'loop', description: 'Repete um prompt em intervalo', hint: '[intervalo] [prompt]' },
  { name: 'mcp', description: 'Servidores MCP', hint: null },
  { name: 'skill:brainstorming', description: 'Use antes de criar algo novo', hint: 'argumentos' },
  { name: 'review', description: 'Revisa o diff; loop de correção', hint: null },
  { name: 'compact', description: 'Resume a conversa', hint: null },
];

describe('slashQuery', () => {
  it('é a busca quando o texto antes do cursor é / seguido de nome, sem espaço', () => {
    expect(slashQuery('/', 1)).toBe('');
    expect(slashQuery('/lo', 3)).toBe('lo');
    expect(slashQuery('/lo mais', 3)).toBe('lo');
    expect(slashQuery('/loop', 3)).toBe('lo');
  });

  it('não abre quando a barra não está no começo, há espaço antes do cursor ou não há barra', () => {
    expect(slashQuery('oi /lo', 6)).toBeUndefined();
    expect(slashQuery(' /lo', 4)).toBeUndefined();
    expect(slashQuery('/loop 5m', 8)).toBeUndefined();
    expect(slashQuery('lo', 2)).toBeUndefined();
    expect(slashQuery('', 0)).toBeUndefined();
  });

  it('usa o cursor, não o fim do texto', () => {
    expect(slashQuery('/loop oi', 1)).toBe('');
    expect(slashQuery('/\nx', 1)).toBe('');
    expect(slashQuery('/lo\nx', 5)).toBeUndefined();
  });
});

describe('filterCommands', () => {
  it('sem busca, devolve todos na ordem em que o agente anunciou', () => {
    expect(filterCommands(COMMANDS, '').map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(filterCommands(COMMANDS, '   ').map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
  });

  it('ranqueia: nome que começa com a busca antes de nome que contém, e este antes de descrição', () => {
    expect(filterCommands(COMMANDS, 'lo').map((c) => c.name)).toEqual(['loop', 'review']);
    // 'compact' começa com "co"; 'review' só casa pela descrição ("correção").
    expect(filterCommands(COMMANDS, 'co').map((c) => c.name)).toEqual(['compact', 'review']);
  });

  it('encontra skill pelo meio do nome e não ignora maiúsculas', () => {
    expect(filterCommands(COMMANDS, 'BRAIN').map((c) => c.name)).toEqual(['skill:brainstorming']);
  });

  it('acha pela descrição quando o nome não casa', () => {
    expect(filterCommands(COMMANDS, 'servidores').map((c) => c.name)).toEqual(['mcp']);
  });

  it('lista vazia quando nada casa', () => {
    expect(filterCommands(COMMANDS, 'xyz')).toEqual([]);
    expect(filterCommands([], 'lo')).toEqual([]);
  });
});

describe('insertCommand', () => {
  it('no gatilho digitado, troca o /busca do começo por /<nome> e mantém o resto do texto', () => {
    expect(insertCommand('/lo', 3, 'loop', 'typed')).toEqual({ text: '/loop ', caret: 6 });
    expect(insertCommand('/lo 5m', 3, 'loop', 'typed')).toEqual({ text: '/loop 5m', caret: 6 });
    expect(insertCommand('/l', 2, 'loop', 'typed')).toEqual({ text: '/loop ', caret: 6 });
  });

  it('com o cursor no meio da busca, o resto depois do cursor fica depois do comando', () => {
    expect(insertCommand('/lxo tudo', 2, 'loop', 'typed')).toEqual({ text: '/loop xo tudo', caret: 6 });
  });

  it('pelo botão, põe /<nome> antes do texto que já estava digitado', () => {
    expect(insertCommand('', 0, 'mcp', 'prefix')).toEqual({ text: '/mcp ', caret: 5 });
    expect(insertCommand('  revisa isso', 0, 'review', 'prefix')).toEqual({ text: '/review revisa isso', caret: 8 });
  });

  it('nome com dois pontos (skill) entra inteiro', () => {
    expect(insertCommand('/skill', 6, 'skill:brainstorming', 'typed').text).toBe('/skill:brainstorming ');
  });
});

describe('splitCommand', () => {
  it('separa o primeiro token quando a mensagem começa com /', () => {
    expect(splitCommand('/loop 5m verificar o build')).toEqual({ command: '/loop', rest: ' 5m verificar o build' });
    expect(splitCommand('/mcp')).toEqual({ command: '/mcp', rest: '' });
    expect(splitCommand('/skill:brainstorming\nmais')).toEqual({ command: '/skill:brainstorming', rest: '\nmais' });
  });

  it('não destaca quando não é comando', () => {
    expect(splitCommand('oi /loop')).toBeUndefined();
    expect(splitCommand('/')).toBeUndefined();
    expect(splitCommand('/ loop')).toBeUndefined();
    expect(splitCommand('')).toBeUndefined();
  });
});

function selectOption(id: string, category: string | null, values: readonly string[]): SessionConfigOption {
  return {
    id,
    name: id,
    category,
    type: 'select',
    currentValue: values[0] ?? '',
    options: values.map((value) => ({ value, name: value })),
  };
}

const OMP_LIKE_OPTIONS: SessionConfigOption[] = [
  selectOption('mode', 'mode', ['default', 'plan']),
  selectOption('model', 'model', ['fast', 'slow']),
  selectOption('thought', 'thought_level', ['low', 'high']),
  { id: 'ultra', name: 'Ultra', category: 'model_config', type: 'boolean', currentValue: false },
];

describe('nativePickerFor', () => {
  it('maps model to the model category, effort to thought_level and mode/permissions/approvals to mode', () => {
    expect(nativePickerFor('model', OMP_LIKE_OPTIONS)?.id).toBe('model');
    expect(nativePickerFor('effort', OMP_LIKE_OPTIONS)?.id).toBe('thought');
    expect(nativePickerFor('mode', OMP_LIKE_OPTIONS)?.id).toBe('mode');
    expect(nativePickerFor('permissions', OMP_LIKE_OPTIONS)?.id).toBe('mode');
    expect(nativePickerFor('approvals', OMP_LIKE_OPTIONS)?.id).toBe('mode');
  });

  it('returns the select option itself, with its choices', () => {
    const picker = nativePickerFor('model', OMP_LIKE_OPTIONS);
    expect(picker?.options.map((choice) => choice.value)).toEqual(['fast', 'slow']);
  });

  it('is undefined when the session has no option of the mapped category', () => {
    const onlyMode = [selectOption('mode', 'mode', ['default'])];
    expect(nativePickerFor('model', onlyMode)).toBeUndefined();
    expect(nativePickerFor('effort', onlyMode)).toBeUndefined();
    expect(nativePickerFor('model', [])).toBeUndefined();
  });

  it('ignores boolean options and commands that map to nothing', () => {
    const onlyBoolean: SessionConfigOption[] = [
      { id: 'model', name: 'Model', category: 'model', type: 'boolean', currentValue: true },
    ];
    expect(nativePickerFor('model', onlyBoolean)).toBeUndefined();
    expect(nativePickerFor('loop', OMP_LIKE_OPTIONS)).toBeUndefined();
    expect(nativePickerFor('mcp', OMP_LIKE_OPTIONS)).toBeUndefined();
  });

  it('matches the command name exactly', () => {
    expect(nativePickerFor('models', OMP_LIKE_OPTIONS)).toBeUndefined();
    expect(nativePickerFor('skill:model', OMP_LIKE_OPTIONS)).toBeUndefined();
  });
});

describe('parseHintChoices', () => {
  it('reads a bracketed alternation whose trailing argument is shared by enable and disable (claude /mcp)', () => {
    expect(parseHintChoices('[reconnect|enable|disable [<server>|all]]')).toEqual({
      optional: true,
      choices: [
        { value: 'reconnect', takesArgument: false },
        { value: 'enable', takesArgument: true },
        { value: 'disable', takesArgument: true },
      ],
    });
  });

  it('reads an angled alternation as required (claude /effort), with 7 choices', () => {
    const parsed = parseHintChoices('<low|medium|high|xhigh|max|auto|ultracode [on|off]>');
    expect(parsed?.optional).toBe(false);
    expect(parsed?.choices.map((choice) => choice.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'auto',
      'ultracode',
    ]);
    // `[on|off]` has no placeholder, so it belongs to ultracode alone: the others send at once.
    expect(parsed?.choices.filter((choice) => choice.takesArgument).map((choice) => choice.value)).toEqual([
      'ultracode',
    ]);
  });

  it('reads a plain bracketed list (omp /plugins)', () => {
    expect(parseHintChoices('[list|enable|disable]')).toEqual({
      optional: true,
      choices: [
        { value: 'list', takesArgument: false },
        { value: 'enable', takesArgument: false },
        { value: 'disable', takesArgument: false },
      ],
    });
  });

  it('shares a trailing argument with the alternatives after the first only when it has a placeholder', () => {
    expect(parseHintChoices('[info|delete|pin [account]]')?.choices).toEqual([
      { value: 'info', takesArgument: false },
      { value: 'delete', takesArgument: false },
      { value: 'pin', takesArgument: true },
    ]);
    expect(parseHintChoices('[a|b|c [<x>]]')?.choices.map((choice) => choice.takesArgument)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('keeps the nested argument of the last choice (omp /usage)', () => {
    expect(parseHintChoices('[show|reset [provider/credential-id|provider/active]]')?.choices).toEqual([
      { value: 'show', takesArgument: false },
      { value: 'reset', takesArgument: true },
    ]);
  });

  it('reads a single bracketed literal as one optional choice (codex /mcp)', () => {
    expect(parseHintChoices('[reconnect]')).toEqual({
      optional: true,
      choices: [{ value: 'reconnect', takesArgument: false }],
    });
  });

  it('reads the omp /session alternation', () => {
    expect(parseHintChoices('[info|delete|pin [account]]')?.choices.map((choice) => choice.value)).toEqual([
      'info',
      'delete',
      'pin',
    ]);
  });

  it('ignores whitespace around the hint', () => {
    expect(parseHintChoices('  [list|enable]  ')?.choices).toHaveLength(2);
  });

  it('is undefined for hints that are not choices', () => {
    expect(parseHintChoices(null)).toBeUndefined();
    expect(parseHintChoices('')).toBeUndefined();
    expect(parseHintChoices('<subcommand>')).toBeUndefined();
    expect(parseHintChoices('<model>')).toBeUndefined();
    expect(parseHintChoices('<texto>')).toBeUndefined();
    expect(parseHintChoices('key=value')).toBeUndefined();
    expect(parseHintChoices('arguments')).toBeUndefined();
    expect(parseHintChoices('argumentos')).toBeUndefined();
    expect(parseHintChoices('[interval] [prompt]')).toBeUndefined();
    expect(parseHintChoices('[intervalo] [prompt]')).toBeUndefined();
  });

  it('is undefined for placeholders inside alternatives and for empty alternatives', () => {
    expect(parseHintChoices('[<server>|all]')).toBeUndefined();
    expect(parseHintChoices('[a||b]')).toBeUndefined();
    expect(parseHintChoices('[]')).toBeUndefined();
    expect(parseHintChoices('[<server>]')).toBeUndefined();
  });

  it('is undefined when the group does not end the hint', () => {
    expect(parseHintChoices('[reconnect] extra')).toBeUndefined();
    expect(parseHintChoices('[a|b] [c|d]')).toBeUndefined();
  });
});

describe('bareCommandName', () => {
  it('is the name when the whole message is one command with no arguments', () => {
    expect(bareCommandName('/model')).toBe('model');
    expect(bareCommandName('  /model  ')).toBe('model');
    expect(bareCommandName('/skill:brainstorming')).toBe('skill:brainstorming');
  });

  it('is undefined when there are arguments, no slash or nothing after the slash', () => {
    expect(bareCommandName('/model opus')).toBeUndefined();
    expect(bareCommandName('/model\nopus')).toBeUndefined();
    expect(bareCommandName('model')).toBeUndefined();
    expect(bareCommandName('/')).toBeUndefined();
    expect(bareCommandName('')).toBeUndefined();
  });
});

describe('commandSheetFor', () => {
  const loop = { name: 'loop', hint: '[intervalo] [prompt]' };

  it('opens the native picker when the command maps to a select option of the session', () => {
    expect(commandSheetFor({ name: 'model', hint: null }, OMP_LIKE_OPTIONS)).toEqual({
      kind: 'config',
      name: 'model',
      option: OMP_LIKE_OPTIONS[1],
    });
  });

  it('prefers the native picker over the hint choices', () => {
    const sheet = commandSheetFor({ name: 'effort', hint: '<low|high>' }, OMP_LIKE_OPTIONS);
    expect(sheet?.kind).toBe('config');
  });

  it('opens the subcommand sheet when the hint has choices and no native picker applies', () => {
    expect(commandSheetFor({ name: 'mcp', hint: '[reconnect]' }, OMP_LIKE_OPTIONS)).toEqual({
      kind: 'choices',
      name: 'mcp',
      hint: { optional: true, choices: [{ value: 'reconnect', takesArgument: false }] },
    });
  });

  it('is undefined for a command that keeps the current behavior (insert into the composer)', () => {
    expect(commandSheetFor(loop, OMP_LIKE_OPTIONS)).toBeUndefined();
    expect(commandSheetFor({ name: 'model', hint: null }, [])).toBeUndefined();
  });
});

describe('configSheetChoices', () => {
  const modelOption = (
    options: Array<{ value: string; name: string; description?: string | null; group?: string }>,
    currentValue: string,
    category: string | null = 'model',
  ): Extract<SessionConfigOption, { type: 'select' }> => ({
    id: 'model',
    name: 'Modelo',
    category,
    type: 'select',
    currentValue,
    options: options.map((option) => ({ ...option, description: option.description ?? null })),
  });

  it('sections a model list by provider, in first-appearance order, with the vendor in the label', () => {
    const choices = configSheetChoices(
      modelOption(
        [
          { value: 'cursor/a', name: 'Claude Opus 5.5' },
          { value: 'openrouter/~anthropic/claude-opus-latest', name: 'Claude Opus latest' },
          { value: 'cursor/b', name: 'GPT-5' },
          { value: 'claude-cli/opus', name: 'Claude Opus 5.5' },
        ],
        'claude-cli/opus',
      ),
    );

    expect(choices.map((choice) => [choice.section, choice.label, choice.value])).toEqual([
      ['Cursor', 'Claude Opus 5.5', 'cursor/a'],
      ['Cursor', 'GPT-5', 'cursor/b'],
      ['OpenRouter', 'Claude Opus latest · Anthropic', 'openrouter/~anthropic/claude-opus-latest'],
      ['Claude CLI', 'Claude Opus 5.5', 'claude-cli/opus'],
    ]);
  });

  it('marks only the current value as checked, even when its name repeats under another provider', () => {
    const choices = configSheetChoices(
      modelOption(
        [
          { value: 'cursor/opus', name: 'Claude Opus 5.5' },
          { value: 'claude-cli/opus', name: 'Claude Opus 5.5' },
        ],
        'claude-cli/opus',
      ),
    );

    expect(choices.filter((choice) => choice.checked).map((choice) => [choice.section, choice.value])).toEqual([
      ['Claude CLI', 'claude-cli/opus'],
    ]);
    expect(choices.filter((choice) => !choice.checked)).toHaveLength(1);
  });

  it('puts options without a provider last, under "Outros"', () => {
    const choices = configSheetChoices(
      modelOption(
        [
          { value: 'default', name: 'Padrão' },
          { value: 'cursor/a', name: 'A' },
          { value: 'claude-cli/b', name: 'B' },
        ],
        'default',
      ),
    );

    expect(choices.map((choice) => [choice.section, choice.value])).toEqual([
      ['Cursor', 'cursor/a'],
      ['Claude CLI', 'claude-cli/b'],
      ['Outros', 'default'],
    ]);
    expect(choices.at(-1)?.checked).toBe(true);
  });

  it('uses the ACP group name as the section and keeps the bare name in the label', () => {
    const choices = configSheetChoices(
      modelOption(
        [
          { value: 'openrouter/~anthropic/x', name: 'X', group: 'Alpha' },
          { value: 'cursor/y', name: 'Y', group: 'Beta' },
        ],
        'cursor/y',
      ),
    );

    expect(choices.map((choice) => [choice.section, choice.label])).toEqual([
      ['Alpha', 'X'],
      ['Beta', 'Y'],
    ]);
  });

  it('passes the description as detail, undefined when there is none', () => {
    const choices = configSheetChoices(
      modelOption(
        [
          { value: 'cursor/a', name: 'A', description: 'Rápido' },
          { value: 'claude-cli/b', name: 'B' },
        ],
        'cursor/a',
      ),
    );

    expect(choices.map((choice) => choice.detail)).toEqual(['Rápido', undefined]);
  });

  it('keeps a single-provider or provider-less model list flat: no section, the bare name', () => {
    const single = configSheetChoices(
      modelOption(
        [
          { value: 'cursor/a', name: 'A' },
          { value: 'cursor/b', name: 'B' },
        ],
        'cursor/b',
      ),
    );
    const claude = configSheetChoices(
      modelOption(
        [
          { value: 'default', name: 'Padrão' },
          { value: 'opus', name: 'Opus' },
        ],
        'opus',
      ),
    );

    for (const choices of [single, claude]) {
      expect(choices.every((choice) => choice.section === undefined)).toBe(true);
    }
    expect(single.map((choice) => choice.label)).toEqual(['A', 'B']);
    expect(single.map((choice) => choice.checked)).toEqual([false, true]);
    expect(claude.map((choice) => choice.label)).toEqual(['Padrão', 'Opus']);
  });

  it('never sections a select that is not the model picker, whatever its values look like', () => {
    const mode: Extract<SessionConfigOption, { type: 'select' }> = {
      id: 'mode',
      name: 'Acesso',
      category: 'mode',
      type: 'select',
      currentValue: 'cursor/x',
      options: [
        { value: 'cursor/x', name: 'Cursor X' },
        { value: 'claude-cli/y', name: 'Claude Y' },
      ],
    };

    const choices = configSheetChoices(mode);

    expect(choices.every((choice) => choice.section === undefined)).toBe(true);
    expect(choices.map((choice) => choice.label)).toEqual(['Cursor X', 'Claude Y']);
  });
});
