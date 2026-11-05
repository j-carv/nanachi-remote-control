import type { SessionEvent } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { createTerminalState, ingestTerminal } from './output.js';

type Body = DistributiveOmit<SessionEvent, 'seq' | 'sessionId' | 'ts'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function ev(seq: number, body: Body): SessionEvent {
  return { seq, sessionId: 's-1', ts: 1_700_000_000_000 + seq, ...body } as SessionEvent;
}

const out = (seq: number, data: string) => ev(seq, { kind: 'terminal_output', data });

describe('createTerminalState', () => {
  it('começa sem saída aplicada e sem processo encerrado', () => {
    expect(createTerminalState()).toEqual({ lastSeq: 0, exit: null });
  });
});

describe('ingestTerminal', () => {
  it('devolve os pedaços de saída na ordem de seq', () => {
    const result = ingestTerminal(createTerminalState(), [out(1, 'a'), out(2, '\x1b[31mb\x1b[0m'), out(3, 'c')]);
    expect(result.writes).toEqual(['a', '\x1b[31mb\x1b[0m', 'c']);
    expect(result.state.lastSeq).toBe(3);
  });

  it('ordena por seq mesmo que o lote chegue fora de ordem', () => {
    const result = ingestTerminal(createTerminalState(), [out(3, 'c'), out(1, 'a'), out(2, 'b')]);
    expect(result.writes).toEqual(['a', 'b', 'c']);
  });

  it('evento já aplicado (mesmo seq) não é escrito de novo', () => {
    const first = ingestTerminal(createTerminalState(), [out(1, 'a'), out(2, 'b')]);
    const again = ingestTerminal(first.state, [out(1, 'a'), out(2, 'b')]);
    expect(again.writes).toEqual([]);
    expect(again.state).toBe(first.state);
  });

  it('evento mais antigo que o último aplicado é ignorado', () => {
    const first = ingestTerminal(createTerminalState(), [out(5, 'novo')]);
    const late = ingestTerminal(first.state, [out(3, 'velho')]);
    expect(late.writes).toEqual([]);
    expect(late.state.lastSeq).toBe(5);
  });

  it('replay parcial (histórico até 4, depois ao vivo a partir de 3) não duplica o 3 e o 4', () => {
    const history = ingestTerminal(createTerminalState(), [out(1, 'a'), out(2, 'b'), out(3, 'c'), out(4, 'd')]);
    const live = ingestTerminal(history.state, [out(3, 'c'), out(4, 'd'), out(5, 'e')]);
    expect(live.writes).toEqual(['e']);
  });

  it('aceita saltos de seq (seq é global do daemon)', () => {
    const result = ingestTerminal(createTerminalState(), [out(2, 'a'), out(9, 'b')]);
    expect(result.writes).toEqual(['a', 'b']);
    expect(result.state.lastSeq).toBe(9);
  });

  it('terminal_exit registra o código de saída e não escreve nada no terminal', () => {
    const result = ingestTerminal(createTerminalState(), [out(1, 'fim'), ev(2, { kind: 'terminal_exit', exitCode: 3 })]);
    expect(result.writes).toEqual(['fim']);
    expect(result.state.exit).toEqual({ exitCode: 3, reason: null });
  });

  it('terminal_exit sem código (null) é guardado como null', () => {
    const result = ingestTerminal(createTerminalState(), [ev(1, { kind: 'terminal_exit', exitCode: null })]);
    expect(result.state.exit).toEqual({ exitCode: null, reason: null });
  });

  it('exit repetido não troca o objeto de estado', () => {
    const first = ingestTerminal(createTerminalState(), [ev(1, { kind: 'terminal_exit', exitCode: 0 })]);
    const again = ingestTerminal(first.state, [ev(1, { kind: 'terminal_exit', exitCode: 0 })]);
    expect(again.state).toBe(first.state);
  });

  it('eventos de outros tipos avançam o lastSeq mas não geram escrita', () => {
    const result = ingestTerminal(createTerminalState(), [ev(1, { kind: 'status', status: 'running' })]);
    expect(result.writes).toEqual([]);
    expect(result.state.lastSeq).toBe(1);
    expect(result.state.exit).toBeNull();
  });

  it('lote vazio devolve o mesmo estado', () => {
    const state = createTerminalState();
    expect(ingestTerminal(state, []).state).toBe(state);
  });
});

describe('terminal_exit.reason', () => {
  it('reason reload (o daemon recarregou) fica guardado no exit', () => {
    const result = ingestTerminal(createTerminalState(), [ev(1, { kind: 'terminal_exit', exitCode: null, reason: 'reload' })]);
    expect(result.state.exit).toEqual({ exitCode: null, reason: 'reload' });
  });

  it('saída normal (sem reason) fica com reason null', () => {
    const result = ingestTerminal(createTerminalState(), [ev(1, { kind: 'terminal_exit', exitCode: 0 })]);
    expect(result.state.exit).toEqual({ exitCode: 0, reason: null });
  });
});
