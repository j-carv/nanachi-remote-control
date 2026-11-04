import type { AvailableCommand } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { filterCommands, insertCommand, slashQuery, splitCommand } from './commands.js';

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
