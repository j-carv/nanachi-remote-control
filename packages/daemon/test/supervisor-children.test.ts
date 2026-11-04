import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELOAD_EXIT_CODE } from '../src/reload-watch.js';
import { ManagedChild, type ChildHandle, type ChildSpec, type SpawnChild } from '../src/supervisor-children.js';
import type { KillResult } from '../src/process-tree.js';

/** Filho falso: o teste dispara saída e saída de texto quando quiser. */
interface FakeChild {
  handle: ChildHandle;
  emitOutput(stream: 'stdout' | 'stderr', chunk: string): void;
  exit(code: number | null, detail?: string): void;
}

function fakeSpawn(): { spawn: SpawnChild; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn: SpawnChild = () => {
    let outputListener: ((stream: 'stdout' | 'stderr', chunk: string) => void) | undefined;
    let exitListener: ((code: number | null, detail?: string) => void) | undefined;
    const handle: ChildHandle = {
      pid: 1000 + children.length,
      onOutput: (listener) => {
        outputListener = listener;
      },
      onExit: (listener) => {
        exitListener = listener;
      },
    };
    children.push({
      handle,
      emitOutput: (stream, chunk) => outputListener?.(stream, chunk),
      exit: (code, detail) => exitListener?.(code, detail),
    });
    return handle;
  };
  return { spawn, children };
}

const SPEC: ChildSpec = { name: 'daemon', command: 'node', args: ['dist/main.js'], cwd: 'C:\\x', env: {} };

let logLines: string[];
let killed: number[];

function makeChild(spawn: SpawnChild): ManagedChild {
  return new ManagedChild(SPEC, {
    spawn,
    log: { write: (source, text) => logLines.push(`[${source}] ${text}`) },
    killTree: (pid): KillResult => {
      killed.push(pid);
      return { ok: true, message: '' };
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  logLines = [];
  killed = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ManagedChild', () => {
  it('sobe o filho e manda a saída dele para o log com a origem, linha a linha', () => {
    const { spawn, children } = fakeSpawn();
    const child = makeChild(spawn);

    child.start();
    children[0]?.emitOutput('stdout', 'uma linha\npar');
    children[0]?.emitOutput('stderr', 'erro\n');
    children[0]?.emitOutput('stdout', 'tial\n');

    expect(logLines).toEqual([
      '[daemon] iniciado (pid 1000)',
      '[daemon] uma linha',
      '[daemon] erro',
      '[daemon] partial',
    ]);
  });

  it('código 75 reinicia na hora', () => {
    const { spawn, children } = fakeSpawn();
    makeChild(spawn).start();

    children[0]?.exit(RELOAD_EXIT_CODE);

    expect(children).toHaveLength(2);
    expect(logLines).toContain('[daemon] reiniciando já (reload)');
  });

  it('outra saída reinicia com backoff: 1s, depois 2s', () => {
    const { spawn, children } = fakeSpawn();
    makeChild(spawn).start();

    children[0]?.exit(1);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);

    children[1]?.exit(1);
    vi.advanceTimersByTime(1999);
    expect(children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(3);
  });

  it('erro de spawn (ex.: executável inexistente) conta como saída e entra no backoff', () => {
    const { spawn, children } = fakeSpawn();
    makeChild(spawn).start();

    children[0]?.exit(null, 'ENOENT');
    expect(logLines.some((line) => line.includes('ENOENT'))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(2);
  });

  it('stop cancela restart pendente e não reinicia mais', () => {
    const { spawn, children } = fakeSpawn();
    const child = makeChild(spawn);
    child.start();
    children[0]?.exit(1);

    child.stop();
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });

  it('stop com filho vivo mata a árvore pelo pid e a saída depois não reinicia', () => {
    const { spawn, children } = fakeSpawn();
    const child = makeChild(spawn);
    child.start();

    child.stop();
    expect(killed).toEqual([1000]);

    children[0]?.exit(1);
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });
});
