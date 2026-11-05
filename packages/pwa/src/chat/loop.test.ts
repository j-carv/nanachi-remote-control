import type { Loop } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import {
  durationInputOf,
  durationLabel,
  formatCountdown,
  loopChipView,
  loopRoundsText,
  loopStatusText,
  pickLoop,
} from './loop.js';

const NOW = 1_700_000_000_000;

function loopWith(patch: Partial<Loop>): Loop {
  return {
    sessionId: 's-1',
    prompt: 'revise os testes',
    mode: 'interval',
    intervalMs: 300_000,
    maxIterations: null,
    iterations: 1,
    state: 'active',
    nextRunAt: NOW + 180_000,
    lastRunAt: NOW - 1_000,
    lastError: null,
    createdAt: NOW - 600_000,
    revision: 1,
    ...patch,
  };
}

describe('formatCountdown', () => {
  it('mostra segundos abaixo de um minuto, arredondando para cima', () => {
    expect(formatCountdown(45_000)).toBe('45 s');
    expect(formatCountdown(44_100)).toBe('45 s');
    expect(formatCountdown(1)).toBe('1 s');
  });

  it('mostra minutos arredondando para cima (2m30s vira 3 min)', () => {
    expect(formatCountdown(60_000)).toBe('1 min');
    expect(formatCountdown(150_000)).toBe('3 min');
  });

  it('mostra horas, com minutos só quando sobram', () => {
    expect(formatCountdown(3_600_000)).toBe('1 h');
    expect(formatCountdown(5_400_000)).toBe('1 h 30 min');
  });

  it('nunca mostra texto negativo', () => {
    expect(formatCountdown(-5_000)).toBe('0 s');
  });
});

describe('durationLabel (exact, for presets and the sheet)', () => {
  it('escreve a duração sem arredondar', () => {
    expect(durationLabel(60_000)).toBe('1 min');
    expect(durationLabel(90_000)).toBe('1 min 30 s');
    expect(durationLabel(3_600_000)).toBe('1 h');
    expect(durationLabel(5_400_000)).toBe('1 h 30 min');
    expect(durationLabel(30_000)).toBe('30 s');
  });
});

describe('durationInputOf (text the interval field shows)', () => {
  it('usa o formato que parseLoopDuration aceita', () => {
    expect(durationInputOf(300_000)).toBe('5m');
    expect(durationInputOf(90_000)).toBe('1m30s');
    expect(durationInputOf(5_400_000)).toBe('1h30m');
    expect(durationInputOf(30_000)).toBe('30s');
  });
});

describe('loopChipView', () => {
  it('não mostra chip sem loop ou com loop parado', () => {
    expect(loopChipView(null, NOW)).toBeUndefined();
    expect(loopChipView(loopWith({ state: 'stopped', nextRunAt: null }), NOW)).toBeUndefined();
  });

  it('loop ativo com próxima rodada mostra a contagem', () => {
    const view = loopChipView(loopWith({ nextRunAt: NOW + 180_000 }), NOW);
    expect(view).toEqual({ phase: 'countdown', label: 'Loop · próxima em 3 min', short: 'Loop · 3 min' });
  });

  it('a contagem anda com o relógio', () => {
    const later = loopChipView(loopWith({ nextRunAt: NOW + 180_000 }), NOW + 120_000);
    expect(later?.label).toBe('Loop · próxima em 1 min');
  });

  it('nextRunAt nulo com loop ativo é uma rodada em andamento', () => {
    expect(loopChipView(loopWith({ nextRunAt: null }), NOW)).toEqual({
      phase: 'running',
      label: 'Loop · rodando',
      short: 'Loop · rodando',
    });
  });

  it('próxima rodada já vencida espera o agente: na fila', () => {
    expect(loopChipView(loopWith({ nextRunAt: NOW - 1 }), NOW)?.label).toBe('Loop · na fila');
  });

  it('pausado sem erro mostra pausado; com erro mostra erro', () => {
    expect(loopChipView(loopWith({ state: 'paused', nextRunAt: null }), NOW)?.label).toBe('Loop pausado');
    expect(
      loopChipView(loopWith({ state: 'paused', nextRunAt: null, lastError: 'agente caiu' }), NOW),
    ).toEqual({ phase: 'error', label: 'Loop · erro', short: 'Loop · erro' });
  });
});

