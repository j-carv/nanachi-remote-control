// A sweep for Portuguese left in the English interface. Every screen, panel and card that can be server-rendered is
// rendered in `en` with fake data written in English, so any Portuguese word in the markup comes from the app, not from
// the data. The text nodes and the attributes a person reads (aria-label, title, placeholder, alt) are checked against
// a list of Portuguese UI words, and any letter with a Portuguese diacritic is flagged.
//
// Sheets (drawers) mount in a portal that a static render skips, so their text is checked in the translation files
// instead (the last block) and in the browser by e2e/run-i18n.mjs. Effects do not run in a static render: the data
// screens show their first state (loading).
import type {
  AgentAccount,
  AgentProfile,
  AvailableCommand,
  Loop,
  ResetEntry,
  Session,
  SessionConfigOption,
  SessionStatus,
  Workspace,
  WorkspaceInfoResponse,
} from '@nanachi/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginStep } from '../accountLogin.js';
import { ApiError, type ApiClient, type ApiErrorKind } from '../api.js';
import { AccountLoginBody } from '../components/AccountLoginSheet.js';
import { AccountSelect } from '../components/AccountSelect.js';
import { ActionSheetPanel } from '../components/ActionSheet.js';
import { AgentAccountGroup } from '../components/AgentAccountsSection.js';
import { ConfigControls } from '../components/ConfigControls.js';
import { DiffView } from '../components/DiffView.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { FileAttachment } from '../components/FileAttachment.js';
import { ImageCropper } from '../components/ImageCropper.js';
import { ImageThumb } from '../components/ImageThumb.js';
import { LanguageSection } from '../components/LanguageSection.js';
import { MachineCard } from '../components/MachineCard.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { ShowAll } from '../components/ShowAll.js';
import { UnifiedPatchView } from '../components/UnifiedPatchView.js';
import { UsageAccountLine, UsageContent } from '../components/UsageDrawer.js';
import { WorkspaceInfoBar } from '../components/WorkspaceInfoBar.js';
import { AttachmentDrafts } from '../chat/AttachmentDrafts.js';
import { BackgroundPanel } from '../chat/BackgroundDrawer.js';
import { backgroundStateText } from '../chat/BackgroundStatus.js';
import type { BackgroundEntry } from '../chat/background.js';
import { ChatItemView } from '../chat/ChatItemView.js';
import { LoopChip } from '../chat/LoopChip.js';
import type { ChatNode } from '../chat/nesting.js';
import { PermissionCard } from '../chat/PermissionCard.js';
import { PlanCard } from '../chat/PlanCard.js';
import type { ChatItem, PendingPermission } from '../chat/reducer.js';
import { SlashMenu } from '../chat/SlashMenu.js';
import { DesktopPanelView, type DesktopPanelViewProps } from '../desktop/DesktopSection.js';
import { PairingCodeBody } from '../desktop/PairingCodeSheet.js';
import type { DaemonStatus } from '../desktop/schema.js';
import { describeError } from '../errorMessages.js';
import type { StorageLike } from '../machines.js';
import type { Machine } from '../machines.js';
import type { MachineOverview } from '../machineOverview.js';
import { ChangesScreen } from '../screens/ChangesScreen.js';
import { ChatScreen } from '../screens/ChatScreen.js';
import { DevicesScreen } from '../screens/DevicesScreen.js';
import { EditorScreen } from '../screens/EditorScreen.js';
import { FilesScreen } from '../screens/FilesScreen.js';
import { FolderPickerScreen } from '../screens/FolderPickerScreen.js';
import { MainScreen } from '../screens/MainScreen.js';
import { PairScreen } from '../screens/PairScreen.js';
import { SessionsScreen } from '../screens/SessionsScreen.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';
import { TerminalScreen } from '../screens/TerminalScreen.js';
import { WorkspacesScreen } from '../screens/WorkspacesScreen.js';
import { parseUsage } from '../usage/parseUsage.js';
import { RedeemResultNotice, ResetConfirmActions, ResetsSection } from '../usage/ResetsSection.js';
import type { ResetsListState } from '../usage/resetsFlow.js';
import { NAMESPACES, setLanguage } from './index.js';
import ptChat from './locales/pt-BR/chat.json';
import enAccounts from './locales/en/accounts.json';
import enChat from './locales/en/chat.json';
import enCommon from './locales/en/common.json';
import enDesktop from './locales/en/desktop.json';
import enDevices from './locales/en/devices.json';
import enErrors from './locales/en/errors.json';
import enFiles from './locales/en/files.json';
import enMachines from './locales/en/machines.json';
import enPairing from './locales/en/pairing.json';
import enSettings from './locales/en/settings.json';
import enTerminal from './locales/en/terminal.json';
import enUsage from './locales/en/usage.json';
import enWorkspace from './locales/en/workspace.json';

