import { describe, expect, it } from 'vitest';
import {
  LOOP_INTERVAL_MAX_MS,
  LOOP_INTERVAL_MIN_MS,
  LoopRequestSchema,
  LoopResponseSchema,
  LoopSchema,
  parseLoopArgs,
  parseLoopDuration,
  SessionEventSchema,
  ServerMessageSchema,
} from '../src/index.js';

const loop = {
  sessionId: 's-1',
  prompt: 'verifica o deploy',
  mode: 'interval',
  intervalMs: 300_000,
  maxIterations: null,
  iterations: 2,
  state: 'active',
  nextRunAt: 1_700_000_300_000,
  lastRunAt: 1_700_000_000_000,
  lastError: null,
  createdAt: 1_699_999_000_000,
  revision: 7,
};

describe('parseLoopDuration', () => {
  it.each([
    ['30s', 30_000],
    ['10m', 600_000],
    ['2h', 7_200_000],
    ['1h30m', 5_400_000],
    ['1h30m15s', 5_415_000],
    ['5M', 300_000],
  ])('lê %s como %d ms', (text, ms) => {
    expect(parseLoopDuration(text)).toBe(ms);
  });

  it.each(['', 'abc', '10', 'm10', '1d', '1 h', '-5m', '1.5h'])('recusa %j', (text) => {
    expect(parseLoopDuration(text)).toBeUndefined();
  });
});

describe('parseLoopArgs', () => {
  it('separa o intervalo do prompt', () => {
    expect(parseLoopArgs('5m /foo bar')).toEqual({ intervalMs: 300_000, prompt: '/foo bar' });
  });

  it('aceita 30s, 2h e 1h30m', () => {
    expect(parseLoopArgs('30s checa')).toEqual({ intervalMs: 30_000, prompt: 'checa' });
    expect(parseLoopArgs('2h /babysit-prs')).toEqual({ intervalMs: 7_200_000, prompt: '/babysit-prs' });
    expect(parseLoopArgs('1h30m checa a fila')).toEqual({ intervalMs: 5_400_000, prompt: 'checa a fila' });
  });

  it('sem intervalo é dinâmico: intervalMs undefined e o texto inteiro é o prompt', () => {
    expect(parseLoopArgs('/foo bar')).toEqual({ intervalMs: undefined, prompt: '/foo bar' });
    expect(parseLoopArgs('  verifica tudo  ')).toEqual({ intervalMs: undefined, prompt: 'verifica tudo' });
  });

  it('um token que não é duração faz parte do prompt', () => {
    expect(parseLoopArgs('1d /foo')).toEqual({ intervalMs: undefined, prompt: '1d /foo' });
  });

  it('recusa intervalo fora de 30 s a 24 h', () => {
    expect(parseLoopArgs('5s /foo')).toBeUndefined();
    expect(parseLoopArgs('25h /foo')).toBeUndefined();
    expect(parseLoopArgs('0s /foo')).toBeUndefined();
    expect(parseLoopArgs(`${LOOP_INTERVAL_MAX_MS / 3_600_000}h /foo`)).toEqual({
      intervalMs: LOOP_INTERVAL_MAX_MS,
      prompt: '/foo',
    });
  });

  it('recusa entrada vazia e intervalo sem prompt', () => {
    expect(parseLoopArgs('')).toBeUndefined();
    expect(parseLoopArgs('   ')).toBeUndefined();
    expect(parseLoopArgs('5m')).toBeUndefined();
    expect(parseLoopArgs('5m   ')).toBeUndefined();
  });

  it('o mínimo é 30 s', () => {
    expect(LOOP_INTERVAL_MIN_MS).toBe(30_000);
    expect(parseLoopArgs(`${LOOP_INTERVAL_MIN_MS / 1000}s x`)).toEqual({ intervalMs: 30_000, prompt: 'x' });
  });
});

