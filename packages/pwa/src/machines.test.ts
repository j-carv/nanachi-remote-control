import { describe, expect, it } from 'vitest';
import {
  MACHINES_KEY,
  SELECTED_KEY,
  isSafePairingBaseUrl,
  normalizeBaseUrl,
  parseMachines,
  readMachines,
  readSelectedId,
  removeMachine,
  resolveSelected,
  upsertMachine,
  writeMachines,
  writeSelectedId,
  type Machine,
} from './machines.js';

const a: Machine = { id: 'm-a', name: 'PC A', baseUrl: 'https://a.ts.net', token: 'tok-a' };
const b: Machine = { id: 'm-b', name: 'PC B', baseUrl: 'http://127.0.0.1:7777', token: 'tok-b' };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe('upsertMachine', () => {
  it('adiciona máquina nova no fim', () => {
    expect(upsertMachine([a], b)).toEqual([a, b]);
  });

  it('substitui a máquina com o mesmo id, mantendo a posição', () => {
    const renamed: Machine = { ...a, name: 'PC A novo', token: 'tok-novo' };
    expect(upsertMachine([a, b], renamed)).toEqual([renamed, b]);
  });

  it('não muta a lista original', () => {
    const original = [a];
    upsertMachine(original, b);
    expect(original).toEqual([a]);
  });
});

describe('removeMachine', () => {
  it('remove pelo id', () => {
    expect(removeMachine([a, b], 'm-a')).toEqual([b]);
  });

  it('id desconhecido não altera a lista', () => {
    expect(removeMachine([a, b], 'x')).toEqual([a, b]);
  });
});

describe('parseMachines', () => {
  it('lixo que não é JSON vira lista vazia', () => {
    expect(parseMachines('{não é json')).toEqual([]);
  });

  it('null (chave ausente) vira lista vazia', () => {
    expect(parseMachines(null)).toEqual([]);
  });

  it('JSON que não é array vira lista vazia', () => {
    expect(parseMachines(JSON.stringify({ id: 'm-a' }))).toEqual([]);
  });

  it('descarta entradas inválidas e mantém as válidas', () => {
    const raw = JSON.stringify([
      42,
      null,
      { id: 'm-x' },
      { ...a, baseUrl: 'ftp://nope' },
      { ...a, token: '' },
      a,
    ]);
    expect(parseMachines(raw)).toEqual([a]);
  });

  it('remove ids duplicados, mantendo a primeira ocorrência', () => {
    const raw = JSON.stringify([a, { ...a, name: 'duplicada' }]);
    expect(parseMachines(raw)).toEqual([a]);
  });
});

describe('normalizeBaseUrl', () => {
  it('remove barra final e espaços', () => {
    expect(normalizeBaseUrl('  https://pc.ts.net/ ')).toBe('https://pc.ts.net');
  });

  it('mantém porta e caminho sem barra final', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:7777/')).toBe('http://127.0.0.1:7777');
  });

  it('rejeita esquemas que não são http(s)', () => {
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBaseUrl('ftp://pc')).toBeNull();
  });

  it('rejeita texto que não é URL', () => {
    expect(normalizeBaseUrl('nope')).toBeNull();
    expect(normalizeBaseUrl('')).toBeNull();
  });
});

describe('resolveSelected', () => {
  it('retorna a máquina selecionada', () => {
    expect(resolveSelected([a, b], 'm-b')).toEqual(b);
  });

  it('sem seleção ou seleção desconhecida cai na primeira', () => {
    expect(resolveSelected([a, b], null)).toEqual(a);
    expect(resolveSelected([a, b], 'x')).toEqual(a);
  });

  it('lista vazia retorna undefined', () => {
    expect(resolveSelected([], 'm-a')).toBeUndefined();
  });
});

describe('persistência', () => {
  it('escreve e lê a lista na chave nanachi.machines', () => {
    const storage = memoryStorage();
    expect(writeMachines(storage, [a, b])).toBe(true);
    expect(storage.data.get(MACHINES_KEY)).toBe(JSON.stringify([a, b]));
    expect(readMachines(storage)).toEqual([a, b]);
  });

  it('lê lixo do localStorage sem lançar', () => {
    const storage = memoryStorage({ [MACHINES_KEY]: '[{"id":1}, "x"]' });
    expect(readMachines(storage)).toEqual([]);
  });

  it('storage que lança (modo privado/bloqueado) não quebra a leitura nem a escrita', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readMachines(broken)).toEqual([]);
    expect(writeMachines(broken, [a])).toBe(false);
    expect(readSelectedId(broken)).toBeNull();
    expect(() => writeSelectedId(broken, 'm-a')).not.toThrow();
  });

  it('seleção: grava, lê e limpa na chave nanachi.selectedMachine', () => {
    const storage = memoryStorage();
    writeSelectedId(storage, 'm-a');
    expect(storage.data.get(SELECTED_KEY)).toBe('m-a');
    expect(readSelectedId(storage)).toBe('m-a');
    writeSelectedId(storage, null);
    expect(readSelectedId(storage)).toBeNull();
  });
});

describe('isSafePairingBaseUrl', () => {
  const APP = 'https://nanachi.pc-sala.ts.net';

  it.each([
    'https://pc-sala.tail1234.ts.net',
    'https://pc-sala.tail1234.ts.net:7777',
    'http://localhost:7777',
    'http://127.0.0.1:7777',
  ])('aceita %s', (baseUrl) => {
    expect(isSafePairingBaseUrl(baseUrl, APP)).toBe(true);
  });

  it.each(['http://pc-sala.tail1234.ts.net', 'http://192.168.0.10:7777', 'http://10.0.0.5:7777', 'http://pc.local'])(
    'recusa http fora de loopback: %s',
    (baseUrl) => {
      expect(isSafePairingBaseUrl(baseUrl, APP)).toBe(false);
    },
  );

  it('aceita http quando é a própria origem da app (servida pelo daemon)', () => {
    expect(isSafePairingBaseUrl('http://192.168.0.10:7777', 'http://192.168.0.10:7777')).toBe(true);
  });

  it('recusa protocolo que não é http(s)', () => {
    expect(isSafePairingBaseUrl('ftp://pc-sala.ts.net', APP)).toBe(false);
  });
});
