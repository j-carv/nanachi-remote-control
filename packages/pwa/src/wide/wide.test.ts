// The wide layout, server-rendered to static markup (effects do not run): the frame that adds the list pane only from
// 900 px, the third pane only from 1280 px, and the list pane and the empty screen with data.
import type { Session, SessionStatus, Workspace } from '@nanachi/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { setLanguage } from '../i18n/index.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { AppFrame } from './AppFrame.js';
import { EmptyDetail } from './EmptyDetail.js';
import { BackAffordanceContext } from './layoutContext.js';
import { ListPaneView, type ListPaneViewProps } from './ListPaneView.js';
import { buildTree } from './sessionTree.js';

const noop = () => undefined;
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

const NOW = 1_800_000_000_000;
const workspace: Workspace = { id: 'w1', name: 'nanachi', path: 'C:\\Projects\\nanachi', muted: false, createdAt: NOW };
const docs: Workspace = { ...workspace, id: 'w2', name: 'docs', path: 'C:\\Projects\\docs' };

function session(id: string, status: SessionStatus, minutesAgo: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: 'w1',
    agent: 'claude',
    kind: 'acp',
    title: `Title ${id}`,
    status,
    accountId: null,
    worktree: null,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - minutesAgo * 60_000,
    ...overrides,
  };
}

const frame = (mode: 'phone' | 'two-pane' | 'three-pane', side: string | null = null): string =>
  html(
    createElement(AppFrame, {
      mode,
      listPane: createElement('p', { id: 'the-list' }, 'LIST'),
      side: side === null ? null : createElement('p', { id: 'the-side' }, side),
      sideLabel: 'Side panel',
      detailKey: 'chat:s1',
      children: createElement('p', { id: 'the-screen' }, 'SCREEN'),
    }),
  );

describe('AppFrame', () => {
  it('on the phone is the screen alone: no list pane, no shell, nothing around it', () => {
    const markup = frame('phone', 'SIDE');
    expect(markup).toBe('<p id="the-screen">SCREEN</p>');
    expect(markup).not.toContain('the-list');
    expect(markup).not.toContain('wide-shell');
  });

  it('from 900 px puts the list pane on the left and the screen in the right pane', () => {
    const markup = frame('two-pane');
    expect(markup).toContain('data-slot="wide-shell"');
    expect(markup).toContain('data-layout="two-pane"');
    expect(markup.indexOf('the-list')).toBeGreaterThan(-1);
    expect(markup.indexOf('the-list')).toBeLessThan(markup.indexOf('the-screen'));
    expect(markup).toMatch(/data-slot="detail-pane"[^>]*>(<p id="the-screen">SCREEN<\/p>)/);
  });

  it('has no third pane below 1280 px, even when something asks for one', () => {
    const markup = frame('two-pane', 'SIDE');
    expect(markup).not.toContain('the-side');
    expect(markup).not.toContain('data-slot="side-pane"');
  });

  it('from 1280 px shows the third pane when it has a screen, named for screen readers', () => {
    const markup = frame('three-pane', 'SIDE');
    expect(markup).toContain('data-slot="side-pane"');
    expect(markup).toContain('aria-label="Side panel"');
    expect(markup).toContain('SIDE');
    expect(markup.indexOf('the-screen')).toBeLessThan(markup.indexOf('the-side'));
  });

  it('from 1280 px has no third pane until something opens in it', () => {
    expect(frame('three-pane')).not.toContain('data-slot="side-pane"');
  });
});

describe('the corner button of a screen header', () => {
  const header = (affordance: 'back' | 'close' | 'none') =>
    html(
      createElement(
        BackAffordanceContext.Provider,
        { value: affordance },
        createElement(ScreenHeader, { title: 'Alterações', onBack: noop }),
      ),
    );

  it('is the back chevron on the phone, as it always was', () => {
    const markup = header('back');
    expect(markup).toContain('aria-label="Voltar"');
    expect(markup).toContain('lucide-chevron-left');
  });

  it('is gone for a screen reached from the list pane', () => {
    const markup = header('none');
    expect(markup).not.toContain('aria-label="Voltar"');
    expect(markup).not.toContain('aria-label="Fechar"');
  });

  it('is an X that closes the third pane from its first screen', () => {
    const markup = header('close');
    expect(markup).toContain('aria-label="Fechar"');
    expect(markup).not.toContain('aria-label="Voltar"');
  });
});

