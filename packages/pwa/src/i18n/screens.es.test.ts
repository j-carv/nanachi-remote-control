// The base screens and shared components, rendered in Spanish. They are server-rendered to static markup, so effects do
// not run: the data screens show their first state (loading). The whole app is swept for Portuguese by
// `noPortuguese.es.test.ts`; these tests check the actual Spanish wording of a few key screens.
import type { Session } from '@nanachi/shared';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { ActionSheetPanel } from '../components/ActionSheet.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { LanguageSection } from '../components/LanguageSection.js';
import { MachineCard } from '../components/MachineCard.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { ShowAll } from '../components/ShowAll.js';
import type { Machine } from '../machines.js';
import type { MachineOverview } from '../machineOverview.js';
import { DevicesScreen } from '../screens/DevicesScreen.js';
import { machineMenuRows } from '../machineMenuRows.js';
import { MainScreen } from '../screens/MainScreen.js';
import { PairScreen } from '../screens/PairScreen.js';
import { ActivityLine } from '../screens/WorkspacesScreen.js';
import { setLanguage } from './index.js';

const noop = () => undefined;
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

const machine: Machine = { id: 'm1', name: 'OFFICE-PC', baseUrl: 'http://127.0.0.1:7777', token: 'token' };
const NOW = 1_800_000_000_000;

beforeEach(() => {
  setLanguage('es');
});

function session(overrides: Partial<Session> & Pick<Session, 'id' | 'status'>): Session {
  return {
    workspaceId: 'w1',
    agent: 'omp',
    kind: 'acp',
    title: 'Fix the build',
    accountId: null,
    worktree: null,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 5 * 60_000,
    ...overrides,
  };
}

function ready(sessions: Session[]): MachineOverview {
  return { status: 'ready', details: { latencyMs: 12, workspaceCount: 2, sessions, agents: ['Claude'] } };
}

function card(overview: MachineOverview | undefined, connection: ComponentProps<typeof MachineCard>['connection']): string {
  return html(
    createElement(MachineCard, {
      machine,
      overview,
      connection,
      selected: true,
      now: NOW,
      onSelect: noop,
      onOpenSession: noop,
    }),
  );
}

describe('shared components in Spanish', () => {
  it('ScreenHeader names the back button', () => {
    expect(html(createElement(ScreenHeader, { title: 'T', onBack: noop }))).toContain('aria-label="Volver"');
  });

  it('ErrorNotice offers to pair again on an authorization error', () => {
    const markup = html(createElement(ErrorNotice, { error: new ApiError('unauthorized', 401), onRepair: noop }));
    expect(markup).toContain('>Vincular de nuevo</button>');
    expect(markup).toContain('Este teléfono ya no tiene acceso a esta máquina.');
  });

  it('ShowAll counts lines, one or many', () => {
    expect(html(createElement(ShowAll, { hidden: 1, onExpand: noop }))).toContain('Mostrar todo (1 línea)');
    expect(html(createElement(ShowAll, { hidden: 12, onExpand: noop }))).toContain('Mostrar todo (12 líneas)');
    expect(html(createElement(ShowAll, { hidden: 0, onExpand: noop }))).toBe('');
  });

  it('SessionStatusPill shows the status in Spanish, with the terminal variant', () => {
    expect(html(createElement(SessionStatusPill, { status: 'running' }))).toContain('Trabajando');
    expect(html(createElement(SessionStatusPill, { status: 'running', kind: 'pty' }))).toContain('En ejecución');
    expect(html(createElement(SessionStatusPill, { status: 'awaiting_permission' }))).toContain('Esperando permiso');
  });

  it('ActionSheetPanel cancels in Spanish', () => {
    const markup = html(createElement(ActionSheetPanel, { title: '/model', items: [], onClose: noop, onPick: noop }));
    expect(markup).toContain('>Cancelar</button>');
  });
});