// --- the detector -------------------------------------------------------------------------------------------------

/** Portuguese UI words that are not English words. Short words that exist in English too (no, for, a, e...) stay out. */
const PORTUGUESE_WORDS = new Set(
  (
    'sessão sessões sessao remover remova cancelar configurar configuração configurações enviar envie novo nova novos ' +
    'novas abrir abra abrindo fechar feche conta contas uso ajustes ajuste carregando nenhum nenhuma voltar salvar ' +
    'salvo salvos salva salvando arquivo arquivos pasta pastas erro tentar tente atualizar atualização atualizando ' +
    'alterações alteração copiar copiado colar editar excluir apagar buscar procurar aguardando aguarde conectado ' +
    'conectando desconectado dispositivo dispositivos máquina máquinas parear pareamento código endereço rodando ' +
    'pronta pronto parado parada retomar retomando silenciar usar limite restante restantes hoje ontem agora ' +
    'mensagem mensagens permitir negar recusar aprovar trabalhando pensando falhou falha sucesso tela projeto ' +
    'histórico importando importar listando nome nomear renomear caractere caracteres segundos minutos horas dias ' +
    'semana não você seu sua seus suas uma para pelo pela foi está são ainda também quando onde porque mas deste ' +
    'desta neste nesta este esta executar execução alterado ações ação ver mostrar ocultar fixar sair entrar ' +
    'usuário senha celular aparelho consultando indisponível disponível desligado ligado ativo ativa inativo'
  ).split(' '),
);

/** Texts that are Portuguese on purpose: each language shows its own name, and the row title is bilingual. */
const KEPT_PORTUGUESE = ['Português (Brasil)', 'Idioma / Language'];

const DIACRITIC = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };

