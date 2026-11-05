import { describe, expect, it } from 'vitest';
import { stripPromptNotes } from './promptNotes.js';

// The same blocks the daemon appends to the ACP prompt (acp-mapping.ts, session-manager.ts). Synthetic copies.
const PHONE_HINT =
  '[Nanachi Remote] O usuário está no celular. Para mandar um arquivo ou imagem a ele, rode no terminal: phone-send "<caminho>" (opcional: --caption "texto"). Para mandar uma print da tela do PC: phone-send --screenshot.';
const LOOP_INSTRUCTION = [
  '[Nanachi Remote] Esta execução faz parte de um loop que se repete. No fim da sua resposta, em linha própria, escreva um destes marcadores:',
  '[[nanachi-loop-next: <duração>]] para o tempo até a próxima execução, por exemplo 90s, 10m ou 2h (mínimo 30s, máximo 24h).',
  '[[nanachi-loop-stop]] se a tarefa estiver concluída e o loop não precisa continuar.',
  'Sem marcador, a próxima execução acontece em 10 minutos.',
].join('\n');

describe('stripPromptNotes', () => {
  it('texto do usuário sem aviso volta igual', () => {
    expect(stripPromptNotes('revise os testes')).toBe('revise os testes');
    expect(stripPromptNotes('  com espaços no fim  ')).toBe('  com espaços no fim  ');
  });

  it('remove o bloco da instrução do loop que vem no fim (replay do agente)', () => {
    expect(stripPromptNotes(`revise os testes\n\n${LOOP_INSTRUCTION}`)).toBe('revise os testes');
  });

  it('remove o aviso do phone-send e a instrução do loop juntos (aviso antes)', () => {
    expect(stripPromptNotes(`revise os testes\n\n${PHONE_HINT}\n\n${LOOP_INSTRUCTION}`)).toBe('revise os testes');
  });

  it('remove o aviso do phone-send sozinho', () => {
    expect(stripPromptNotes(`oi\n\n${PHONE_HINT}`)).toBe('oi');
  });

  it('replay com os blocos colados sem separador (o daemon concatena chunks) também sai limpo', () => {
    expect(stripPromptNotes(`revise os testes${PHONE_HINT}${LOOP_INSTRUCTION}`)).toBe('revise os testes');
  });

  it('texto que só menciona o Nanachi Remote, sem o bloco exato, fica', () => {
    expect(stripPromptNotes('[Nanachi Remote] é o nome do app')).toBe('[Nanachi Remote] é o nome do app');
  });

  it('mensagem que era só o aviso fica vazia', () => {
    expect(stripPromptNotes(LOOP_INSTRUCTION)).toBe('');
  });
});