describe('MachineCard in Spanish', () => {
  const sessions = [
    session({ id: 'a', status: 'running', title: 'Nova sessão' }),
    session({ id: 'b', status: 'awaiting_permission', title: 'Fix the build' }),
    session({ id: 'c', status: 'idle', title: 'Review the PR' }),
  ];

  it('writes the counts, times and states, translating only the placeholder session title', () => {
    const markup = card(ready(sessions), 'online');
    expect(markup).toContain('En línea · 12 ms');
    expect(markup).toContain('2 workspaces');
    expect(markup).toContain('1 en ejecución');
    expect(markup).toContain('1 esperándote');
    expect(markup).toContain('1 lista');
    expect(markup).toContain('Última actividad hace 5 min');
    expect(markup).toContain('aria-label="Agentes con sesión iniciada"');
    expect(markup).toContain('Esperando permiso');
    expect(markup).toContain('Nueva sesión');
    expect(markup).toContain('Fix the build');
    expect(markup).not.toContain('Nova sessão');
  });

  it('covers the states without data', () => {
    expect(card(undefined, 'connecting')).toContain('Comprobando…');
    expect(card({ status: 'offline' }, 'offline')).toContain('Sin respuesta del PC.');
    expect(card({ status: 'error', latencyMs: 9 }, 'online')).toContain('No se pudieron cargar las sesiones.');
    expect(card(undefined, 'unauthorized')).toContain('Este teléfono ya no tiene acceso a este PC. Vincula de nuevo.');
    expect(card({ status: 'ready', details: { latencyMs: 1, workspaceCount: 0, sessions: [], agents: [] } }, 'online')).toContain(
      'Aún no hay workspaces. Agrega una carpeta en Workspaces.',
    );
  });
});

describe('MainScreen in Spanish', () => {
  const props = {
    machines: [machine],
    selected: machine,
    statuses: { m1: 'online' as const },
    onSelect: noop,
    onAdd: noop,
    onRemove: noop,
    onRepair: noop,
    onOpenWorkspaces: noop,
    onOpenSettings: noop,
    onOpenSession: noop,
  };

  it('names its controls', () => {
    const markup = html(createElement(MainScreen, props));
    for (const text of [
      'aria-label="Configuración"',
      'aria-label="Agregar máquina"',
      'aria-label="Estado de la máquina"',
      'aria-label="Resumen de las máquinas"',
      'aria-label="Máquinas"',
      'aria-label="Forzar actualización de la app"',
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('Conectado al daemon de esta máquina.');
    expect(markup).toContain('Ninguna sesión en ejecución');
    expect(markup).toContain('Workspaces en OFFICE-PC');
    expect(markup).toContain('aria-label="Más acciones de OFFICE-PC"');
    expect(markup).not.toContain('Quitar máquina');
    expect(markup).not.toContain('Remover máquina');
  });

  it('offers "Quitar máquina" in the menu as the destructive row', () => {
    const menu = html(createElement(ActionSheetPanel, { title: 'OFFICE-PC', items: machineMenuRows(noop), onClose: noop, onPick: noop }));
    expect(menu).toContain('>Quitar máquina</span>');
    expect(menu).toContain('data-tone="danger"');
  });

  it('offers to pair again when the machine is not authorized', () => {
    const markup = html(createElement(MainScreen, { ...props, statuses: { m1: 'unauthorized' as const } }));
    expect(markup).toContain('No autorizado');
    expect(markup).toContain('Vincular de nuevo');
  });
});

describe('ActivityLine in Spanish', () => {
  it('counts the sessions running and waiting for the user, running first', () => {
    const markup = html(createElement(ActivityLine, { counts: { running: 2, awaiting: 1, idle: 0 } }));
    expect(markup.indexOf('2 en ejecución')).toBeGreaterThan(-1);
    expect(markup.indexOf('2 en ejecución')).toBeLessThan(markup.indexOf('1 esperándote'));
  });
});

describe('PairScreen in Spanish', () => {
  it('is in Spanish after the switch', () => {
    const props = { initialBaseUrl: 'http://127.0.0.1:7777', canCancel: true, onCancel: noop, onPaired: noop };
    const markup = html(createElement(PairScreen, props));
    expect(markup).toContain('Vincular máquina');
    expect(markup).toContain('Dirección del PC');
    expect(markup).toContain('Nombre de este dispositivo');
    expect(markup).toContain('Genera un código de 6 dígitos en el PC');
    expect(markup).toContain('>Código</label>');
    expect(markup).toContain('Volver');
  });
});

describe('DevicesScreen in Spanish', () => {
  it('shows its title and loading state', () => {
    const markup = html(createElement(DevicesScreen, { machine, nav: { push: noop, back: noop, replace: noop }, onRevokedSelf: noop }));
    expect(markup).toContain('Dispositivos de esta máquina');
    expect(markup).toContain('Cargando…');
    expect(markup).toContain('aria-label="Volver"');
  });
});

describe('LanguageSection in Spanish', () => {
  it('selects Spanish, names the row in it and keeps the bilingual title', () => {
    const markup = html(createElement(LanguageSection));
    expect(markup).toMatch(/<option value="es"[^>]*selected/);
    expect(markup).toContain('>Idioma</span>');
    expect(markup).toContain('Idioma / Language');
  });
});