describe('loopStatusText and loopRoundsText (sheet)', () => {
  it('descreve o estado por extenso', () => {
    expect(loopStatusText(loopWith({ nextRunAt: NOW + 180_000 }), NOW)).toBe('Próxima rodada em 3 min');
    expect(loopStatusText(loopWith({ nextRunAt: null }), NOW)).toBe('Rodando agora');
    expect(loopStatusText(loopWith({ nextRunAt: NOW - 1 }), NOW)).toBe('Na fila: aguarda o agente ficar livre');
    expect(loopStatusText(loopWith({ state: 'paused', nextRunAt: null }), NOW)).toBe('Pausado');
    expect(loopStatusText(loopWith({ state: 'paused', nextRunAt: null, lastError: 'x' }), NOW)).toBe(
      'Pausado após um erro',
    );
  });

  it('conta as rodadas e o limite', () => {
    expect(loopRoundsText(loopWith({ iterations: 0 }))).toBe('Nenhuma rodada ainda');
    expect(loopRoundsText(loopWith({ iterations: 2 }))).toBe('Rodadas: 2');
    expect(loopRoundsText(loopWith({ iterations: 2, maxIterations: 5 }))).toBe('Rodadas: 2 de 5');
  });
});

describe('pickLoop (ordem entre o WS e as respostas HTTP)', () => {
  it('um snapshot mais novo substitui o atual', () => {
    const current = loopWith({ revision: 4, nextRunAt: null });
    expect(pickLoop(current, loopWith({ revision: 5, nextRunAt: NOW + 60_000 }))?.nextRunAt).toBe(NOW + 60_000);
  });

  it('um snapshot mais antigo não substitui: a resposta HTTP que chega depois do WS não volta o estado', () => {
    // The daemon published revision 5 (next round scheduled) over the socket; the HTTP reply for revision 4
    // (round running) arrives later. The chip must keep the countdown, not "Rodando agora".
    const newer = loopWith({ revision: 5, nextRunAt: NOW + 60_000 });
    const stale = loopWith({ revision: 4, nextRunAt: null });
    expect(pickLoop(newer, stale)).toBe(newer);
  });

  it('revisão igual aceita o snapshot (o subscribe reenvia o estado atual)', () => {
    const current = loopWith({ revision: 3 });
    const same = loopWith({ revision: 3, iterations: 2 });
    expect(pickLoop(current, same)).toBe(same);
  });

  it('sem loop atual, qualquer snapshot entra; null apaga o loop', () => {
    const next = loopWith({ revision: 1 });
    expect(pickLoop(null, next)).toBe(next);
    expect(pickLoop(next, null)).toBeNull();
    expect(pickLoop(null, null)).toBeNull();
  });
});

describe('loop texts in English', () => {
  it('writes the header chip in English, with the same durations', () => {
    setLanguage('en');
    expect(loopChipView(loopWith({ nextRunAt: NOW + 180_000 }), NOW)).toEqual({
      phase: 'countdown',
      label: 'Loop · next in 3 min',
      short: 'Loop · 3 min',
    });
    expect(loopChipView(loopWith({ nextRunAt: null }), NOW)?.label).toBe('Loop · running');
    expect(loopChipView(loopWith({ nextRunAt: NOW - 1 }), NOW)?.label).toBe('Loop · queued');
    expect(loopChipView(loopWith({ state: 'paused' }), NOW)?.label).toBe('Loop paused');
    expect(loopChipView(loopWith({ state: 'paused', lastError: 'falhou' }), NOW)?.label).toBe('Loop · error');
  });

  it('writes the state and the round count of the sheet', () => {
    setLanguage('en');
    expect(loopStatusText(loopWith({ nextRunAt: NOW + 45_000 }), NOW)).toBe('Next round in 45 s');
    expect(loopStatusText(loopWith({ nextRunAt: null }), NOW)).toBe('Running now');
    expect(loopStatusText(loopWith({ nextRunAt: NOW - 1 }), NOW)).toBe('Queued: waiting for the agent to be free');
    expect(loopStatusText(loopWith({ state: 'paused', lastError: 'x' }), NOW)).toBe('Paused after an error');
    expect(loopStatusText(loopWith({ state: 'stopped' }), NOW)).toBe('Ended');
    expect(loopRoundsText(loopWith({ iterations: 0 }))).toBe('No rounds yet');
    expect(loopRoundsText(loopWith({ iterations: 2, maxIterations: 5 }))).toBe('Rounds: 2 of 5');
    expect(loopRoundsText(loopWith({ iterations: 3, maxIterations: null }))).toBe('Rounds: 3');
  });
});
