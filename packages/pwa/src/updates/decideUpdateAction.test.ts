import { describe, expect, it } from 'vitest';
import { decideUpdateAction, type UpdateAction, type UpdateInputs } from './decideUpdateAction.js';

// Every row starts from a free, visible app with no waiting update, and overrides only what it tests.
function inputs(overrides: Partial<UpdateInputs>): UpdateInputs {
  return {
    updateWaiting: true,
    visibility: 'visible',
    reloadHeld: false,
    dialogOpen: false,
    returning: false,
    arrivedInBackground: false,
    ...overrides,
  };
}

const table: [string, UpdateInputs, UpdateAction][] = [
  ['nenhuma versão esperada', inputs({ updateWaiting: false }), 'none'],
  [
    'nenhuma versão, mesmo com composer, diálogo e retorno',
    inputs({ updateWaiting: false, reloadHeld: true, dialogOpen: true, returning: true, arrivedInBackground: true }),
    'none',
  ],
  ['visível, livre, sem retorno: mostra a barra', inputs({}), 'show-bar'],
  [
    'visível, livre, retorno, chegou em segundo plano: recarrega',
    inputs({ returning: true, arrivedInBackground: true }),
    'reload-on-visible',
  ],
  [
    'visível, livre, retorno, chegou com o app visível: mostra a barra',
    inputs({ returning: true, arrivedInBackground: false }),
    'show-bar',
  ],
  [
    'visível, composer com texto, retorno, chegou em segundo plano: mostra a barra',
    inputs({ reloadHeld: true, returning: true, arrivedInBackground: true }),
    'show-bar',
  ],
  [
    'visível, diálogo aberto, retorno, chegou em segundo plano: mostra a barra',
    inputs({ dialogOpen: true, returning: true, arrivedInBackground: true }),
    'show-bar',
  ],
  ['visível, composer com texto, sem retorno: mostra a barra', inputs({ reloadHeld: true }), 'show-bar'],
  ['visível, diálogo aberto, sem retorno: mostra a barra', inputs({ dialogOpen: true }), 'show-bar'],
  [
    'visível, composer e diálogo: mostra a barra',
    inputs({ reloadHeld: true, dialogOpen: true }),
    'show-bar',
  ],
  ['oculto, livre, chegou em segundo plano: espera, sem barra', inputs({ visibility: 'hidden', arrivedInBackground: true }), 'wait'],
  ['oculto, livre, chegou com o app visível: espera, sem barra', inputs({ visibility: 'hidden' }), 'wait'],
  [
    'oculto, livre, com retorno marcado: ainda espera',
    inputs({ visibility: 'hidden', returning: true, arrivedInBackground: true }),
    'wait',
  ],
  ['oculto, composer com texto: mostra a barra', inputs({ visibility: 'hidden', reloadHeld: true, arrivedInBackground: true }), 'show-bar'],
  ['oculto, diálogo aberto: mostra a barra', inputs({ visibility: 'hidden', dialogOpen: true, arrivedInBackground: true }), 'show-bar'],
  [
    'oculto, composer e diálogo: mostra a barra',
    inputs({ visibility: 'hidden', reloadHeld: true, dialogOpen: true, arrivedInBackground: true }),
    'show-bar',
  ],
];

describe('decideUpdateAction', () => {
  it.each(table)('%s', (_name, input, expected) => {
    expect(decideUpdateAction(input)).toBe(expected);
  });
});
