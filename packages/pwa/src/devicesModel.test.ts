import { describe, expect, it } from 'vitest';
import type { DevicesResponse } from '@nanachi/shared';
import { canRevoke, sortDevices } from './devicesModel.js';

type Device = DevicesResponse['devices'][number];

function device(id: string, overrides: Partial<Device> = {}): Device {
  return { id, name: id, createdAt: 1_000, lastSeenAt: null, current: false, expired: false, ...overrides };
}

describe('sortDevices', () => {
  it('mostra os ativos antes dos expirados', () => {
    const list = sortDevices([device('old', { expired: true, lastSeenAt: 9_000 }), device('active', { lastSeenAt: 1_000 })]);

    expect(list.map((item) => item.id)).toEqual(['active', 'old']);
  });

  it('dentro de cada grupo, o uso mais recente vem primeiro; sem uso conta a criação', () => {
    const list = sortDevices([
      device('a', { lastSeenAt: 1_000 }),
      device('b', { lastSeenAt: 5_000 }),
      device('c', { lastSeenAt: null, createdAt: 3_000 }),
    ]);

    expect(list.map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('o aparelho atual, que acabou de usar a API, fica no topo do grupo ativo', () => {
    const list = sortDevices([device('other', { lastSeenAt: 5_000 }), device('me', { current: true, lastSeenAt: 9_000 })]);

    expect(list[0]?.id).toBe('me');
  });

  it('não altera a lista recebida', () => {
    const input = [device('a', { lastSeenAt: 1_000 }), device('b', { lastSeenAt: 2_000 })];
    sortDevices(input);

    expect(input.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('canRevoke', () => {
  it('só outro device ativo pode ser revogado daqui', () => {
    expect(canRevoke(device('other', { lastSeenAt: 1 }))).toBe(true);
  });

  it('o próprio aparelho não é revogado aqui (o esquecer da máquina cobre isso)', () => {
    expect(canRevoke(device('me', { current: true, lastSeenAt: 1 }))).toBe(false);
  });

  it('um device expirado já não tem acesso, então não tem o botão revogar', () => {
    expect(canRevoke(device('old', { expired: true, lastSeenAt: 1 }))).toBe(false);
  });
});