/** What a person reads in a markup string: its text nodes and the attributes screen readers and tooltips use. */
function visibleText(markup: string): string {
  const attributes = [...markup.matchAll(/\s(?:aria-label|title|placeholder|alt|aria-description)="([^"]*)"/g)].map((match) => match[1] ?? '');
  const text = markup.replace(/<[^>]*>/g, '\n');
  const joined = [text, ...attributes].join('\n');
  return joined.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** The Portuguese words in a text, in order of appearance (empty when it is all English). */
function portugueseIn(raw: string): string[] {
  let text = raw;
  for (const kept of KEPT_PORTUGUESE) text = text.split(kept).join(' ');
  const found: string[] = [];
  for (const word of text.match(/\p{L}+/gu) ?? []) {
    if (PORTUGUESE_WORDS.has(word.toLowerCase()) || DIACRITIC.test(word)) found.push(word);
  }
  return found;
}

/** Fails with the offending words, and the markup they came from, when a rendered piece still has Portuguese. */
function expectEnglish(name: string, markup: string): void {
  expect(markup.length, `${name} rendered nothing`).toBeGreaterThan(0);
  expect(portugueseIn(visibleText(markup)), `Portuguese left in ${name}`).toEqual([]);
}

const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

describe('the detector', () => {
  it('finds Portuguese words and diacritics, in text and in the attributes a person reads', () => {
    expect(portugueseIn(visibleText('<button aria-label="Fechar">Salvar alterações</button>'))).toEqual(['Salvar', 'alterações', 'Fechar']);
    expect(portugueseIn(visibleText('<input placeholder="Nome do arquivo"/>'))).toEqual(['Nome', 'arquivo']);
    expect(portugueseIn('Não é possível')).toEqual(['Não', 'é', 'possível']);
  });

  it('leaves English, markup noise and the two kept names alone', () => {
    expect(portugueseIn(visibleText('<div class="flex uso" data-x="Sessão">Loading sessions…</div>'))).toEqual([]);
    expect(portugueseIn('Português (Brasil) Idioma / Language English')).toEqual([]);
    expect(portugueseIn(visibleText('<span>can&#x27;t</span>'))).toEqual([]);
  });
});

describe('the sweep is not vacuous', () => {
  it('trips on the same screens and texts in Portuguese', () => {
    setLanguage('pt-BR');
    const pair = { initialBaseUrl: 'http://127.0.0.1:7777', canCancel: true, onCancel: noop, onPaired: noop };
    expect(portugueseIn(visibleText(html(createElement(PairScreen, pair)))).length).toBeGreaterThan(3);
    expect(portugueseIn(visibleText(html(createElement(FilesScreen, { workspace, path: '', api, nav, onRepair: noop })))).length).toBeGreaterThan(3);
    expect(portugueseIn(describeError(new ApiError('unauthorized', 401))).length).toBeGreaterThan(0);
    expect(entries(ptChat).filter(([, text]) => portugueseIn(text).length > 0).length).toBeGreaterThan(50);
  });
});

// --- fake data, all in English ------------------------------------------------------------------------------------

const noop = () => undefined;
const nav = { push: noop, back: noop, replace: noop };
// The effects never run in a static render, so the client is never called.
const api = {} as ApiClient;
const storage: StorageLike = { getItem: () => null, setItem: noop, removeItem: noop };
const NOW = 1_800_000_000_000;

const machine: Machine = { id: 'm1', name: 'OFFICE-PC', baseUrl: 'http://127.0.0.1:7777', token: 'token' };
const workspace: Workspace = { id: 'w1', name: 'demo', path: 'C:\\Projects\\demo', muted: false, createdAt: NOW };

function session(status: SessionStatus, overrides: Partial<Session> = {}): Session {
  return {
    id: `s-${status}`,
    workspaceId: 'w1',
    agent: 'omp',
    kind: 'acp',
    title: 'Fix the build',
    status,
    accountId: null,
    worktree: null,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 5 * 60_000,
    ...overrides,
  };
}

const STATUSES: readonly SessionStatus[] = ['starting', 'idle', 'running', 'awaiting_permission', 'stopped', 'error'];

beforeEach(() => {
  setLanguage('en');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- the app screens ------------------------------------------------------------------------------------------------

describe('app screens in English', () => {
  it('home, pairing and devices', () => {
    const main = {
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
    expectEnglish('MainScreen', html(createElement(MainScreen, main)));
    expectEnglish('MainScreen (unauthorized)', html(createElement(MainScreen, { ...main, statuses: { m1: 'unauthorized' as const } })));
    expectEnglish('MainScreen (offline)', html(createElement(MainScreen, { ...main, statuses: { m1: 'offline' as const } })));

    const pair = { initialBaseUrl: 'http://127.0.0.1:7777', canCancel: true, onCancel: noop, onPaired: noop };
    expectEnglish('PairScreen', html(createElement(PairScreen, pair)));
    expectEnglish('PairScreen (first run)', html(createElement(PairScreen, { ...pair, canCancel: false })));
    expectEnglish('DevicesScreen', html(createElement(DevicesScreen, { machine, nav, onRevokedSelf: noop })));
  });

  it('settings, with the language row and the notifications block', () => {
    const settings = () => html(createElement(SettingsScreen, { machines: [machine], selected: machine, nav }));
    // The notifications block reads the browser: no push support, then support with each permission.
    vi.stubGlobal('window', {});
    expectEnglish('SettingsScreen (no push)', settings());
    vi.stubGlobal('navigator', { serviceWorker: {} });
    vi.stubGlobal('window', { PushManager: {}, Notification: {} });
    for (const permission of ['default', 'granted', 'denied']) {
      vi.stubGlobal('Notification', { permission });
      expectEnglish(`SettingsScreen (${permission})`, settings());
    }
    expectEnglish('LanguageSection', html(createElement(LanguageSection)));
  });

  it('the chat screen, in every session status', () => {
    for (const status of STATUSES) {
      const element = createElement(ChatScreen, {
        machineName: 'OFFICE-PC',
        workspace,
        session: session(status),
        api,
        connection: undefined,
        storage,
        nav,
        onRepair: noop,
      });
      expectEnglish(`ChatScreen ${status}`, html(element));
    }
  });

  it('workspace list, sessions, folder picker, files, editor, changes and terminal', () => {
    expectEnglish('WorkspacesScreen', html(createElement(WorkspacesScreen, { machineName: 'OFFICE-PC', api, nav, onRepair: noop })));
    expectEnglish(
      'SessionsScreen',
      html(
        createElement(SessionsScreen, { machineName: 'OFFICE-PC', workspace, api, connection: undefined, storage, nav, onRepair: noop }),
      ),
    );
    expectEnglish('FolderPickerScreen', html(createElement(FolderPickerScreen, { api, nav, onRepair: noop })));
    for (const path of ['', 'src/screens']) {
      expectEnglish(`FilesScreen ${path}`, html(createElement(FilesScreen, { workspace, path, api, nav, onRepair: noop })));
    }
    for (const path of ['src/App.tsx', 'notes.txt', 'data.json', 'README.md']) {
      expectEnglish(`EditorScreen ${path}`, html(createElement(EditorScreen, { workspace, path, api, nav, onRepair: noop })));
    }
    const shell = session('running', { agent: 'shell', kind: 'pty', title: 'Terminal · powershell' });
    expectEnglish('ChangesScreen', html(createElement(ChangesScreen, { machineName: 'OFFICE-PC', workspace, session: shell, api, nav, onRepair: noop })));
    expectEnglish(
      'TerminalScreen',
      html(createElement(TerminalScreen, { machineName: 'OFFICE-PC', workspace, session: shell, api, connection: undefined, nav, onRepair: noop })),
    );
  });
});

// --- shared components ----------------------------------------------------------------------------------------------

describe('shared components in English', () => {
  it('header, status pills, show-all and the action sheet panel', () => {
    expectEnglish('ScreenHeader', html(createElement(ScreenHeader, { title: 'Title', onBack: noop })));
    for (const status of STATUSES) {
      expectEnglish(`SessionStatusPill ${status}`, html(createElement(SessionStatusPill, { status })));
      expectEnglish(`SessionStatusPill ${status} (terminal)`, html(createElement(SessionStatusPill, { status, kind: 'pty' })));
    }
    expectEnglish('ShowAll', html(createElement(ShowAll, { hidden: 12, onExpand: noop })));
    expectEnglish(
      'ActionSheetPanel',
      html(createElement(ActionSheetPanel, { title: 'Actions', items: [{ label: 'Rename', onSelect: noop }], onClose: noop, onPick: noop })),
    );
  });

  it('the machine card in every state', () => {
    const sessions = STATUSES.map((status) => session(status, { title: status === 'running' ? 'Nova sessão' : 'Fix the build' }));
    const ready: MachineOverview = { status: 'ready', details: { latencyMs: 12, workspaceCount: 2, sessions, agents: ['Claude'] } };
    const empty: MachineOverview = { status: 'ready', details: { latencyMs: 12, workspaceCount: 0, sessions: [], agents: [] } };
    const states: [string, MachineOverview | undefined, 'online' | 'offline' | 'connecting' | 'unauthorized'][] = [
      ['ready', ready, 'online'],
      ['empty', empty, 'online'],
      ['checking', undefined, 'connecting'],
      ['offline', { status: 'offline' }, 'offline'],
      ['error', { status: 'error', latencyMs: 9 }, 'online'],
      ['unauthorized', undefined, 'unauthorized'],
    ];
    for (const [name, overview, connection] of states) {
      const element = createElement(MachineCard, {
        machine,
        overview,
        connection,
        selected: true,
        now: NOW,
        onSelect: noop,
        onOpenSession: noop,
      });
      expectEnglish(`MachineCard ${name}`, html(element));
    }
  });

  it('every error the API can raise reads in English', () => {
    const kinds = Object.keys(enErrors.api) as ApiErrorKind[];
    for (const kind of kinds) {
      expect(portugueseIn(describeError(new ApiError(kind, 400))), `describeError ${kind}`).toEqual([]);
      expectEnglish(`ErrorNotice ${kind}`, html(createElement(ErrorNotice, { error: new ApiError(kind, 400), onRepair: noop })));
    }
    expectEnglish('ErrorNotice (message)', html(createElement(ErrorNotice, { message: 'Could not save.', action: { label: 'Retry', onClick: noop } })));
  });

  it('workspace errors, with the code the daemon sends', () => {
    for (const code of Object.keys(enErrors.workspace)) {
      expectEnglish(`ErrorNotice ${code}`, html(createElement(ErrorNotice, { error: new ApiError('invalid_input', 409, null, code) })));
    }
  });

  it('workspace pieces: info bar and the diff views', () => {
    const info: WorkspaceInfoResponse = { branch: 'main', changedFiles: 3, instructions: ['AGENTS.md'] };
    expectEnglish('WorkspaceInfoBar', html(createElement(WorkspaceInfoBar, { info })));
    expectEnglish('WorkspaceInfoBar (clean)', html(createElement(WorkspaceInfoBar, { info: { ...info, changedFiles: 0 } })));
    expectEnglish('DiffView (new file)', html(createElement(DiffView, { path: 'a.txt', oldText: null, newText: 'x' })));
    expectEnglish('DiffView (edit)', html(createElement(DiffView, { path: 'a.txt', oldText: 'a\nb', newText: 'a\nc' })));
    expectEnglish('UnifiedPatchView (empty)', html(createElement(UnifiedPatchView, { patch: '' })));
  });

  it('file attachments, thumbnails and the cropper', () => {
    const pdf = { fileId: 'f-1', name: 'report.pdf', mime: 'application/pdf', size: 2_621_440 };
    const png = { fileId: 'f-2', name: 'photo.png', mime: 'image/png', size: 1024 };
    expectEnglish('FileAttachment', html(createElement(FileAttachment, { api, file: pdf })));
    expectEnglish('ImageThumb', html(createElement(ImageThumb, { api, file: png })));
    expectEnglish(
      'ImageCropper',
      html(createElement(ImageCropper, { src: 'blob:image', name: 'photo.png', mime: 'image/png', confirmLabel: 'Use crop', onCancel: noop, onConfirm: noop })),
    );
  });
});

// --- chat ---------------------------------------------------------------------------------------------------------------

describe('chat pieces in English', () => {
  const view = { active: true, turnEnds: 0 };
  const item = (value: ChatItem): string => {
    const node: ChatNode = { item: value, children: [] };
    return html(createElement(ChatItemView, { node, api, view }));
  };

  it('every kind of chat item', () => {
    const tool: ChatItem = {
      id: 'tool-1',
      kind: 'tool_call',
      toolCallId: 'call-1',
      title: 'Edit a.ts',
      toolKind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'a\nb', newText: 'a\nc\nd' }],
      locations: [],
    };
    const items: [string, ChatItem][] = [
      ['user message', { id: 'u-1', kind: 'user_message', text: 'run the tests' }],
      ['loop message', { id: 'u-2', kind: 'user_message', text: 'run the tests', loopIteration: 3 }],
      ['agent message', { id: 'a-1', kind: 'agent_message', text: 'Done.\n[[nanachi-loop-next: 45s]]' }],
      ['stopped loop', { id: 'a-2', kind: 'agent_message', text: 'Done.\n[[nanachi-loop-stop]]' }],
      ['thought', { id: 't-1', kind: 'agent_thought', text: 'abcde' }],
      ['file', { id: 'f-1', kind: 'file', file: { fileId: 'f-1', name: 'report.pdf', mime: 'application/pdf', size: 99 }, caption: null }],
      ['account', { id: 'c-1', kind: 'account_changed', label: 'Work' }],
      ['error', { id: 'e-1', kind: 'error', message: 'boom' }],
      ['tool', tool],
      ['pending tool', { ...tool, id: 'tool-2', status: 'in_progress', content: [] }],
      ['failed tool', { ...tool, id: 'tool-3', status: 'failed', content: [] }],
      ['plan', { id: 'p-1', kind: 'plan', entries: [{ content: 'Read the code', priority: 'medium', status: 'in_progress' }] }],
    ];
    for (const [name, value] of items) expectEnglish(`chat item: ${name}`, item(value));
  });

  it('the permission card, plan, slash menu and attachments', () => {
    const request: PendingPermission = {
      kind: 'permission_request',
      seq: 1,
      sessionId: 's-1',
      ts: 1,
      requestId: 'r-1',
      title: 'Run npm test',
      content: [],
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    };
    expectEnglish('PermissionCard', html(createElement(PermissionCard, { api, request, onRespond: () => true })));
    expectEnglish(
      'PlanCard',
      html(
        createElement(PlanCard, {
          entries: [
            { content: 'Read the code', priority: 'medium', status: 'completed' },
            { content: 'Write the test', priority: 'medium', status: 'in_progress' },
            { content: 'Run everything', priority: 'medium', status: 'pending' },
          ],
        }),
      ),
    );
    const command: AvailableCommand = { name: 'model', description: 'Switch the model', hint: null };
    const menu = (commands: AvailableCommand[], query: string) =>
      html(createElement(SlashMenu, { commands, query, search: { onChange: noop, onClose: noop }, onPick: noop }));
    expectEnglish('SlashMenu', menu([command], ''));
    expectEnglish('SlashMenu (empty)', menu([], ''));
    expectEnglish('SlashMenu (no match)', menu([command], ' zzz '));
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    expectEnglish('AttachmentDrafts', html(createElement(AttachmentDrafts, { drafts: [{ id: 'd-1', file, previewUrl: 'blob:preview' }], onRemove: noop, onCrop: noop })));
  });

  it('the loop chip in every state, and the background panel', () => {
    const loop: Loop = {
      sessionId: 's-1',
      prompt: 'run the tests',
      mode: 'interval',
      intervalMs: 300_000,
      maxIterations: 5,
      iterations: 1,
      state: 'active',
      nextRunAt: NOW + 60_000,
      lastRunAt: null,
      lastError: null,
      createdAt: 1,
      revision: 1,
    };
    for (const state of ['active', 'paused'] as const) {
      expectEnglish(`LoopChip ${state}`, html(createElement(LoopChip, { loop: { ...loop, state }, onOpen: noop })));
    }
    expectEnglish('LoopChip (error)', html(createElement(LoopChip, { loop: { ...loop, state: 'paused', lastError: 'boom' }, onOpen: noop })));

    const entry = (kind: BackgroundEntry['kind'], state: BackgroundEntry['state']): BackgroundEntry => ({
      id: `${kind}-${state}`,
      kind,
      state,
      label: 'Review the parser',
      agentType: undefined,
      jobs: [],
      startedAt: NOW - 125_000,
      updatedAt: NOW - 65_000,
      startEnds: 0,
    });
    const entries = (['subagent', 'job', 'shell'] as const).flatMap((kind) =>
      (['running', 'completed', 'failed', 'unknown'] as const).map((state) => entry(kind, state)),
    );
    expectEnglish('BackgroundPanel', html(createElement(BackgroundPanel, { entries, now: NOW, onPick: noop })));
    expectEnglish('BackgroundPanel (empty)', html(createElement(BackgroundPanel, { entries: [], now: NOW, onPick: noop })));
    for (const state of ['running', 'completed', 'failed', 'unknown'] as const) {
      expect(portugueseIn(backgroundStateText(state)), `backgroundStateText ${state}`).toEqual([]);
    }
  });

  it('the model, effort and mode controls', () => {
    const select = (id: string, category: string, name: string): SessionConfigOption => ({
      id,
      name,
      description: null,
      category,
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'Option A' },
        { value: 'b', name: 'Option B' },
      ],
    });
    const options = [select('model', 'model', 'Model'), select('effort', 'thought_level', 'Effort'), select('mode', 'mode', 'Mode')];
    expectEnglish('ConfigControls', html(createElement(ConfigControls, { options, onChange: noop })));
  });
});

