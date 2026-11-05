import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { splitLoopMarkers } from './loopMarkers.js';

const NEXT_45S = '[[nanachi-loop-next: 45s]]';
const STOP = '[[nanachi-loop-stop]]';

describe('splitLoopMarkers: marcadores completos', () => {
  it('marcador de tempo no fim do texto some e vira nota com a próxima rodada', () => {
    expect(splitLoopMarkers(`Passo feito. ${NEXT_45S}`)).toEqual({
      text: 'Passo feito.',
      note: 'Próxima rodada em 45 s',
    });
  });

  it('marcador numa linha própria some, com o texto em volta preservado', () => {
    expect(splitLoopMarkers(`Primeira linha\n${NEXT_45S}`)).toEqual({ text: 'Primeira linha', note: 'Próxima rodada em 45 s' });
    expect(splitLoopMarkers(`Antes\n  ${NEXT_45S}  \nDepois`).text).toBe('Antes\nDepois');
  });

  it('marcador entre crases ou em linha com espaços também some', () => {
    expect(splitLoopMarkers(`Feito\n\`${STOP}\``)).toEqual({ text: 'Feito', note: 'Loop encerrado pelo agente' });
    expect(splitLoopMarkers(`Feito\n\t${NEXT_45S}\t`).text).toBe('Feito');
  });

  it('parte de marcador de parada no fim: nota de encerramento', () => {
    expect(splitLoopMarkers(`Tudo pronto. ${STOP}`)).toEqual({ text: 'Tudo pronto.', note: 'Loop encerrado pelo agente' });
  });

  it('o último marcador bem formado manda na nota, como no daemon', () => {
    expect(splitLoopMarkers('[[nanachi-loop-next: 2m]] [[nanachi-loop-stop]]').note).toBe('Loop encerrado pelo agente');
    expect(splitLoopMarkers('[[nanachi-loop-stop]] [[nanachi-loop-next: 2m]]').note).toBe('Próxima rodada em 2 min');
  });

  it('duração fora do intervalo é limitada a 30 s e 24 h, como no daemon', () => {
    expect(splitLoopMarkers('[[nanachi-loop-next: 5s]]').note).toBe('Próxima rodada em 30 s');
    expect(splitLoopMarkers('[[nanachi-loop-next: 72h]]').note).toBe('Próxima rodada em 24 h');
  });

  it('duração de 20 min sai como "20 min"', () => {
    expect(splitLoopMarkers('Ok [[nanachi-loop-next: 20m]]')).toEqual({ text: 'Ok', note: 'Próxima rodada em 20 min' });
  });

  it('marcador malformado (placeholder ecoado) some do texto, sem nota', () => {
    expect(splitLoopMarkers('ecoei [[nanachi-loop-next: <duração>]]')).toEqual({ text: 'ecoei', note: null });
  });

  it('texto sem marcador volta igual, sem nota', () => {
    expect(splitLoopMarkers('Oi, tudo bem?\n')).toEqual({ text: 'Oi, tudo bem?\n', note: null });
    expect(splitLoopMarkers('')).toEqual({ text: '', note: null });
  });

  it('marcador só (sem texto antes) deixa o texto vazio e mantém a nota', () => {
    expect(splitLoopMarkers(NEXT_45S)).toEqual({ text: '', note: 'Próxima rodada em 45 s' });
  });
});

describe('splitLoopMarkers: marcador parcial no fim (streaming)', () => {
  it('prefixo de [[nanachi- no fim some até o texto completar', () => {
    expect(splitLoopMarkers('Feito. [[')).toEqual({ text: 'Feito.', note: null });
    expect(splitLoopMarkers('Feito. [[n')).toEqual({ text: 'Feito.', note: null });
    expect(splitLoopMarkers('Feito. [[nanachi')).toEqual({ text: 'Feito.', note: null });
    expect(splitLoopMarkers('Feito. [[nanachi-')).toEqual({ text: 'Feito.', note: null });
  });

  it('[[nanachi-loo no fim (o caso do chunk cortado) não aparece', () => {
    expect(splitLoopMarkers('Feito. [[nanachi-loo')).toEqual({ text: 'Feito.', note: null });
  });

  it('marcador incompleto de tempo, ou sem o último colchete, não aparece', () => {
    expect(splitLoopMarkers('Feito.\n[[nanachi-loop-next: 4')).toEqual({ text: 'Feito.', note: null });
    expect(splitLoopMarkers('Feito. [[nanachi-loop-next: 45s]')).toEqual({ text: 'Feito.', note: null });
  });

  it('um colchete só no fim não é marcador: continua visível', () => {
    expect(splitLoopMarkers('veja o array[')).toEqual({ text: 'veja o array[', note: null });
    expect(splitLoopMarkers('veja [')).toEqual({ text: 'veja [', note: null });
  });

  it('colchetes duplos que não são marcador no meio do texto ficam', () => {
    expect(splitLoopMarkers('use [[a]] aqui')).toEqual({ text: 'use [[a]] aqui', note: null });
  });

  it('nenhum prefixo da mensagem completa deixa "[[" ou "nanachi" à mostra', () => {
    const full = `Passo feito.\n${NEXT_45S}`;
    for (let length = 0; length <= full.length; length += 1) {
      const { text } = splitLoopMarkers(full.slice(0, length));
      expect(text, `prefixo de ${length} caracteres`).not.toContain('[[');
      expect(text, `prefixo de ${length} caracteres`).not.toContain('nanachi');
    }
  });

  it('só a nota aparece quando a mensagem completa chega', () => {
    const full = `Passo feito.\n${NEXT_45S}`;
    expect(splitLoopMarkers(full.slice(0, -1)).note).toBeNull();
    expect(splitLoopMarkers(full)).toEqual({ text: 'Passo feito.', note: 'Próxima rodada em 45 s' });
  });
});

describe('splitLoopMarkers in English', () => {
  it('writes the round note in English and still hides the marker', () => {
    setLanguage('en');
    expect(splitLoopMarkers(`Step done. ${NEXT_45S}`)).toEqual({ text: 'Step done.', note: 'Next round in 45 s' });
    expect(splitLoopMarkers(`All done. ${STOP}`)).toEqual({ text: 'All done.', note: 'Loop ended by the agent' });
  });
});
