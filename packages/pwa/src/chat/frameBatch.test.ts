import { describe, expect, it } from 'vitest';
import { createFrameBatcher } from './frameBatch.js';

function setup() {
  const frames = new Map<number, () => void>();
  const cancelled: number[] = [];
  const flushed: number[][] = [];
  let next = 1;
  const batcher = createFrameBatcher<number>({
    schedule(callback) {
      const handle = next;
      next += 1;
      frames.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      cancelled.push(handle);
      frames.delete(handle);
    },
    flush(batch) {
      flushed.push([...batch]);
    },
  });
  const runFrame = () => {
    const first = [...frames.entries()][0];
    if (first === undefined) throw new Error('sem quadro agendado');
    const [handle, callback] = first;
    frames.delete(handle);
    callback();
  };
  return { batcher, frames, cancelled, flushed, runFrame };
}

describe('createFrameBatcher', () => {
  it('junta os itens empurrados no mesmo quadro em um único flush', () => {
    const { batcher, frames, flushed, runFrame } = setup();

    batcher.push(1);
    batcher.push(2);
    batcher.push(3);
    expect(frames.size).toBe(1);
    runFrame();

    expect(flushed).toEqual([[1, 2, 3]]);
  });

  it('agenda um novo quadro quando chega item depois do flush', () => {
    const { batcher, frames, flushed, runFrame } = setup();

    batcher.push(1);
    runFrame();
    batcher.push(2);

    expect(frames.size).toBe(1);
    runFrame();
    expect(flushed).toEqual([[1], [2]]);
  });

  it('flushNow entrega o pendente na hora e cancela o quadro agendado', () => {
    const { batcher, cancelled, flushed, frames } = setup();

    batcher.push(7);
    batcher.flushNow();

    expect(flushed).toEqual([[7]]);
    expect(cancelled).toHaveLength(1);
    expect(frames.size).toBe(0);
  });

  it('flushNow sem pendente não chama flush', () => {
    const { batcher, flushed } = setup();

    batcher.flushNow();

    expect(flushed).toEqual([]);
  });

  it('dispose cancela o quadro e descarta o pendente sem entregar', () => {
    const { batcher, cancelled, flushed, frames } = setup();

    batcher.push(9);
    batcher.dispose();

    expect(cancelled).toHaveLength(1);
    expect(frames.size).toBe(0);
    expect(flushed).toEqual([]);
  });
});
