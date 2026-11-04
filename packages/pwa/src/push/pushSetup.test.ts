import { describe, expect, it } from 'vitest';
import { groupMachinesByKey, sameApplicationKey } from './pushSetup.js';

describe('groupMachinesByKey', () => {
  const SELECTED = 'CHAVE-A';

  it('agrupa: mesma chave da máquina escolhida, chave diferente e sem resposta', () => {
    expect(
      groupMachinesByKey(SELECTED, [
        { machineId: 'm-2', name: 'Sala', publicKey: 'CHAVE-A' },
        { machineId: 'm-3', name: 'Escritório', publicKey: 'CHAVE-B' },
        { machineId: 'm-4', name: 'Casa', publicKey: null },
      ]),
    ).toEqual({
      sameKey: [{ machineId: 'm-2', name: 'Sala', publicKey: 'CHAVE-A' }],
      otherKey: [{ machineId: 'm-3', name: 'Escritório', publicKey: 'CHAVE-B' }],
      unreachable: [{ machineId: 'm-4', name: 'Casa', publicKey: null }],
    });
  });

  it('várias máquinas com a mesma chave ficam todas no mesmo grupo, na ordem recebida', () => {
    const groups = groupMachinesByKey(SELECTED, [
      { machineId: 'm-2', name: 'Sala', publicKey: 'CHAVE-A' },
      { machineId: 'm-5', name: 'Quarto', publicKey: 'CHAVE-A' },
    ]);
    expect(groups.sameKey.map((machine) => machine.machineId)).toEqual(['m-2', 'm-5']);
    expect(groups.otherKey).toEqual([]);
    expect(groups.unreachable).toEqual([]);
  });

  it('sem máquinas, todos os grupos vazios', () => {
    expect(groupMachinesByKey(SELECTED, [])).toEqual({ sameKey: [], otherKey: [], unreachable: [] });
  });

  it('chave só diferente de maiúsculas/minúsculas ou com espaço não é a mesma', () => {
    const groups = groupMachinesByKey(SELECTED, [{ machineId: 'm-6', name: 'X', publicKey: 'chave-a' }]);
    expect(groups.sameKey).toEqual([]);
    expect(groups.otherKey.map((machine) => machine.machineId)).toEqual(['m-6']);
  });
});

describe('sameApplicationKey', () => {
  it('compara os bytes da chave do PushSubscription com a chave da máquina', () => {
    const key = new Uint8Array([1, 2, 3]);
    expect(sameApplicationKey(key.buffer, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameApplicationKey(new Uint8Array([1, 2, 4]).buffer, key)).toBe(false);
  });

  it('sem chave na inscrição (navegador não informa) não é a mesma', () => {
    expect(sameApplicationKey(null, new Uint8Array([1]))).toBe(false);
    expect(sameApplicationKey(undefined, new Uint8Array([1]))).toBe(false);
  });

  it('tamanhos diferentes não são a mesma chave', () => {
    expect(sameApplicationKey(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
