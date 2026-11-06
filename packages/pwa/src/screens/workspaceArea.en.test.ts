// The workspace, sessions, folders, files, editor, changes and terminal areas, rendered in both languages. They are
// server-rendered to static markup, so effects do not run: the screens show their first state (loading) and the
// sheets (drawers) are not mounted. The sheets are covered by e2e/run-i18n.mjs.
import type { Session, Workspace, WorkspaceInfoResponse } from '@nanachi/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api.js';
import { ActionSheetPanel } from '../components/ActionSheet.js';
import { DiffView } from '../components/DiffView.js';
import { UnifiedPatchView } from '../components/UnifiedPatchView.js';
import { WorkspaceInfoBar } from '../components/WorkspaceInfoBar.js';
import { setLanguage } from '../i18n/index.js';
import type { StorageLike } from '../machines.js';
import { notificationsRow } from '../workspace/workspaceMenuRows.js';
import { ChangesScreen } from './ChangesScreen.js';
import { EditorScreen } from './EditorScreen.js';
import { FilesScreen } from './FilesScreen.js';
import { FolderPickerScreen } from './FolderPickerScreen.js';
import { SessionsScreen } from './SessionsScreen.js';
import { TerminalScreen } from './TerminalScreen.js';
import { ActivityLine, WorkspacesScreen } from './WorkspacesScreen.js';

const noop = () => undefined;
const nav = { push: noop, back: noop, replace: noop };
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

// The effects never run in a static render, so the client is never called.
const api = {} as ApiClient;
const storage: StorageLike = { getItem: () => null, setItem: noop, removeItem: noop };

const workspace: Workspace = {
  id: 'w1',
  name: 'nanachi',
  path: 'C:\\Projects\\nanachi',
  muted: false,
  createdAt: 1_800_000_000_000,
};
const session: Session = {
  id: 's1',
  workspaceId: 'w1',
  agent: 'shell',
  kind: 'pty',
  title: 'Terminal · powershell',
  status: 'running',
  accountId: null,
  worktree: null,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
};

describe('WorkspacesScreen', () => {
  const element = createElement(WorkspacesScreen, {
    machineName: 'OFFICE-PC',
    api,
    nav,
    connection: undefined,
    status: undefined,
    onRepair: noop,
  });

  it('is in Portuguese by default', () => {
    const markup = html(element);
    expect(markup).toContain('aria-label="Adicionar workspace"');
    expect(markup).toContain('Carregando…');
  });

  it('is in English after the switch', () => {
    setLanguage('en');
    const markup = html(element);
    expect(markup).toContain('aria-label="Add workspace"');
    expect(markup).toContain('aria-label="Back"');
    expect(markup).toContain('Loading…');
    expect(markup).not.toContain('Adicionar');
  });
});

describe('ActivityLine (the counts under a workspace name)', () => {
  const line = (running: number, awaiting: number): string =>
    html(createElement(ActivityLine, { counts: { running, awaiting, idle: 0 } }));

  it('shows nothing for a workspace with no session running or waiting', () => {
    expect(line(0, 0)).toBe('');
  });

  it('shows only the running count when no session waits', () => {
    const markup = line(2, 0);
    expect(markup).toContain('2 rodando');
    expect(markup).not.toContain('aguardando');
  });

  it('shows only the awaiting count when no session runs', () => {
    const markup = line(0, 1);
    expect(markup).toContain('1 aguardando você');
    expect(markup).not.toContain('rodando');
  });

  it('shows both counts, running first', () => {
    const markup = line(1, 3);
    expect(markup).toContain('1 rodando');
    expect(markup.indexOf('1 rodando')).toBeLessThan(markup.indexOf('3 aguardando você'));
  });

  it('writes the same counts in English', () => {
    setLanguage('en');
    expect(line(1, 3)).toContain('1 running');
    expect(line(1, 3)).toContain('3 waiting for you');
    expect(line(0, 1)).not.toContain('running');
  });
});