// --- usage, resets and accounts ---------------------------------------------------------------------------------------

describe('usage and accounts in English', () => {
  const reset = (overrides: Partial<ResetEntry> = {}): ResetEntry => ({
    target: 'anthropic/1',
    accountLabel: 'fake@example.com · Org',
    providerLabel: 'Anthropic',
    available: 2,
    usable: 1,
    expiresAt: 'in 3 days',
    note: null,
    active: true,
    ...overrides,
  });
  const lists: [string, ResetsListState][] = [
    ['idle', { status: 'idle' }],
    ['loading', { status: 'loading' }],
    ['ready', { status: 'ready', entries: [reset(), reset({ target: 'anthropic/2', usable: 0, active: false, note: 'in use elsewhere' })], message: null }],
    ['empty', { status: 'ready', entries: [], message: null }],
    ['error', { status: 'error', error: new ApiError('network') }],
  ];

  it('the saved resets section, its confirmation and its replies', () => {
    for (const [name, list] of lists) {
      expectEnglish(`ResetsSection ${name}`, html(createElement(ResetsSection, { list, redeem: { status: 'idle' }, now: NOW, onRedeem: noop })));
    }
    const list = lists[2]?.[1];
    if (list === undefined) throw new Error('missing list');
    expectEnglish(
      'ResetsSection (redeeming)',
      html(createElement(ResetsSection, { list, redeem: { status: 'running', target: 'anthropic/1' }, now: NOW, onRedeem: noop })),
    );
    expectEnglish('ResetConfirmActions', html(createElement(ResetConfirmActions, { onCancel: noop, onConfirm: noop })));
    for (const tone of ['success', 'neutral', 'error'] as const) {
      expectEnglish(`RedeemResultNotice ${tone}`, html(createElement(RedeemResultNotice, { result: { tone, message: 'Reset used.' }, onDismiss: noop })));
    }
  });

  it('the usage panel: loading, error and a reply', () => {
    const text = '5 hours: 20% used';
    const states = [
      { status: 'loading' as const },
      { status: 'error' as const, error: new ApiError('network') },
      { status: 'error' as const, error: new ApiError('unexpected', 409, null, 'session_not_active') },
      { status: 'ready' as const, text, fetchedAt: NOW, cached: false, usage: parseUsage('omp', text) },
      { status: 'ready' as const, text, fetchedAt: NOW - 120_000, cached: true, usage: parseUsage('omp', text) },
    ];
    for (const [index, state] of states.entries()) {
      expectEnglish(`UsageContent ${index}`, html(createElement(UsageContent, { state, now: NOW, onRefresh: noop, onResume: noop })));
    }
    expectEnglish(
      'UsageContent (refresh failed)',
      html(createElement(UsageContent, { state: states[3]!, now: NOW, onRefresh: noop, onResume: noop, refreshFailed: { error: new ApiError('network') } })),
    );
    expectEnglish('UsageAccountLine', html(createElement(UsageAccountLine, { account: { label: 'Work', email: 'work@example.com' } })));
  });

  it('the agent accounts group, the account select and the login steps', () => {
    const profile = (overrides: Partial<AgentProfile>): AgentProfile => ({
      id: 'default',
      label: 'Main',
      isDefault: true,
      active: false,
      status: 'logged_in',
      account: 'me@example.com',
      detail: 'Pro',
      checkedAt: NOW,
      ...overrides,
    });
    const profiles = [
      profile({}),
      profile({ id: 'a-1', label: 'Work', isDefault: false, active: true, account: 'work@example.com', detail: null }),
      profile({ id: 'a-2', label: 'Home', isDefault: false, status: 'logged_out', account: null, detail: null }),
    ];
    const agent: AgentAccount = {
      agentId: 'claude',
      label: 'Claude Code',
      status: 'logged_in',
      account: 'me@example.com',
      detail: null,
      checkedAt: NOW,
      supportsAccounts: true,
      profiles,
    };
    expectEnglish('AgentAccountGroup', html(createElement(AgentAccountGroup, { agent, now: NOW, onOpen: noop, onAdd: noop })));
    expectEnglish('AgentAccountGroup (logged out)', html(createElement(AgentAccountGroup, { agent: { ...agent, status: 'logged_out', account: null, profiles: [] }, now: NOW, onOpen: noop, onAdd: noop })));
    expectEnglish('AccountSelect', html(createElement(AccountSelect, { profiles, value: 'a-1', showHint: true, onChange: noop })));

    const steps: LoginStep[] = [
      { kind: 'starting' },
      { kind: 'link', url: 'https://example.com/auth', userCode: null, needsCode: true, codeSent: false },
      { kind: 'link', url: 'https://example.com/device', userCode: 'ABCD-1234', needsCode: false, codeSent: false },
      { kind: 'link', url: 'https://example.com/auth', userCode: null, needsCode: true, codeSent: true },
      { kind: 'verifying' },
      { kind: 'success', account: 'work@example.com' },
      { kind: 'success', account: null },
      { kind: 'failure', error: 'The login failed.', output: 'exit 1' },
      { kind: 'cancelled' },
    ];
    for (const [index, step] of steps.entries()) {
      const element = createElement(AccountLoginBody, {
        step,
        code: '',
        sending: false,
        codeProblem: null,
        problem: null,
        onCodeChange: noop,
        onSendCode: noop,
      });
      expectEnglish(`AccountLoginBody ${index}`, html(element));
    }
    const typing = createElement(AccountLoginBody, {
      step: steps[1]!,
      code: 'abc',
      sending: true,
      codeProblem: 'Paste the code.',
      problem: 'Network problem.',
      onCodeChange: noop,
      onSendCode: noop,
    });
    expectEnglish('AccountLoginBody (sending)', html(typing));
  });
});