describe('ListPaneView', () => {
  const nodes = buildTree(
    [workspace, docs],
    {
      w1: [
        session('awaiting', 'awaiting_permission', 5),
        session('working', 'running', 8),
        ...Array.from({ length: 6 }, (_, index) => session(`idle${index}`, 'idle', 20 + index)),
        session('shell', 'running', 2, { kind: 'pty', agent: 'shell', title: 'Terminal' }),
      ],
    },
    {},
    new Set(),
  );
  const view: ListPaneViewProps = {
    header: createElement('header', null, 'HEADER'),
    nodes,
    error: null,
    selection: { workspaceId: 'w1', sessionId: 'idle5' },
    agentLabels: new Map([['claude', 'Claude Code']]),
    now: NOW,
    onOpenWorkspace: noop,
    onOpenSession: noop,
    onNewSession: noop,
    onAddWorkspace: noop,
    onRepair: noop,
  };
  const render = (overrides: Partial<ListPaneViewProps> = {}): string => html(createElement(ListPaneView, { ...view, ...overrides }));

  it('lists the workspaces in order, with the header on top', () => {
    const markup = render();
    expect(markup.indexOf('HEADER')).toBeLessThan(markup.indexOf('nanachi'));
    expect(markup.indexOf('nanachi')).toBeLessThan(markup.indexOf('docs'));
    expect(markup).toContain('aria-label="Máquinas, workspaces e sessões"');
    expect(markup.match(/data-slot="list-workspace"/g)).toHaveLength(2);
  });

  it('marks the session that is open, and no other', () => {
    const markup = render();
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-slot="list-session"[^>]*aria-current="page"[^>]*title="Title idle5"/);
  });

  it('shows the rows of a long workspace up to the limit, keeps the open session and the waiting one, and offers the rest', () => {
    const markup = render();
    // 9 sessions: the newest 6 (shell, awaiting, working, idle0, idle1, idle2), the open one (idle5) and no more.
    expect(markup.match(/data-slot="list-session"/g)).toHaveLength(7);
    expect(markup).toContain('Title awaiting');
    expect(markup).toContain('Title idle5');
    expect(markup).not.toContain('Title idle4');
    expect(markup).toContain('Mostrar mais 2');
  });

  it('tells a terminal from a conversation and a waiting session from the others', () => {
    const markup = render();
    expect(markup).toMatch(/data-status="running" data-kind="pty"/);
    expect(markup).toMatch(/data-status="awaiting_permission" data-kind="acp"/);
    expect(markup).toContain('Aguarda permissão');
  });

  it('adds up what is working and what waits, with a way to the waiting session', () => {
    const markup = render();
    expect(markup).toContain('2 rodando');
    expect(markup).toContain('1 aguardando você');
  });

  it('says what a workspace without sessions has, and what an empty machine has', () => {
    expect(render()).toContain('Nenhuma sessão');
    expect(render({ nodes: [] })).toContain('Nenhum workspace ainda.');
  });

  it('shows the loading state, and an error with the way to repair it', () => {
    expect(render({ nodes: null })).toContain('Carregando…');
    const failed = render({ nodes: null, error: new ApiError('unauthorized', 401) });
    expect(failed).not.toContain('Carregando…');
    expect(failed).toContain('Parear de novo');
  });

  it('names its buttons, in Portuguese and in English', () => {
    const pt = render();
    expect(pt).toContain('aria-label="Nova sessão em nanachi"');
    expect(pt).toContain('aria-label="Recolher nanachi"');
    expect(pt).toContain('aria-label="Adicionar workspace"');
    setLanguage('en');
    const en = render();
    expect(en).toContain('aria-label="New session in nanachi"');
    expect(en).toContain('aria-label="Collapse nanachi"');
    expect(en).toContain('aria-label="Add workspace"');
    expect(en).toContain('Show 2 more');
    expect(en).toContain('Awaiting permission');
    expect(en).not.toContain('Nova sessão');
    setLanguage('es');
    const es = render();
    expect(es).toContain('aria-label="Nueva sesión en nanachi"');
    expect(es).toContain('Mostrar 2 más');
    expect(es).not.toContain('Nova sessão');
  });
});

describe('EmptyDetail', () => {
  const nodes = buildTree([workspace], { w1: [] }, {}, new Set());
  const render = (overrides: Partial<Parameters<typeof EmptyDetail>[0]> = {}): string =>
    html(createElement(EmptyDetail, { status: 'online', nodes, onOpenWorkspaces: noop, onAddWorkspace: noop, onRepair: noop, ...overrides }));

  it('asks for a session and offers the workspaces', () => {
    const markup = render();
    expect(markup).toContain('data-slot="empty-detail"');
    expect(markup).toContain('Escolha uma sessão');
    expect(markup).toContain('Workspaces');
  });

  it('asks for a first workspace when the machine has none', () => {
    const markup = render({ nodes: [] });
    expect(markup).toContain('Adicione uma pasta do PC como workspace para começar.');
    expect(markup).toContain('Adicionar workspace');
  });

  it('asks to pair again when this device lost access', () => {
    const markup = render({ status: 'unauthorized' });
    expect(markup).toContain('Parear de novo');
    expect(markup).not.toContain('Adicionar workspace');
  });

  it('is in English', () => {
    setLanguage('en');
    const markup = render();
    expect(markup).toContain('Pick a session');
    expect(markup).not.toContain('Escolha');
  });
});