describe('SessionsScreen', () => {
  const element = createElement(SessionsScreen, {
    machineName: 'OFFICE-PC',
    workspace,
    api,
    connection: undefined,
    storage,
    nav,
    onRepair: noop,
  });

  it('names its buttons and rows in Portuguese', () => {
    const markup = html(element);
    for (const text of ['Nova sessão', 'Retomar do PC', 'aria-label="Arquivos"', 'aria-label="Mais ações de nanachi"']) {
      expect(markup).toContain(text);
    }
  });

  it('keeps the notifications switch out of the list: it is a row of the "..." menu', () => {
    const markup = html(element);
    expect(markup).not.toContain('workspace-mute');
    expect(markup).not.toContain('Silenciar notificações');
  });

  it('offers the notifications row in the "..." menu, with its state', () => {
    const menu = html(createElement(ActionSheetPanel, { title: 'nanachi', items: [notificationsRow(false, noop)], onClose: noop, onPick: noop }));
    expect(menu).toContain('>Notificações</span>');
    expect(menu).toContain('>Ligadas</span>');
  });

  it('cuts the path in the middle, through the place line, so the folder name stays visible', () => {
    expect(html(element)).toContain('data-slot="session-place"');
  });

  it('names its buttons and rows in English', () => {
    setLanguage('en');
    const markup = html(element);
    for (const text of [
      'New session',
      'Resume from PC',
      'aria-label="Files"',
      'aria-label="Terminal"',
      'aria-label="More actions for nanachi"',
      'Loading…',
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).not.toContain('Nova sessão');
    expect(markup).not.toContain('Silenciar');
    expect(markup).not.toContain('Mute notifications');
  });

  it('offers the notifications row in English, with its state', () => {
    setLanguage('en');
    const menu = html(createElement(ActionSheetPanel, { title: 'nanachi', items: [notificationsRow(true, noop)], onClose: noop, onPick: noop }));
    expect(menu).toContain('>Notifications</span>');
    expect(menu).toContain('>Muted</span>');
  });
});

describe('FolderPickerScreen', () => {
  it('is in Portuguese by default', () => {
    const markup = html(createElement(FolderPickerScreen, { api, nav, onRepair: noop }));
    expect(markup).toContain('Escolher pasta');
    expect(markup).toContain('Digitar caminho');
  });

  it('is in English after the switch', () => {
    setLanguage('en');
    const markup = html(createElement(FolderPickerScreen, { api, nav, onRepair: noop }));
    expect(markup).toContain('Choose folder');
    expect(markup).toContain('Allowed folders on your PC');
    expect(markup).toContain('Type a path');
    expect(markup).toContain('aria-label="Go to the typed path"');
    expect(markup).toContain('Loading…');
  });
});

describe('FilesScreen', () => {
  const root = createElement(FilesScreen, { workspace, path: '', api, nav, onRepair: noop });

  it('names the toolbar and the breadcrumb in Portuguese', () => {
    const markup = html(root);
    for (const text of ['aria-label="Atualizar"', 'aria-label="Novo arquivo"', 'aria-label="Nova pasta"', 'aria-label="Caminho da pasta"']) {
      expect(markup).toContain(text);
    }
  });

  it('names the toolbar and the breadcrumb in English', () => {
    setLanguage('en');
    const markup = html(root);
    for (const text of ['aria-label="Refresh"', 'aria-label="New file"', 'aria-label="New folder"', 'aria-label="Folder path"']) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('>Files</h1>');
  });

  it('titles a subfolder with its own name, in any language', () => {
    setLanguage('en');
    const markup = html(createElement(FilesScreen, { workspace, path: 'src/screens', api, nav, onRepair: noop }));
    expect(markup).toContain('>screens</h1>');
  });
});

describe('EditorScreen', () => {
  it('shows the file name and the loading text in English', () => {
    setLanguage('en');
    const markup = html(createElement(EditorScreen, { workspace, path: 'src/App.tsx', api, nav, onRepair: noop }));
    expect(markup).toContain('>App.tsx</h1>');
    expect(markup).toContain('Loading…');
    expect(markup).toContain('>TSX</span>');
  });

  it('names a plain text file in English', () => {
    setLanguage('en');
    const markup = html(createElement(EditorScreen, { workspace, path: 'notes.txt', api, nav, onRepair: noop }));
    expect(markup).toContain('Plain text');
  });
});

describe('ChangesScreen', () => {
  const element = createElement(ChangesScreen, { machineName: 'OFFICE-PC', workspace, session, api, nav, onRepair: noop });

  it('is in Portuguese by default', () => {
    expect(html(element)).toContain('aria-label="Atualizar alterações"');
  });

  it('is in English after the switch', () => {
    setLanguage('en');
    const markup = html(element);
    expect(markup).toContain('>Changes</h1>');
    expect(markup).toContain('aria-label="Refresh changes"');
  });
});

describe('TerminalScreen', () => {
  const element = createElement(TerminalScreen, {
    machineName: 'OFFICE-PC',
    workspace,
    session,
    api,
    connection: undefined,
    nav,
    onRepair: noop,
  });

  it('names its controls in Portuguese', () => {
    const markup = html(element);
    for (const text of ['aria-label="Alterações"', 'aria-label="Teclas especiais"', 'aria-label="Diminuir fonte do terminal"', 'Copiar seleção', 'Colar']) {
      expect(markup).toContain(text);
    }
  });

  it('names its controls in English, keeping the keycaps', () => {
    setLanguage('en');
    const markup = html(element);
    for (const text of [
      'aria-label="Changes"',
      'aria-label="Special keys"',
      'aria-label="Decrease terminal font size"',
      'aria-label="Increase terminal font size"',
      'aria-label="Paste from the clipboard"',
      'aria-label="Up arrow"',
      'Copy selection',
      'Loading terminal…',
      'placeholder="Text for the terminal"',
      '>Send</button>',
      '>Esc</button>',
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).not.toContain('Colar');
    expect(markup).not.toContain('Enviar');
  });
});

describe('WorkspaceInfoBar', () => {
  const info: WorkspaceInfoResponse = { branch: 'main', changedFiles: 3, instructions: ['AGENTS.md'] };

  it('counts the changes in each language and keeps branch and file names', () => {
    expect(html(createElement(WorkspaceInfoBar, { info }))).toContain('3 alterações');
    setLanguage('en');
    const markup = html(createElement(WorkspaceInfoBar, { info }));
    expect(markup).toContain('aria-label="Workspace status"');
    expect(markup).toContain('3 changes');
    expect(markup).toContain('main');
    expect(markup).toContain('AGENTS.md');
  });

  it('says there are no changes', () => {
    setLanguage('en');
    expect(html(createElement(WorkspaceInfoBar, { info: { ...info, changedFiles: 0 } }))).toContain('no changes');
  });
});

describe('diff views', () => {
  it('mark a new file and an empty patch in Portuguese by default', () => {
    expect(html(createElement(DiffView, { path: 'a.txt', oldText: null, newText: 'x' }))).toContain('(novo)');
    expect(html(createElement(UnifiedPatchView, { patch: '' }))).toContain('Sem diff de texto');
  });

  it('mark them in English after the switch', () => {
    setLanguage('en');
    expect(html(createElement(DiffView, { path: 'a.txt', oldText: null, newText: 'x' }))).toContain('(new)');
    expect(html(createElement(UnifiedPatchView, { patch: '' }))).toContain('No text diff (binary or empty file).');
  });
});
