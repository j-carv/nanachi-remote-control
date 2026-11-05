// The base screens and shared components, rendered in both languages. They are server-rendered to static markup,
// so effects do not run: the data screens show their first state (loading).
import type { Session } from '@nanachi/shared';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
import { MainScreen } from '../screens/MainScreen.js';
import { PairScreen } from '../screens/PairScreen.js';
import { setLanguage } from './index.js';

const noop = () => undefined;
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

const machine: Machine = { id: 'm1', name: 'OFFICE-PC', baseUrl: 'http://127.0.0.1:7777', token: 'token' };
const NOW = 1_800_000_000_000;

function session(overrides: Partial<Session> & Pick<Session, 'id' | 'status'>): Session {
  return {
    workspaceId: 'w1',
    agent: 'omp',
    kind: 'acp',
    title: 'Corrigir build',
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

describe('shared components in English', () => {
  it('ScreenHeader names the back button', () => {
    const element = createElement(ScreenHeader, { title: 'T', onBack: noop });
    expect(html(element)).toContain('aria-label="Voltar"');
    setLanguage('en');
    expect(html(element)).toContain('aria-label="Back"');
  });

  it('ErrorNotice offers to pair again on an authorization error', () => {
    const element = createElement(ErrorNotice, { error: new ApiError('unauthorized', 401), onRepair: noop });
    expect(html(element)).toContain('>Parear de novo</button>');
    setLanguage('en');
    const markup = html(element);
    expect(markup).toContain('>Pair again</button>');
    expect(markup).toContain('This phone no longer has access to this machine.');
  });

  it('ShowAll counts lines, one or many', () => {
    setLanguage('en');
    expect(html(createElement(ShowAll, { hidden: 1, onExpand: noop }))).toContain('Show all (1 line)');
    expect(html(createElement(ShowAll, { hidden: 12, onExpand: noop }))).toContain('Show all (12 lines)');
    expect(html(createElement(ShowAll, { hidden: 0, onExpand: noop }))).toBe('');
  });

  it('SessionStatusPill shows the status in English, with the terminal variant', () => {
    setLanguage('en');
    expect(html(createElement(SessionStatusPill, { status: 'running' }))).toContain('Working');
    expect(html(createElement(SessionStatusPill, { status: 'running', kind: 'pty' }))).toContain('Running');
    expect(html(createElement(SessionStatusPill, { status: 'awaiting_permission' }))).toContain('Awaiting permission');
  });

  it('ActionSheetPanel cancels in English', () => {
    setLanguage('en');
    const markup = html(createElement(ActionSheetPanel, { title: '/model', items: [], onClose: noop, onPick: noop }));
    expect(markup).toContain('>Cancel</button>');
  });
});

describe('MachineCard', () => {
  const sessions = [
    session({ id: 'a', status: 'running', title: 'Nova sessão' }),
    session({ id: 'b', status: 'awaiting_permission', title: 'Corrigir build' }),
    session({ id: 'c', status: 'idle', title: 'Revisar PR' }),
  ];

  it('writes the counts, times and states in Portuguese', () => {
    const markup = card(ready(sessions), 'online');
    expect(markup).toContain('Online · 12 ms');
    expect(markup).toContain('2 workspaces');
    expect(markup).toContain('1 rodando');
    expect(markup).toContain('1 aguardando você');
    expect(markup).toContain('1 pronta');
    expect(markup).toContain('Última atividade há 5 min');
    expect(markup).toContain('aria-label="Agentes logados"');
    expect(markup).toContain('Aguarda permissão');
  });

  it('writes the same card in English, translating only the placeholder session title', () => {
    setLanguage('en');
    const markup = card(ready(sessions), 'online');
    expect(markup).toContain('Online · 12 ms');
    expect(markup).toContain('2 workspaces');
    expect(markup).toContain('1 running');
    expect(markup).toContain('1 waiting for you');
    expect(markup).toContain('1 ready');
    expect(markup).toContain('Last activity 5 min ago');
    expect(markup).toContain('aria-label="Logged-in agents"');
    expect(markup).toContain('Awaiting permission');
    expect(markup).toContain('New session');
    expect(markup).toContain('Corrigir build');
  });

  it('covers the states without data in English', () => {
    setLanguage('en');
    expect(card(undefined, 'connecting')).toContain('Checking…');
    expect(card({ status: 'offline' }, 'offline')).toContain('No response from the PC.');
    expect(card({ status: 'error', latencyMs: 9 }, 'online')).toContain('Could not load the sessions.');
    expect(card(undefined, 'unauthorized')).toContain('This phone no longer has access to this PC. Pair again.');
    expect(card(ready([]), 'online')).toContain('2 workspaces');
    expect(card({ status: 'ready', details: { latencyMs: 1, workspaceCount: 0, sessions: [], agents: [] } }, 'online')).toContain(
      'No workspaces yet. Add a folder in Workspaces.',
    );
  });
});

describe('MainScreen', () => {
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

  it('names its controls in Portuguese', () => {
    const markup = html(createElement(MainScreen, props));
    for (const text of ['aria-label="Ajustes"', 'aria-label="Adicionar máquina"', 'aria-label="Estado da máquina"']) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('Conectado ao daemon desta máquina.');
    expect(markup).toContain('Nenhuma sessão rodando');
    expect(markup).toContain('Remover máquina');
  });

  it('names its controls in English', () => {
    setLanguage('en');
    const markup = html(createElement(MainScreen, props));
    for (const text of [
      'aria-label="Settings"',
      'aria-label="Add machine"',
      'aria-label="Machine status"',
      'aria-label="Machines summary"',
      'aria-label="Machines"',
      'aria-label="Force app update"',
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('Connected to this machine&#x27;s daemon.');
    expect(markup).toContain('No sessions running');
    expect(markup).toContain('Workspaces');
    expect(markup).toContain('Remove machine');
    expect(markup).not.toContain('Remover máquina');
  });

  it('offers to pair again when the machine is not authorized', () => {
    setLanguage('en');
    const markup = html(createElement(MainScreen, { ...props, statuses: { m1: 'unauthorized' as const } }));
    expect(markup).toContain('Not authorized');
    expect(markup).toContain('Pair again');
  });
});

describe('PairScreen', () => {
  const props = { initialBaseUrl: 'http://127.0.0.1:7777', canCancel: true, onCancel: noop, onPaired: noop };

  it('is in Portuguese by default', () => {
    const markup = html(createElement(PairScreen, props));
    expect(markup).toContain('Parear máquina');
    expect(markup).toContain('Endereço do PC');
    expect(markup).toContain('Nome deste dispositivo');
    expect(markup).toContain('Gere um código de 6 dígitos no PC');
  });

  it('is in English after the switch', () => {
    setLanguage('en');
    const markup = html(createElement(PairScreen, props));
    expect(markup).toContain('Pair machine');
    expect(markup).toContain('PC address');
    expect(markup).toContain('This device&#x27;s name');
    expect(markup).toContain('Generate a 6-digit code on the PC');
    expect(markup).toContain('>Code</label>');
    expect(markup).toContain('Back');
  });
});

describe('DevicesScreen', () => {
  it('shows its title and loading state in English', () => {
    setLanguage('en');
    const markup = html(createElement(DevicesScreen, { machine, nav: { push: noop, back: noop, replace: noop }, onRevokedSelf: noop }));
    expect(markup).toContain('This machine&#x27;s devices');
    expect(markup).toContain('Loading…');
    expect(markup).toContain('aria-label="Back"');
  });
});

describe('LanguageSection', () => {
  it('lists every language, each in its own language, under a title that never changes', () => {
    for (const language of ['pt-BR', 'en', 'es'] as const) {
      setLanguage(language);
      const markup = html(createElement(LanguageSection));
      expect(markup).toContain('Idioma / Language');
      expect(markup).toContain('>Português (Brasil)</option>');
      expect(markup).toContain('>English</option>');
      expect(markup).toContain('>Español</option>');
      expect([...markup.matchAll(/<option /g)]).toHaveLength(3);
    }
  });

  it('selects the current language and names the row in it', () => {
    expect(html(createElement(LanguageSection))).toMatch(/<option value="pt-BR"[^>]*selected/);
    expect(html(createElement(LanguageSection))).toContain('>Idioma</span>');
    setLanguage('en');
    const markup = html(createElement(LanguageSection));
    expect(markup).toMatch(/<option value="en"[^>]*selected/);
    expect(markup).toContain('>Language</span>');
  });
});