describe('LoopSchema', () => {
  it('aceita um loop completo', () => {
    expect(LoopSchema.parse(loop)).toEqual(loop);
  });

  it('exige os campos nulos presentes (sem chaves opcionais)', () => {
    const { maxIterations: _omitted, ...withoutMax } = loop;
    expect(LoopSchema.safeParse(withoutMax).success).toBe(false);
  });

  it('recusa estado e modo desconhecidos', () => {
    expect(LoopSchema.safeParse({ ...loop, state: 'running' }).success).toBe(false);
    expect(LoopSchema.safeParse({ ...loop, mode: 'cron' }).success).toBe(false);
  });

  it('limita o intervalo entre 30 s e 24 h', () => {
    expect(LoopSchema.safeParse({ ...loop, intervalMs: 29_999 }).success).toBe(false);
    expect(LoopSchema.safeParse({ ...loop, intervalMs: LOOP_INTERVAL_MAX_MS + 1 }).success).toBe(false);
  });

  it('exige revision inteiro não negativo (ordem dos snapshots no PWA)', () => {
    expect(LoopSchema.safeParse({ ...loop, revision: undefined }).success).toBe(false);
    expect(LoopSchema.safeParse({ ...loop, revision: -1 }).success).toBe(false);
    expect(LoopSchema.parse({ ...loop, revision: 0 }).revision).toBe(0);
  });

  it('dinâmico guarda intervalMs null', () => {
    expect(LoopSchema.parse({ ...loop, mode: 'dynamic', intervalMs: null }).intervalMs).toBeNull();
  });
});

describe('LoopRequestSchema', () => {
  it('interval exige intervalMs; runNow é opcional', () => {
    expect(LoopRequestSchema.parse({ prompt: 'x', mode: 'interval', intervalMs: 60_000 })).toEqual({
      prompt: 'x',
      mode: 'interval',
      intervalMs: 60_000,
    });
    expect(LoopRequestSchema.safeParse({ prompt: 'x', mode: 'interval' }).success).toBe(false);
  });

  it('interval fora da faixa é recusado', () => {
    expect(LoopRequestSchema.safeParse({ prompt: 'x', mode: 'interval', intervalMs: 1_000 }).success).toBe(false);
    expect(
      LoopRequestSchema.safeParse({ prompt: 'x', mode: 'interval', intervalMs: LOOP_INTERVAL_MAX_MS + 1 }).success,
    ).toBe(false);
  });

  it('dynamic não aceita intervalMs', () => {
    expect(LoopRequestSchema.parse({ prompt: 'x', mode: 'dynamic' })).toEqual({ prompt: 'x', mode: 'dynamic' });
    expect(LoopRequestSchema.safeParse({ prompt: 'x', mode: 'dynamic', intervalMs: 60_000 }).success).toBe(false);
  });

  it('prompt vazio, maxIterations zero ou runNow não booleano são recusados', () => {
    expect(LoopRequestSchema.safeParse({ prompt: '', mode: 'dynamic' }).success).toBe(false);
    expect(LoopRequestSchema.safeParse({ prompt: 'x', mode: 'dynamic', maxIterations: 0 }).success).toBe(false);
    expect(LoopRequestSchema.safeParse({ prompt: 'x', mode: 'dynamic', runNow: 'sim' }).success).toBe(false);
    expect(LoopRequestSchema.parse({ prompt: 'x', mode: 'dynamic', maxIterations: 3, runNow: false })).toEqual({
      prompt: 'x',
      mode: 'dynamic',
      maxIterations: 3,
      runNow: false,
    });
  });
});

describe('LoopResponseSchema', () => {
  it('aceita loop ou null', () => {
    expect(LoopResponseSchema.parse({ loop })).toEqual({ loop });
    expect(LoopResponseSchema.parse({ loop: null })).toEqual({ loop: null });
  });
});

describe('user_message com loop', () => {
  const base = { seq: 4, sessionId: 's-1', ts: 1_700_000_000_000, kind: 'user_message', text: 'verifica' };

  it('aceita loop: true e loopIteration', () => {
    const parsed = SessionEventSchema.parse({ ...base, loop: true, loopIteration: 3 });
    expect(parsed).toMatchObject({ loop: true, loopIteration: 3 });
  });

  it('evento sem os campos de loop continua igual', () => {
    expect(SessionEventSchema.parse(base)).toEqual(base);
  });

  it('loopIteration precisa ser inteiro positivo', () => {
    expect(SessionEventSchema.safeParse({ ...base, loop: true, loopIteration: 0 }).success).toBe(false);
  });
});

describe('ServerMessage loop', () => {
  it('aceita loop com a sessão e com null', () => {
    expect(ServerMessageSchema.parse({ type: 'loop', sessionId: 's-1', loop })).toEqual({
      type: 'loop',
      sessionId: 's-1',
      loop,
    });
    expect(ServerMessageSchema.parse({ type: 'loop', sessionId: 's-1', loop: null })).toEqual({
      type: 'loop',
      sessionId: 's-1',
      loop: null,
    });
  });

  it('recusa loop sem a chave loop', () => {
    expect(ServerMessageSchema.safeParse({ type: 'loop', sessionId: 's-1' }).success).toBe(false);
  });
});
