import type { ResetEntry, ResetRedeemResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { ApiError } from '../api.js';
import {
  canRedeem,
  redeemConfirmText,
  redeemFailureOf,
  redeemResultOf,
  resetCountsText,
  resetExpiryText,
  resetOutcomeTone,
  supportsResets,
} from './resetsModel.js';

const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function entry(overrides: Partial<ResetEntry> = {}): ResetEntry {
  return {
    target: 'anthropic/1',
    accountLabel: 'fake@example.com',
    providerLabel: 'Anthropic',
    available: 2,
    usable: 1,
    expiresAt: null,
    note: null,
    active: true,
    ...overrides,
  };
}

describe('supportsResets', () => {
  it('só omp e codex têm resets', () => {
    expect(supportsResets('omp')).toBe(true);
    expect(supportsResets('codex')).toBe(true);
  });

  it('claude, agy, shell e ids desconhecidos não pedem a lista', () => {
    for (const id of ['claude', 'agy', 'shell', 'OMP', 'omp2', '']) {
      expect(supportsResets(id)).toBe(false);
    }
  });
});

describe('resetCountsText', () => {
  it('diz quantos estão salvos e quantos dá para usar agora', () => {
    expect(resetCountsText(entry({ available: 2, usable: 1 }))).toBe('2 salvos · 1 disponível agora');
  });

  it('concorda com o plural', () => {
    expect(resetCountsText(entry({ available: 1, usable: 1 }))).toBe('1 salvo · 1 disponível agora');
    expect(resetCountsText(entry({ available: 3, usable: 3 }))).toBe('3 salvos · 3 disponíveis agora');
    expect(resetCountsText(entry({ available: 1, usable: 0 }))).toBe('1 salvo · 0 disponíveis agora');
    expect(resetCountsText(entry({ available: 0, usable: 0 }))).toBe('0 salvos · 0 disponíveis agora');
  });
});

describe('resetExpiryText', () => {
  it('sem data não há texto', () => {
    expect(resetExpiryText(null, NOW)).toBeNull();
  });

  it('texto do omp passa como veio, depois de "expira"', () => {
    expect(resetExpiryText('in 3 days', NOW)).toBe('expira in 3 days');
    expect(resetExpiryText('2026-11-10 12:00', NOW)).toBe('expira 2026-11-10 12:00');
  });

  it('ISO do codex vira tempo relativo quando é próximo', () => {
    expect(resetExpiryText(new Date(NOW + 30 * 1000).toISOString(), NOW)).toBe('expira em 1 min');
    expect(resetExpiryText(new Date(NOW + 45 * MINUTE_MS).toISOString(), NOW)).toBe('expira em 45 min');
    expect(resetExpiryText(new Date(NOW + 5 * HOUR_MS + 30 * MINUTE_MS).toISOString(), NOW)).toBe('expira em 5 h');
    expect(resetExpiryText(new Date(NOW + 30 * HOUR_MS).toISOString(), NOW)).toBe('expira em 1 dia');
    expect(resetExpiryText(new Date(NOW + 3 * DAY_MS + HOUR_MS).toISOString(), NOW)).toBe('expira em 3 dias');
  });

  it('minutos arredondam para baixo: 59,5 min nunca vira "60 min"', () => {
    expect(resetExpiryText(new Date(NOW + 59.5 * MINUTE_MS).toISOString(), NOW)).toBe('expira em 59 min');
    expect(resetExpiryText(new Date(NOW + HOUR_MS - 1).toISOString(), NOW)).toBe('expira em 59 min');
    expect(resetExpiryText(new Date(NOW + HOUR_MS).toISOString(), NOW)).toBe('expira em 1 h');
    expect(resetExpiryText(new Date(NOW + 90 * 1000).toISOString(), NOW)).toBe('expira em 1 min');
    expect(resetExpiryText(new Date(NOW + 1).toISOString(), NOW)).toBe('expira em 1 min');
  });

  it('ISO a uma semana ou mais vira a data local', () => {
    const when = new Date(2026, 10, 20, 9, 0);
    expect(resetExpiryText(when.toISOString(), NOW)).toBe('expira em 20/11/2026');
  });

  it('ISO que já passou diz que expirou', () => {
    expect(resetExpiryText(new Date(NOW - MINUTE_MS).toISOString(), NOW)).toBe('expirou');
  });
});

describe('canRedeem', () => {
  it('só habilita com ao menos um reset usável agora', () => {
    expect(canRedeem(entry({ usable: 1 }), false)).toBe(true);
    expect(canRedeem(entry({ usable: 3 }), false)).toBe(true);
    expect(canRedeem(entry({ usable: 0, available: 2 }), false)).toBe(false);
  });

  it('com um resgate em andamento todos os botões ficam desabilitados', () => {
    expect(canRedeem(entry({ usable: 1 }), true)).toBe(false);
  });
});

describe('redeemConfirmText', () => {
  it('título e corpo do contrato, com conta e provedor', () => {
    expect(redeemConfirmText(entry())).toEqual({
      title: 'Usar 1 reset?',
      body: 'fake@example.com · Anthropic. Gasta um reset salvo e libera o limite agora. Não dá para desfazer.',
    });
  });

  it('sem provedor, só a conta', () => {
    expect(redeemConfirmText(entry({ providerLabel: null })).body).toBe(
      'fake@example.com. Gasta um reset salvo e libera o limite agora. Não dá para desfazer.',
    );
  });
});

describe('resetOutcomeTone', () => {
  it('só "reset" tem estilo de sucesso; os outros são neutros', () => {
    expect(resetOutcomeTone('reset')).toBe('success');
    for (const outcome of ['nothing_to_reset', 'no_credit', 'already_redeemed', 'failed'] as const) {
      expect(resetOutcomeTone(outcome)).toBe('neutral');
    }
  });
});

describe('redeemResultOf', () => {
  it('mostra a mensagem do agente com o tom do resultado', () => {
    const response: ResetRedeemResponse = { outcome: 'reset', message: '  Reset applied for fake@example.com.  ' };
    expect(redeemResultOf(response)).toEqual({ tone: 'success', message: 'Reset applied for fake@example.com.' });
    expect(redeemResultOf({ outcome: 'already_redeemed', message: 'that reset was already redeemed.' })).toEqual({
      tone: 'neutral',
      message: 'that reset was already redeemed.',
    });
  });

  it('mensagem vazia cai num texto fixo por resultado', () => {
    expect(redeemResultOf({ outcome: 'reset', message: '' }).message).toBe('Reset aplicado.');
    expect(redeemResultOf({ outcome: 'nothing_to_reset', message: ' ' }).message).toBe(
      'Não há nada para liberar agora; nenhum reset foi gasto.',
    );
    expect(redeemResultOf({ outcome: 'no_credit', message: '' }).message).toBe('Não há resets salvos para gastar.');
    expect(redeemResultOf({ outcome: 'already_redeemed', message: '' }).message).toBe('Esse reset já foi usado.');
    expect(redeemResultOf({ outcome: 'failed', message: '' }).message).toBe('O agente não confirmou o reset.');
  });
});

describe('redeemFailureOf', () => {
  it('erro da API vira aviso de erro com o texto do resgate', () => {
    expect(redeemFailureOf(new ApiError('unexpected', 409, null, 'reset_in_progress'))).toEqual({
      tone: 'error',
      message: 'Já tem um reset em andamento.',
    });
  });

  it('504 diz que não deu para confirmar', () => {
    expect(redeemFailureOf(new ApiError('agent_timeout', 504, null, 'agent_timeout'))).toEqual({
      tone: 'error',
      message: 'Não deu para confirmar se o reset foi usado. Confira o uso antes de tentar de novo.',
    });
  });
});

describe('in English', () => {
  it('resetCountsText says saved and available now, in the right number', () => {
    setLanguage('en');
    expect(resetCountsText(entry({ available: 2, usable: 1 }))).toBe('2 saved · 1 available now');
    expect(resetCountsText(entry({ available: 1, usable: 0 }))).toBe('1 saved · 0 available now');
    expect(resetCountsText(entry({ available: 0, usable: 0 }))).toBe('0 saved · 0 available now');
  });

  it('resetExpiryText keeps the text omp prints and words the ISO dates of codex', () => {
    setLanguage('en');
    expect(resetExpiryText('in 3 days', NOW)).toBe('expires in 3 days');
    expect(resetExpiryText(new Date(NOW + 45 * MINUTE_MS).toISOString(), NOW)).toBe('expires in 45 min');
    expect(resetExpiryText(new Date(NOW + 5 * HOUR_MS + 30 * MINUTE_MS).toISOString(), NOW)).toBe('expires in 5 h');
    expect(resetExpiryText(new Date(NOW + 30 * HOUR_MS).toISOString(), NOW)).toBe('expires in 1 day');
    expect(resetExpiryText(new Date(NOW + 3 * DAY_MS + HOUR_MS).toISOString(), NOW)).toBe('expires in 3 days');
    expect(resetExpiryText(new Date(NOW - MINUTE_MS).toISOString(), NOW)).toBe('expired');
  });

  it('resetExpiryText writes a far date in the language of the app', () => {
    setLanguage('en');
    expect(resetExpiryText(new Date(2026, 10, 20, 9, 0).toISOString(), NOW)).toBe('expires on Nov 20, 2026');
  });

  it('redeemConfirmText', () => {
    setLanguage('en');
    expect(redeemConfirmText(entry())).toEqual({
      title: 'Use 1 reset?',
      body: "fake@example.com · Anthropic. Spends one saved reset and lifts the limit now. This can't be undone.",
    });
    expect(redeemConfirmText(entry({ providerLabel: null })).body).toMatch(/^fake@example\.com\. Spends one/);
  });

  it('redeemResultOf shows the agent line as it is, and a fixed text only when it is empty', () => {
    setLanguage('en');
    expect(redeemResultOf({ outcome: 'reset', message: 'Reset applied for fake@example.com.' }).message).toBe(
      'Reset applied for fake@example.com.',
    );
    expect(redeemResultOf({ outcome: 'reset', message: '' }).message).toBe('Reset applied.');
    expect(redeemResultOf({ outcome: 'nothing_to_reset', message: ' ' }).message).toBe(
      'Nothing to reset right now; no reset was spent.',
    );
    expect(redeemResultOf({ outcome: 'no_credit', message: '' }).message).toBe('There are no saved resets to spend.');
    expect(redeemResultOf({ outcome: 'already_redeemed', message: '' }).message).toBe('That reset was already used.');
    expect(redeemResultOf({ outcome: 'failed', message: '' }).message).toBe('The agent did not confirm the reset.');
  });

  it('redeemFailureOf uses the English error text', () => {
    setLanguage('en');
    expect(redeemFailureOf(new ApiError('unexpected', 409, null, 'reset_in_progress'))).toEqual({
      tone: 'error',
      message: 'A reset is already in progress.',
    });
  });
});
