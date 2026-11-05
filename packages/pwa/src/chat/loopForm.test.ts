import type { Loop } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import {
  LOOP_PRESETS_MS,
  firstRoundHelpText,
  formValuesOf,
  loopRequestFrom,
  loopSummaryText,
  nativeLoopCommand,
  parseIntervalText,
  type LoopFormValues,
} from './loopForm.js';

const FORM: LoopFormValues = {
  prompt: 'revise os testes',
  mode: 'interval',
  interval: '5m',
  rounds: '',
  runNow: true,
};

describe('parseIntervalText', () => {
  it('aceita os formatos do parseLoopDuration', () => {
    expect(parseIntervalText('90s')).toEqual({ ok: true, intervalMs: 90_000 });
    expect(parseIntervalText(' 1h30m ')).toEqual({ ok: true, intervalMs: 5_400_000 });
    expect(parseIntervalText('30S')).toEqual({ ok: true, intervalMs: 30_000 });
  });

  it('recusa texto que não é duração, com o formato na mensagem', () => {
    const result = parseIntervalText('daqui a pouco');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('90s');
  });

  it('recusa campo vazio e faixa fora de 30 s–24 h', () => {
    expect(parseIntervalText('')).toMatchObject({ ok: false });
    expect(parseIntervalText('29s')).toEqual({ ok: false, message: 'O intervalo vai de 30 s a 24 h.' });
    expect(parseIntervalText('25h')).toEqual({ ok: false, message: 'O intervalo vai de 30 s a 24 h.' });
    expect(parseIntervalText('0s')).toEqual({ ok: false, message: 'O intervalo vai de 30 s a 24 h.' });
  });

  it('os presets (1m, 5m, 15m, 30m, 1h) estão todos na faixa', () => {
    expect(LOOP_PRESETS_MS).toEqual([60_000, 300_000, 900_000, 1_800_000, 3_600_000]);
  });
});

describe('loopRequestFrom', () => {
  it('monta o pedido de intervalo com runNow', () => {
    expect(loopRequestFrom(FORM)).toEqual({
      ok: true,
      request: { prompt: 'revise os testes', mode: 'interval', intervalMs: 300_000, runNow: true },
    });
  });

  it('modo automático não manda intervalo, e o limite entra quando preenchido', () => {
    expect(loopRequestFrom({ ...FORM, mode: 'dynamic', rounds: '3', runNow: false })).toEqual({
      ok: true,
      request: { prompt: 'revise os testes', mode: 'dynamic', maxIterations: 3, runNow: false },
    });
  });

  it('prompt vazio é recusado; espaços não contam', () => {
    expect(loopRequestFrom({ ...FORM, prompt: '   ' })).toEqual({
      ok: false,
      message: 'Escreva o prompt que o loop vai repetir.',
    });
  });

  it('limite de rodadas precisa ser inteiro a partir de 1', () => {
    for (const rounds of ['0', '-2', '2.5', 'dez']) {
      const result = loopRequestFrom({ ...FORM, rounds });
      expect(result.ok).toBe(false);
    }
    expect(loopRequestFrom({ ...FORM, rounds: '  ' })).toMatchObject({ ok: true });
  });

  it('intervalo inválido no modo fixo bloqueia o envio', () => {
    expect(loopRequestFrom({ ...FORM, interval: '5s' })).toMatchObject({ ok: false });
  });
});

describe('nativeLoopCommand (Claude /loop nativo)', () => {
  it('monta /loop com o intervalo e o prompt, ou só o prompt no modo automático', () => {
    expect(nativeLoopCommand(FORM)).toBe('/loop 5m revise os testes');
    expect(nativeLoopCommand({ ...FORM, mode: 'dynamic' })).toBe('/loop revise os testes');
  });

  it('sem prompt ou com intervalo inválido não há comando', () => {
    expect(nativeLoopCommand({ ...FORM, prompt: ' ' })).toBeUndefined();
    expect(nativeLoopCommand({ ...FORM, interval: '1s' })).toBeUndefined();
  });
});

describe('formValuesOf', () => {
  const LOOP: Loop = {
    sessionId: 's-1',
    prompt: 'eco',
    mode: 'interval',
    intervalMs: 90_000,
    maxIterations: 4,
    iterations: 2,
    state: 'active',
    nextRunAt: null,
    lastRunAt: null,
    lastError: null,
    createdAt: 1,
    revision: 1,
  };

  it('sem loop: intervalo fixo de 5 min, rodar agora ligado', () => {
    expect(formValuesOf(null)).toEqual({ prompt: '', mode: 'interval', interval: '5m', rounds: '', runNow: true });
  });

  it('com loop: preenche com o que está rodando, sem rodar de novo ao salvar', () => {
    expect(formValuesOf(LOOP)).toEqual({ prompt: 'eco', mode: 'interval', interval: '1m30s', rounds: '4', runNow: false });
    expect(formValuesOf({ ...LOOP, mode: 'dynamic', intervalMs: null, maxIterations: null }).mode).toBe('dynamic');
  });
});

