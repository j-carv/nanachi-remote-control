import { LOOP_PROMPT_MAX } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { loopCommandFor } from './loopCommand.js';

describe('loopCommandFor', () => {
  it('/loop sem argumentos abre a folha', () => {
    expect(loopCommandFor('/loop', false)).toEqual({ kind: 'sheet' });
    expect(loopCommandFor('  /loop   ', false)).toEqual({ kind: 'sheet' });
  });

  it('/loop com intervalo e prompt vira um pedido de intervalo, já rodando', () => {
    expect(loopCommandFor('/loop 30s eco teste', false)).toEqual({
      kind: 'start',
      request: { prompt: 'eco teste', mode: 'interval', intervalMs: 30_000, runNow: true },
    });
  });

  it('/loop sem intervalo é o modo automático, com o prompt inteiro', () => {
    expect(loopCommandFor('/loop revise o diff da tarefa', false)).toEqual({
      kind: 'start',
      request: { prompt: 'revise o diff da tarefa', mode: 'dynamic', runNow: true },
    });
  });

  it('um comando dentro do prompt continua prompt', () => {
    expect(loopCommandFor('/loop 1h /review arquivos novos', false)).toEqual({
      kind: 'start',
      request: { prompt: '/review arquivos novos', mode: 'interval', intervalMs: 3_600_000, runNow: true },
    });
  });

  it('intervalo fora de 30 s–24 h ou sem prompt é recusado, sem enviar', () => {
    for (const text of ['/loop 5s revise', '/loop 25h revise', '/loop 5m']) {
      const decision = loopCommandFor(text, false);
      expect(decision.kind).toBe('invalid');
      if (decision.kind === 'invalid') expect(decision.message).toMatch(/30 s e 24 h/);
    }
  });

  it('prompt longo demais é recusado', () => {
    const decision = loopCommandFor(`/loop 5m ${'x'.repeat(LOOP_PROMPT_MAX + 1)}`, false);
    expect(decision.kind).toBe('invalid');
  });

  it('loop não leva anexo: recusa e deixa o rascunho', () => {
    const decision = loopCommandFor('/loop 5m revise', true);
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') expect(decision.message).toMatch(/anexos/);
  });

  it('o que não é /loop segue como mensagem normal', () => {
    expect(loopCommandFor('oi /loop', false)).toEqual({ kind: 'none' });
    expect(loopCommandFor('/loops 5m x', false)).toEqual({ kind: 'none' });
    expect(loopCommandFor('/mcp', false)).toEqual({ kind: 'none' });
    expect(loopCommandFor('', false)).toEqual({ kind: 'none' });
  });
});