// --- Nanachi Desktop -----------------------------------------------------------------------------------------------------

describe('the Desktop group in English', () => {
  const daemon: DaemonStatus = {
    state: 'running',
    port: 7811,
    mode: 'spawned',
    pid: 4242,
    version: '1.2.3',
    machineName: 'PC',
    restricted: false,
    message: null,
    logTail: [],
  };
  const props = (overrides: Partial<DesktopPanelViewProps> = {}): DesktopPanelViewProps => ({
    version: '0.1.0',
    daemon,
    autostart: false,
    autostartBusy: false,
    tailscale: { state: 'off' },
    tailscaleBusy: false,
    update: null,
    checking: false,
    failure: null,
    onAutostart: noop,
    onPairing: noop,
    onCheckUpdate: noop,
    onTailscale: noop,
    ...overrides,
  });

  it('the panel in every daemon, Tailscale and update state', () => {
    const variants: [string, Partial<DesktopPanelViewProps>][] = [
      ['default', {}],
      ['unknown', { daemon: null, tailscale: null, autostart: null }],
      ['starting', { daemon: { ...daemon, state: 'starting' } }],
      ['attached', { daemon: { ...daemon, state: 'attached', mode: 'attached' } }],
      ['stopped', { daemon: { ...daemon, state: 'stopped', mode: 'none' } }],
      ['error', { daemon: { ...daemon, state: 'error', message: null, logTail: ['line 1'] } }],
      ['restricted', { daemon: { ...daemon, restricted: true } }],
      ['tailscale starting', { tailscale: { state: 'starting' } }],
      ['tailscale login', { tailscale: { state: 'needs_login', authUrl: 'https://login.example.com/a' } }],
      ['tailscale running', { tailscale: { state: 'running', dnsName: 'pc.tail.ts.net', tailnet: 'tail', ips: ['100.64.0.1'] } }],
      ['tailscale error', { tailscale: { state: 'error', message: 'failed' } }],
      ['tailscale busy', { tailscaleBusy: true }],
      ['autostart on', { autostart: true }],
      ['autostart busy', { autostartBusy: true }],
      ['checking', { checking: true }],
      ['up to date', { update: { status: 'up-to-date', current: '0.1.0' } }],
      ['update available', { update: { status: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://example.com/r' } }],
      ['update error', { update: { status: 'error', current: '0.1.0', message: 'offline' } }],
    ];
    for (const [name, overrides] of variants) {
      expectEnglish(`DesktopPanelView ${name}`, html(createElement(DesktopPanelView, props(overrides))));
    }
  });

  it('the pairing code body', () => {
    const code = { code: '123456', expiresAt: NOW + 240_000 };
    expectEnglish('PairingCodeBody', html(createElement(PairingCodeBody, { code, loading: false, failed: false, now: NOW })));
    expectEnglish('PairingCodeBody (expiring)', html(createElement(PairingCodeBody, { code, loading: false, failed: false, now: NOW + 239_000 })));
    expectEnglish('PairingCodeBody (expired)', html(createElement(PairingCodeBody, { code, loading: false, failed: false, now: NOW + 300_000 })));
    expectEnglish('PairingCodeBody (loading)', html(createElement(PairingCodeBody, { code: null, loading: true, failed: false, now: NOW })));
    expectEnglish('PairingCodeBody (failed)', html(createElement(PairingCodeBody, { code: null, loading: false, failed: true, now: NOW })));
  });
});

// --- the translation files (covers the sheets, toasts and every text built outside React) ----------------------------

/** Values of a namespace as `key: text` pairs, so a failure names the key. */
function entries(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => entries(child, prefix === '' ? key : `${prefix}.${key}`));
}

describe('the English translation files', () => {
  const files: Record<string, unknown> = {
    accounts: enAccounts,
    chat: enChat,
    common: enCommon,
    desktop: enDesktop,
    devices: enDevices,
    errors: enErrors,
    files: enFiles,
    machines: enMachines,
    pairing: enPairing,
    settings: enSettings,
    terminal: enTerminal,
    usage: enUsage,
    workspace: enWorkspace,
  };

  it('covers every registered namespace', () => {
    expect(Object.keys(files).sort()).toEqual([...NAMESPACES].sort());
  });

  it('has no Portuguese word or diacritic in any value', () => {
    const found: string[] = [];
    for (const [namespace, content] of Object.entries(files)) {
      for (const [key, text] of entries(content)) {
        const words = portugueseIn(text);
        if (words.length > 0) found.push(`${namespace}:${key} -> ${words.join(', ')}`);
      }
    }
    expect(found).toEqual([]);
  });
});