describe('loopSummaryText (o que o loop vai fazer)', () => {
  it('intervalo, agora, sem limite', () => {
    expect(loopSummaryText({ ...FORM, interval: '5m' })).toBe(
      'Vai mandar “revise os testes” agora e depois a cada 5 min, sem limite de rodadas.',
    );
  });

  it('intervalo, agora, com limite', () => {
    expect(loopSummaryText({ ...FORM, interval: '15m', rounds: '10' })).toBe(
      'Vai mandar “revise os testes” agora e depois a cada 15 min, até 10 rodadas.',
    );
    expect(loopSummaryText({ ...FORM, interval: '15m', rounds: '1' })).toBe(
      'Vai mandar “revise os testes” agora e depois a cada 15 min, até 1 rodada.',
    );
  });

  it('intervalo sem rodar agora: a primeira rodada espera o intervalo', () => {
    expect(loopSummaryText({ ...FORM, interval: '15m', runNow: false })).toBe(
      'Vai mandar “revise os testes” pela primeira vez em 15 min e depois a cada 15 min, sem limite de rodadas.',
    );
  });

  it('automático, agora, sem limite', () => {
    expect(loopSummaryText({ ...FORM, mode: 'dynamic', runNow: true })).toBe(
      'Vai mandar “revise os testes” agora; depois o agente decide quando repetir, até ele dizer que terminou.',
    );
  });

  it('automático com limite e sem rodar agora usa o padrão de 10 min', () => {
    expect(loopSummaryText({ ...FORM, mode: 'dynamic', rounds: '3', runNow: false })).toBe(
      'Vai mandar “revise os testes” em 10 min; depois o agente decide quando repetir, até ele dizer que terminou ou chegar a 3 rodadas.',
    );
  });

  it('o prompt entra em uma linha e corta em 60 caracteres', () => {
    expect(loopSummaryText({ ...FORM, prompt: '  linha 1\n   linha 2  ', interval: '1h' })).toBe(
      'Vai mandar “linha 1 linha 2” agora e depois a cada 1 h, sem limite de rodadas.',
    );
    const long = 'a'.repeat(100);
    expect(loopSummaryText({ ...FORM, prompt: long, interval: '1h' })).toBe(
      `Vai mandar “${'a'.repeat(59)}…” agora e depois a cada 1 h, sem limite de rodadas.`,
    );
  });

  it('sem texto de resumo enquanto algum campo estiver inválido', () => {
    expect(loopSummaryText({ ...FORM, prompt: ' ' })).toBeUndefined();
    expect(loopSummaryText({ ...FORM, interval: '5s' })).toBeUndefined();
    expect(loopSummaryText({ ...FORM, rounds: 'dez' })).toBeUndefined();
  });
});

describe('firstRoundHelpText', () => {
  it('no intervalo, a primeira rodada espera o intervalo', () => {
    expect(firstRoundHelpText('interval')).toBe('Se desligado, a primeira rodada espera o intervalo.');
  });

  it('no automático, começa em 10 min', () => {
    expect(firstRoundHelpText('dynamic')).toBe('Se desligado, começa em 10 min.');
  });
});

describe('loop form in English', () => {
  it('words the validation messages', () => {
    setLanguage('en');
    expect(parseIntervalText('')).toEqual({ ok: false, message: 'Enter an interval, like 5m or 1h30m.' });
    expect(parseIntervalText('soon')).toEqual({ ok: false, message: 'Use a format like 90s, 10m or 1h30m.' });
    expect(parseIntervalText('10s')).toEqual({ ok: false, message: 'The interval must be between 30 s and 24 h.' });
    expect(loopRequestFrom({ ...FORM, prompt: '  ' })).toEqual({
      ok: false,
      message: 'Write the prompt the loop will repeat.',
    });
    expect(loopRequestFrom({ ...FORM, rounds: '0' })).toEqual({
      ok: false,
      message: 'Round limit: use a whole number, 1 or more.',
    });
  });

  it('writes the live summary of each mode', () => {
    setLanguage('en');
    expect(loopSummaryText(FORM)).toBe('Will send “revise os testes” now, then every 5 min, with no round limit.');
    expect(loopSummaryText({ ...FORM, runNow: false, rounds: '10' })).toBe(
      'Will send “revise os testes” in 5 min, then every 5 min, up to 10 rounds.',
    );
    expect(loopSummaryText({ ...FORM, mode: 'dynamic' })).toBe(
      'Will send “revise os testes” now; then the agent decides when to repeat, until it says it\'s done.',
    );
    expect(loopSummaryText({ ...FORM, mode: 'dynamic', rounds: '1' })).toBe(
      'Will send “revise os testes” now; then the agent decides when to repeat, until it says it\'s done or reaches 1 round.',
    );
  });

  it('explains when the first round runs', () => {
    setLanguage('en');
    expect(firstRoundHelpText('interval')).toBe('If off, the first round waits for the interval.');
    expect(firstRoundHelpText('dynamic')).toBe('If off, it starts in 10 min.');
  });
});
