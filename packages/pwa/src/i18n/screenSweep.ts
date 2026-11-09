// The screens, panels and cards that a static render can produce, rendered in one language with fake data written in
// English, for the sweeps that look for text left over from another language (`noPortuguese.en.test.ts` and
// `noPortuguese.es.test.ts`). Each sweep brings its own detector: this file only renders the pieces and hands every
// markup string (or plain text) to it, so a new screen or panel is added here once and checked in every language.
//
// Sheets (drawers) mount in a portal that a static render skips, so their text is checked in the translation files
// instead (by each sweep) and in the browser by e2e/run-i18n.mjs. Effects do not run in a static render: the data
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
import { LearningSettingsSchema, TranscriptionSettingsSchema, type MemoryEntry } from '@nanachi/shared';
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
import { NanachiMcpSectionView } from '../components/NanachiMcpSection.js';
import { LearningSettingsForm } from '../components/LearningSection.js';
import { TranscriptionSettingsForm } from '../whisper/TranscriptionSettings.js';
import { MemoryEntries } from '../components/WorkspaceMemory.js';
import { LearningNoticeView } from '../chat/LearningNotice.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { SessionMessageMatches, type MessageMatchRow } from '../components/SessionMessageMatches.js';
import { SessionSearchField } from '../components/SessionSearchField.js';
import { ShowAll } from '../components/ShowAll.js';
import type { MessageSearchState } from '../useSessionMessageSearch.js';
import { UnifiedPatchView } from '../components/UnifiedPatchView.js';
import { UsageAccountLine, UsageContent } from '../components/UsageDrawer.js';
import { WorkspaceInfoBar } from '../components/WorkspaceInfoBar.js';
import { AttachmentDrafts } from '../chat/AttachmentDrafts.js';
import { BackgroundPanel } from '../chat/BackgroundDrawer.js';
import { backgroundStateText } from '../chat/BackgroundStatus.js';
import type { BackgroundEntry } from '../chat/background.js';
import { ChatItemView } from '../chat/ChatItemView.js';
import { ToolActivity } from '../chat/ToolActivity.js';
import { LoopChip } from '../chat/LoopChip.js';
import type { ChatNode } from '../chat/nesting.js';
import { PermissionCard } from '../chat/PermissionCard.js';
import { UserQuestionCardView, type UserQuestionCardState } from '../chat/UserQuestionCard.js';
import { FileRequestCardView, type FileRequestCardState } from '../chat/FileRequestCard.js';
import { PreviewCardView, type PreviewCardState } from '../chat/PreviewCard.js';
import { PlanCard } from '../chat/PlanCard.js';
import { PlanDock } from '../chat/PlanDock.js';
import type { ChatItem, FileRequestItem, PendingPermission, PreviewItem, UserQuestionItem } from '../chat/reducer.js';
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
import { CommitScreen } from '../screens/CommitScreen.js';
import { CommitsScreen, WorkingTreeRow } from '../screens/CommitsScreen.js';
import { DevicesScreen } from '../screens/DevicesScreen.js';
import { EditorScreen } from '../screens/EditorScreen.js';
import { FilesScreen } from '../screens/FilesScreen.js';
import { FolderPickerScreen } from '../screens/FolderPickerScreen.js';
import { MainScreen } from '../screens/MainScreen.js';
import { PairConnecting, PairInstallGuide } from '../screens/PairLinkScreens.js';
import { PairScreen } from '../screens/PairScreen.js';
import { SessionsScreen } from '../screens/SessionsScreen.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';
import { SchedulesScreen, ScheduleRows } from '../screens/SchedulesScreen.js';
import { ScheduleForm } from '../schedules/ScheduleForm.js';
import { ScheduleRunDetails } from '../schedules/ScheduleHistory.js';
import { ScheduleSchema, ScheduleRunSchema } from '@nanachi/shared';
import { TerminalScreen } from '../screens/TerminalScreen.js';
import { WorkspacesScreen } from '../screens/WorkspacesScreen.js';
import { parseUsage } from '../usage/parseUsage.js';
import { RedeemResultNotice, ResetConfirmActions, ResetsSection } from '../usage/ResetsSection.js';
import type { ResetsListState } from '../usage/resetsFlow.js';
import { EmptyDetail } from '../wide/EmptyDetail.js';
import { ListPaneView } from '../wide/ListPaneView.js';
import { buildTree } from '../wide/sessionTree.js';
import { setLanguage, type Language } from './index.js';
import { resources } from './resources.js';

/** Values of a namespace as `key: text` pairs, so a failure names the key. */
export function entries(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => entries(child, prefix === '' ? key : `${prefix}.${key}`));
}

export const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

/** What a person reads in a markup string: its text nodes and the attributes screen readers and tooltips use. */
export function visibleText(markup: string): string {
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
  const attributes = [...markup.matchAll(/\s(?:aria-label|title|placeholder|alt|aria-description)="([^"]*)"/g)].map((match) => match[1] ?? '');
  const text = markup.replace(/<[^>]*>/g, '\n');
  const joined = [text, ...attributes].join('\n');
  return joined.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => entities[entity] ?? entity);
}

/** How a sweep judges the language under test. */
export interface ScreenSweep {
  /** The language rendered. */
  readonly language: Language;
  /** Its name in the test titles ("English"). */
  readonly label: string;
  /** Fails when the markup of a rendered piece has text from another language, naming the piece. */
  readonly expectClean: (name: string, markup: string) => void;
  /** The words of a plain text that do not belong to the language (empty when it is clean). */
  readonly leftover: (text: string) => string[];
}

// --- fake data, all in English ------------------------------------------------------------------------------------

export const noop = () => undefined;
export const nav = { push: noop, back: noop, replace: noop };
// The effects never run in a static render, so the client is never called.
export const api = {} as ApiClient;
const storage: StorageLike = { getItem: () => null, setItem: noop, removeItem: noop };
const NOW = 1_800_000_000_000;

const machine: Machine = { id: 'm1', name: 'OFFICE-PC', baseUrl: 'http://127.0.0.1:7777', token: 'token' };
export const workspace: Workspace = { id: 'w1', name: 'demo', path: 'C:\\Projects\\demo', muted: false, createdAt: NOW };

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

/** Registers the sweep of every screen, shared component and chat, usage, accounts and Desktop piece in one language. */
export function describeScreenSweep(sweep: ScreenSweep): void {
  const { language, label, expectClean, leftover } = sweep;

  beforeEach(() => {
    setLanguage(language);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- the app screens ------------------------------------------------------------------------------------------------

  describe(`app screens in ${label}`, () => {
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
      expectClean('MainScreen', html(createElement(MainScreen, main)));
      expectClean('MainScreen (unauthorized)', html(createElement(MainScreen, { ...main, statuses: { m1: 'unauthorized' as const } })));
      expectClean('MainScreen (offline)', html(createElement(MainScreen, { ...main, statuses: { m1: 'offline' as const } })));

      const pair = { initialBaseUrl: 'http://127.0.0.1:7777', canCancel: true, onCancel: noop, onPaired: noop };
      expectClean('PairScreen', html(createElement(PairScreen, pair)));
      expectClean('PairScreen (first run)', html(createElement(PairScreen, { ...pair, canCancel: false })));
      expectClean('PairConnecting', html(createElement(PairConnecting)));
      expectClean('PairInstallGuide', html(createElement(PairInstallGuide, { onContinue: noop })));
      expectClean('DevicesScreen', html(createElement(DevicesScreen, { machine, nav })));
    });

    it('settings, with the language row and the notifications block', () => {
      const settings = () => html(createElement(SettingsScreen, { machines: [machine], selected: machine, nav }));
      // The notifications block reads the browser: no push support, then support with each permission.
      vi.stubGlobal('window', {});
      expectClean('SettingsScreen (no push)', settings());
      vi.stubGlobal('navigator', { serviceWorker: {} });
      vi.stubGlobal('window', { PushManager: {}, Notification: {} });
      for (const permission of ['default', 'granted', 'denied']) {
        vi.stubGlobal('Notification', { permission });
        expectClean(`SettingsScreen (${permission})`, settings());
      }
      expectClean('LanguageSection', html(createElement(LanguageSection)));
    });

    it('Nanachi MCP preferences: loading, confirmed choices, saving, empty and failures', () => {
      const data = {
        agents: [
          { id: 'claude', label: 'Claude Code', enabled: false },
          { id: 'codex', label: 'Codex', enabled: true },
        ],
      };
      const states: [string, Parameters<typeof NanachiMcpSectionView>[0]['state']][] = [
        ['loading', { data: null, loading: true, saving: null, failure: null }],
        ['load failed', { data: null, loading: false, saving: null, failure: { kind: 'load' } }],
        ['all disabled', { data: { agents: data.agents.map((agent) => ({ ...agent, enabled: false })) }, loading: false, saving: null, failure: null }],
        ['confirmed', { data, loading: false, saving: null, failure: null }],
        ['empty', { data: { agents: [] }, loading: false, saving: null, failure: null }],
        ['saving', { data, loading: false, saving: 'claude', failure: null }],
        ['save failed', { data, loading: false, saving: null, failure: { kind: 'save', agentId: 'claude', enabled: true } }],
      ];
      for (const [name, state] of states) {
        expectClean(
          `NanachiMcpSection ${name}`,
          html(createElement(NanachiMcpSectionView, { machineName: 'OFFICE-PC', state, onChange: noop, onRetry: noop })),
        );
      }
    });

    it('workspace schedules, both task forms and dedicated execution output', () => {
      const schedule = ScheduleSchema.parse({
        id: 'schedule-1', workspaceId: workspace.id, name: 'Build report', cronExpression: '0 9 * * 1-5',
        timeZone: 'UTC', enabled: false, nextRunAt: null, createdAt: NOW, updatedAt: NOW,
        task: { kind: 'agent', agentId: 'omp', prompt: 'Review changed files' },
      });
      expectClean('SchedulesScreen', html(createElement(SchedulesScreen, { api, workspace, machineName: 'OFFICE-PC', nav, onRepair: noop })));
      expectClean('ScheduleRows', html(createElement(ScheduleRows, { schedules: [schedule], busy: false, onEdit: noop, onHistory: noop, onAction: noop })));
      const form = { api, workspaceId: workspace.id, agents: [{ id: 'omp', label: 'Oh My Pi', kind: 'acp' as const }], accounts: [], shells: [{ id: 'powershell' as const, label: 'PowerShell', isDefault: true }], onSaved: noop, onCancel: noop };
      expectClean('ScheduleForm agent', html(createElement(ScheduleForm, { ...form, schedule })));
      expectClean('ScheduleForm command', html(createElement(ScheduleForm, { ...form, schedule: { ...schedule, task: { kind: 'command', shell: 'powershell', command: 'Write-Output report' } } })));
      const run = ScheduleRunSchema.parse({ id: 'run-1', scheduleId: schedule.id, workspaceId: workspace.id, scheduleName: schedule.name, task: schedule.task, trigger: 'manual', status: 'awaiting_permission', scheduledAt: NOW, startedAt: NOW, finishedAt: null, sessionId: 's-automation', exitCode: null, error: null, output: 'Agent output', outputTruncated: true });
      expectClean('ScheduleRunDetails', html(createElement(ScheduleRunDetails, { run, busy: false, onCancel: noop, onOpen: noop })));
    });

    it('the chat screen, in every session status', () => {
      for (const status of STATUSES) {
        const element = createElement(ChatScreen, {
          machineId: 'fixture-machine',
          machineName: 'OFFICE-PC',
          workspace,
          session: session(status),
          api,
          connection: undefined,
          storage,
          nav,
          onRepair: noop,
        });
        expectClean(`ChatScreen ${status}`, html(element));
      }
    });

    it('workspace list, sessions, folder picker, files, editor, changes and terminal', () => {
      expectClean(
        'WorkspacesScreen',
        html(
          createElement(WorkspacesScreen, {
            machineName: 'OFFICE-PC',
            api,
            connection: undefined,
            status: undefined,
            nav,
            onRepair: noop,
          }),
        ),
      );
      expectClean(
        'SessionsScreen',
        html(
          createElement(SessionsScreen, { machineName: 'OFFICE-PC', workspace, api, connection: undefined, storage, nav, onRepair: noop }),
        ),
      );
      expectClean('FolderPickerScreen', html(createElement(FolderPickerScreen, { api, nav, onRepair: noop })));
      for (const path of ['', 'src/screens']) {
        expectClean(`FilesScreen ${path}`, html(createElement(FilesScreen, { workspace, path, api, nav, onRepair: noop })));
      }
      for (const path of ['src/App.tsx', 'notes.txt', 'data.json', 'README.md']) {
        expectClean(`EditorScreen ${path}`, html(createElement(EditorScreen, { workspace, path, api, nav, onRepair: noop })));
      }
      const shell = session('running', { agent: 'shell', kind: 'pty', title: 'Terminal · powershell' });
      expectClean('ChangesScreen', html(createElement(ChangesScreen, { machineName: 'OFFICE-PC', workspace, session: shell, api, nav, onRepair: noop })));
      expectClean(
        'CommitsScreen',
        html(createElement(CommitsScreen, { machineName: 'OFFICE-PC', workspace, session: shell, api, nav, onRepair: noop })),
      );
      expectClean(
        'CommitScreen',
        html(
          createElement(CommitScreen, {
            machineName: 'OFFICE-PC',
            workspace,
            session: shell,
            hash: 'af9384ef96648594f13a8bd80ae53aa3e830a8ae',
            api,
            nav,
            onRepair: noop,
          }),
        ),
      );
      for (const state of [
        { kind: 'loading' },
        { kind: 'counted', changedFiles: 0 },
        { kind: 'counted', changedFiles: 1 },
        { kind: 'counted', changedFiles: 3 },
        { kind: 'counted', changedFiles: null },
      ] as const) {
        expectClean(`WorkingTreeRow ${JSON.stringify(state)}`, html(createElement(WorkingTreeRow, { state, workspace, session: shell, nav })));
      }
      expectClean(
        'TerminalScreen',
        html(createElement(TerminalScreen, { machineName: 'OFFICE-PC', workspace, session: shell, api, connection: undefined, nav })),
      );
    });
  });

  // --- shared components ----------------------------------------------------------------------------------------------

  describe(`shared components in ${label}`, () => {
    it('voice providers, write-only connections and model discovery states', () => {
      for (const provider of ['whisper', 'openai', 'groq', 'custom'] as const) {
        const settings = { ...TranscriptionSettingsSchema.parse({ provider, model: 'test-stt', baseUrl: provider === 'custom' ? 'https://speech.example/v1' : '' }), apiKeyConfigured: true };
        for (const state of ['ready', 'loading', 'failed', 'empty'] as const) {
          expectClean(`TranscriptionSettings ${provider} ${state}`, html(createElement(TranscriptionSettingsForm, {
            settings, catalog: { models: state === 'empty' ? [] : [{ id: 'test-stt', name: 'Test speech model', provider, deprecated: true }], manual: provider === 'custom' },
            modelsLoading: state === 'loading', modelsFailed: state === 'failed', onRefresh: noop, onSave: async () => settings,
          })));
        }
      }
    });

    it('learning settings, local endpoints, memory entries and review outcomes', () => {
      for (const source of ['same', 'agent', 'openrouter', 'openai', 'ollama'] as const) {
        const settings = { ...LearningSettingsSchema.parse({ reviewer: { source, agentId: 'fake', model: 'test-model' } }), apiKeyConfigured: true };
        expectClean(`LearningSettings ${source}`, html(createElement(LearningSettingsForm, {
          settings, agents: [{ id: 'fake', label: 'Test Agent', kind: 'acp' }],
          catalog: { models: [{ id: 'test-model', label: 'Test Model', provider: 'Test Provider', source: 'agent', agentId: 'fake' }], errors: [] },
          modelsLoading: false, modelsFailed: false, onRefresh: noop, onSave: async () => settings,
        })));
      }
      const entry: MemoryEntry = {
        id: '22222222-2222-4222-8222-222222222222', workspaceId: workspace.id, kind: 'memory', title: 'Transactions',
        content: 'Use existing transactions.', status: 'active', version: 1, sourceSessionId: 's1',
        reviewId: '11111111-1111-4111-8111-111111111111', evidenceSeqs: [1], createdAt: NOW, updatedAt: NOW,
      };
      expectClean('MemoryEntries empty', html(createElement(MemoryEntries, { entries: [], api, onChanged: async () => undefined })));
      expectClean('MemoryEntries active and pending', html(createElement(MemoryEntries, { entries: [entry, { ...entry, id: '33333333-3333-4333-8333-333333333333', kind: 'skill', status: 'pending' }], api, onChanged: async () => undefined })));
      for (const status of ['applied', 'pending', 'failed', 'reverted', 'rejected'] as const) {
        expectClean(`LearningNotice ${status}`, html(createElement(LearningNoticeView, {
          notice: { reviewId: entry.reviewId!, sourceTurnSeq: 3, status, summary: 'Transaction helper', memoryCount: 1, skillCount: 1, entryIds: [entry.id] },
          api, workspaceId: workspace.id, onManage: async () => undefined,
        })));
      }
    });

    it('header, status pills, show-all and the action sheet panel', () => {
      expectClean('ScreenHeader', html(createElement(ScreenHeader, { title: 'Title', onBack: noop })));
      for (const status of STATUSES) {
        expectClean(`SessionStatusPill ${status}`, html(createElement(SessionStatusPill, { status })));
        expectClean(`SessionStatusPill ${status} (terminal)`, html(createElement(SessionStatusPill, { status, kind: 'pty' })));
      }
      expectClean('ShowAll', html(createElement(ShowAll, { hidden: 12, onExpand: noop })));
      expectClean(
        'ActionSheetPanel',
        html(createElement(ActionSheetPanel, { title: 'Actions', items: [{ label: 'Rename', onSelect: noop }], onClose: noop, onPick: noop })),
      );
    });

    it('the session search field and the message matches in every state', () => {
      expectClean('SessionSearchField', html(createElement(SessionSearchField, { value: '', onChange: noop })));
      expectClean('SessionSearchField (typed)', html(createElement(SessionSearchField, { value: 'parser', onChange: noop })));
      const row: MessageMatchRow = {
        workspace,
        session: session('running', { title: 'Fix the build' }),
        label: 'Fix the build',
        snippet: 'the parser reads the file first',
        matchedAt: NOW - 60_000,
      };
      const states: [string, MessageSearchState, MessageMatchRow[]][] = [
        ['loading', { status: 'loading' }, []],
        ['failed', { status: 'failed', error: new ApiError('network') }, []],
        ['no match', { status: 'ready', results: [] }, []],
        ['matches', { status: 'ready', results: [] }, [row]],
      ];
      for (const [name, state, rows] of states) {
        expectClean(
          `SessionMessageMatches (${name})`,
          html(createElement(SessionMessageMatches, { state, rows, showWorkspace: true, selectedSessionId: row.session.id, now: NOW, onOpen: noop })),
        );
      }
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
        expectClean(`MachineCard ${name}`, html(element));
      }
    });

    it('every error the API can raise reads cleanly', () => {
      const kinds = Object.keys(resources['pt-BR'].errors.api) as ApiErrorKind[];
      for (const kind of kinds) {
        expect(leftover(describeError(new ApiError(kind, 400))), `describeError ${kind}`).toEqual([]);
        expectClean(`ErrorNotice ${kind}`, html(createElement(ErrorNotice, { error: new ApiError(kind, 400), onRepair: noop })));
      }
      expectClean('ErrorNotice (message)', html(createElement(ErrorNotice, { message: 'Could not save.', action: { label: 'Retry', onClick: noop } })));
    });

    it('workspace errors, with the code the daemon sends', () => {
      for (const code of Object.keys(resources['pt-BR'].errors.workspace)) {
        expectClean(`ErrorNotice ${code}`, html(createElement(ErrorNotice, { error: new ApiError('invalid_input', 409, null, code) })));
      }
    });

    it('workspace pieces: info bar and the diff views', () => {
      const info: WorkspaceInfoResponse = { branch: 'main', changedFiles: 3, instructions: ['AGENTS.md'] };
      expectClean('WorkspaceInfoBar', html(createElement(WorkspaceInfoBar, { info })));
      expectClean('WorkspaceInfoBar (clean)', html(createElement(WorkspaceInfoBar, { info: { ...info, changedFiles: 0 } })));
      expectClean('DiffView (new file)', html(createElement(DiffView, { path: 'a.txt', oldText: null, newText: 'x' })));
      expectClean('DiffView (edit)', html(createElement(DiffView, { path: 'a.txt', oldText: 'a\nb', newText: 'a\nc' })));
      expectClean('UnifiedPatchView (empty)', html(createElement(UnifiedPatchView, { patch: '' })));
    });

    it('file attachments, thumbnails and the cropper', () => {
      const pdf = { fileId: 'f-1', name: 'report.pdf', mime: 'application/pdf', size: 2_621_440 };
      const png = { fileId: 'f-2', name: 'photo.png', mime: 'image/png', size: 1024 };
      expectClean('FileAttachment', html(createElement(FileAttachment, { api, file: pdf })));
      expectClean('ImageThumb', html(createElement(ImageThumb, { api, file: png })));
      expectClean(
        'ImageCropper',
        html(createElement(ImageCropper, { src: 'blob:image', name: 'photo.png', mime: 'image/png', confirmLabel: 'Use crop', onCancel: noop, onConfirm: noop })),
      );
    });
  });

  // --- chat ---------------------------------------------------------------------------------------------------------------

  describe(`chat pieces in ${label}`, () => {
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
      for (const [name, value] of items) expectClean(`chat item: ${name}`, item(value));
      for (const status of ['completed', 'in_progress', null] as const) {
        const nodes: ChatNode[] = [{ item: { ...tool, status }, children: [] }];
        expectClean(`tool activity: ${status ?? 'unknown'}`, html(createElement(ToolActivity, {
          nodes, view, renderNode: (node) => createElement(ChatItemView, { node, api, view, nested: true }),
        })));
      }
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
      expectClean('PermissionCard', html(createElement(PermissionCard, { api, request, onRespond: () => true })));
      expectClean(
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
      expectClean('PlanDock', html(createElement(PlanDock, {
        entries: [{ content: 'Write the test', priority: 'medium', status: 'in_progress' }],
      })));
      expectClean('PlanDock (completed)', html(createElement(PlanDock, {
        entries: [{ content: 'Write the test', priority: 'medium', status: 'completed' }],
      })));
      const command: AvailableCommand = { name: 'model', description: 'Switch the model', hint: null };
      const menu = (commands: AvailableCommand[], query: string) =>
        html(createElement(SlashMenu, { commands, query, onPick: noop }));
      expectClean('SlashMenu', menu([command], ''));
      expectClean('SlashMenu (empty)', menu([], ''));
      expectClean('SlashMenu (no match)', menu([command], ' zzz '));
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      expectClean('AttachmentDrafts', html(createElement(AttachmentDrafts, { drafts: [{ id: 'd-1', file, previewUrl: 'blob:preview' }], onRemove: noop, onCrop: noop })));
    });

    it('the user question card: choices, cancellation, saving, retry, expiry, unavailable and confirmed history', () => {
      const request: UserQuestionItem = {
        id: 'question-q1',
        kind: 'user_question',
        requestId: 'q1',
        question: 'Which approach should we use?',
        options: [{ id: 'a', label: 'Keep the current approach' }, { id: 'b', label: 'Use the alternative approach' }],
        expiresAt: NOW + 300_000,
        result: null,
        unavailable: false,
      };
      const states: UserQuestionCardState[] = [
        { kind: 'idle' },
        { kind: 'saving', optionId: 'a' },
        { kind: 'saving', optionId: null },
        { kind: 'failed', optionId: 'b' },
        { kind: 'failed', optionId: null },
        { kind: 'unavailable' },
      ];
      for (const state of states) {
        expectClean(`UserQuestionCard ${state.kind}`, html(createElement(UserQuestionCardView, {
          request, state, onRespond: noop, onRetry: noop, onChange: noop,
        })));
      }
      expectClean('UserQuestionCard expired', html(createElement(UserQuestionCardView, {
        request, state: { kind: 'idle' }, expired: true, onRespond: noop,
      })));
      expectClean('UserQuestionCard unavailable history', item({ ...request, unavailable: true }));
      expectClean('UserQuestionCard answered history', item({
        ...request, result: { status: 'answered', option: request.options[0]! },
      }));
      for (const reason of ['user_cancelled', 'expired', 'disconnected', 'session_ended'] as const) {
        expectClean(`UserQuestionCard cancelled ${reason}`, item({
          ...request, result: { status: 'cancelled', reason },
        }));
      }
    });

    it('requested file cards: choose, upload, retry, type feedback, expiry and resolved history', () => {
      const request: FileRequestItem = {
        id: 'file-request-r1', kind: 'file_request', requestId: 'r1', prompt: 'Choose the report',
        accept: ['.pdf', 'image/*'], expiresAt: NOW + 300_000, result: null, unavailable: false,
      };
      const states: FileRequestCardState[] = ['idle', 'uploading', 'saving', 'upload_failed', 'response_failed', 'invalid_type', 'unavailable'];
      for (const state of states) {
        expectClean(`FileRequestCard ${state}`, html(createElement(FileRequestCardView, {
          api, request, state, selectedName: 'report.pdf', progress: 0.5, onChoose: noop, onSend: noop, onCancel: noop, onRetry: noop,
        })));
      }
      expectClean('FileRequestCard empty selection', html(createElement(FileRequestCardView, { api, request, state: 'idle', onChoose: noop })));
      expectClean('FileRequestCard unconfirmed cancel', html(createElement(FileRequestCardView, { api, request, state: 'response_failed', cancelling: true, onChoose: noop })));
      expectClean('FileRequestCard expired', html(createElement(FileRequestCardView, { api, request, state: 'idle', expired: true, onChoose: noop })));
      expectClean('FileRequestCard unavailable history', item({ ...request, unavailable: true }));
      expectClean('FileRequestCard received history', item({
        ...request, result: { status: 'received', file: { fileId: 'f1', name: 'report.pdf', mime: 'application/pdf', size: 42 } },
      }));
      for (const reason of ['user_cancelled', 'expired', 'disconnected', 'session_ended'] as const) {
        expectClean(`FileRequestCard cancelled ${reason}`, item({ ...request, result: { status: 'cancelled', reason } }));
      }
    });

    it('preview cards: open, close, popup, failures, stale history and expiry', () => {
      const preview: PreviewItem = {
        id: 'preview-p1', kind: 'preview', previewId: 'p1', title: 'Local app', port: 3000,
        path: '/demo', expiresAt: NOW + 1_800_000, closedReason: null, unavailable: false,
      };
      const states: PreviewCardState[] = ['idle', 'opening', 'closing', 'opened', 'open_failed', 'close_failed', 'popup_blocked', 'unavailable'];
      for (const state of states) {
        expectClean(`PreviewCard ${state}`, html(createElement(PreviewCardView, { preview, state, onOpen: noop, onClose: noop })));
      }
      expectClean('PreviewCard fallback title', html(createElement(PreviewCardView, { preview: { ...preview, title: '' }, state: 'idle', onOpen: noop, onClose: noop })));
      expectClean('PreviewCard expired', html(createElement(PreviewCardView, { preview, state: 'idle', expired: true, onOpen: noop })));
      expectClean('PreviewCard stale history', html(createElement(PreviewCardView, { preview: { ...preview, unavailable: true }, state: 'idle' })));
      for (const reason of ['closed', 'expired', 'session_ended'] as const) {
        expectClean(`PreviewCard closed ${reason}`, html(createElement(PreviewCardView, { preview: { ...preview, closedReason: reason }, state: 'idle' })));
      }
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
        expectClean(`LoopChip ${state}`, html(createElement(LoopChip, { loop: { ...loop, state }, onOpen: noop })));
      }
      expectClean('LoopChip (error)', html(createElement(LoopChip, { loop: { ...loop, state: 'paused', lastError: 'boom' }, onOpen: noop })));

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
      expectClean('BackgroundPanel', html(createElement(BackgroundPanel, { entries, now: NOW, onPick: noop })));
      expectClean('BackgroundPanel (empty)', html(createElement(BackgroundPanel, { entries: [], now: NOW, onPick: noop })));
      for (const state of ['running', 'completed', 'failed', 'unknown'] as const) {
        expect(leftover(backgroundStateText(state)), `backgroundStateText ${state}`).toEqual([]);
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
      expectClean('ConfigControls', html(createElement(ConfigControls, { options, onChange: noop })));
    });
  });

  // --- usage, resets and accounts ---------------------------------------------------------------------------------------

  describe(`usage and accounts in ${label}`, () => {
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
        expectClean(`ResetsSection ${name}`, html(createElement(ResetsSection, { list, redeem: { status: 'idle' }, now: NOW, onRedeem: noop })));
      }
      const list = lists[2]?.[1];
      if (list === undefined) throw new Error('missing list');
      expectClean(
        'ResetsSection (redeeming)',
        html(createElement(ResetsSection, { list, redeem: { status: 'running', target: 'anthropic/1' }, now: NOW, onRedeem: noop })),
      );
      expectClean('ResetConfirmActions', html(createElement(ResetConfirmActions, { onCancel: noop, onConfirm: noop })));
      for (const tone of ['success', 'neutral', 'error'] as const) {
        expectClean(`RedeemResultNotice ${tone}`, html(createElement(RedeemResultNotice, { result: { tone, message: 'Reset used.' }, onDismiss: noop })));
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
        expectClean(`UsageContent ${index}`, html(createElement(UsageContent, { state, now: NOW, onRefresh: noop, onResume: noop })));
      }
      expectClean(
        'UsageContent (refresh failed)',
        html(createElement(UsageContent, { state: states[3]!, now: NOW, onRefresh: noop, onResume: noop, refreshFailed: { error: new ApiError('network') } })),
      );
      expectClean('UsageAccountLine', html(createElement(UsageAccountLine, { account: { label: 'Work', email: 'work@example.com' } })));
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
      expectClean('AgentAccountGroup', html(createElement(AgentAccountGroup, { agent, now: NOW, onOpen: noop, onAdd: noop })));
      expectClean('AgentAccountGroup (logged out)', html(createElement(AgentAccountGroup, { agent: { ...agent, status: 'logged_out', account: null, profiles: [] }, now: NOW, onOpen: noop, onAdd: noop })));
      expectClean('AccountSelect', html(createElement(AccountSelect, { profiles, value: 'a-1', showHint: true, onChange: noop })));

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
        expectClean(`AccountLoginBody ${index}`, html(element));
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
      expectClean('AccountLoginBody (sending)', html(typing));
    });
  });

  // --- Nanachi Desktop -----------------------------------------------------------------------------------------------------

  describe(`the Desktop group in ${label}`, () => {
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
        expectClean(`DesktopPanelView ${name}`, html(createElement(DesktopPanelView, props(overrides))));
      }
    });

    it('the wide layout: the list pane and the empty screen', () => {
      const nodes = buildTree(
        [workspace, { ...workspace, id: 'w2', name: 'docs' }],
        {
          w1: [
            session('awaiting_permission', { id: 'a' }),
            ...Array.from({ length: 7 }, (_, index) => session('idle', { id: `i${index}`, updatedAt: NOW - (index + 10) * 60_000 })),
            session('running', { id: 't', kind: 'pty', agent: 'shell', title: 'Terminal' }),
          ],
        },
        {},
        new Set(),
      );
      const view = {
        header: null,
        nodes,
        error: null,
        query: '',
        onQueryChange: noop,
        messageState: { status: 'idle' as const },
        messageRows: [],
        selection: { workspaceId: 'w1', sessionId: 'i0' },
        agentLabels: new Map([['omp', 'Oh My Pi']]),
        now: NOW,
        onOpenWorkspace: noop,
        onOpenSession: noop,
        onNewSession: noop,
        onOpenSchedules: noop,
        onAddWorkspace: noop,
        onRepair: noop,
      };
      expectClean('ListPaneView', html(createElement(ListPaneView, view)));
      expectClean('ListPaneView (loading)', html(createElement(ListPaneView, { ...view, nodes: null })));
      expectClean('ListPaneView (no workspaces)', html(createElement(ListPaneView, { ...view, nodes: [] })));
      expectClean('ListPaneView (error)', html(createElement(ListPaneView, { ...view, nodes: null, error: new ApiError('unauthorized', 401) })));
      const searchRow: MessageMatchRow = {
        workspace,
        session: session('running', { title: 'Fix the build', workspaceId: 'w1' }),
        label: 'Fix the build',
        snippet: 'the parser reads the file first',
        matchedAt: NOW - 60_000,
      };
      expectClean(
        'ListPaneView (searching)',
        html(createElement(ListPaneView, { ...view, query: 'build', messageState: { status: 'ready', results: [] }, messageRows: [searchRow] })),
      );
      expectClean('ListPaneView (no match)', html(createElement(ListPaneView, { ...view, query: 'banana', messageState: { status: 'idle' } })));

      const empty = { status: 'online' as const, nodes, onOpenWorkspaces: noop, onAddWorkspace: noop, onRepair: noop };
      expectClean('EmptyDetail', html(createElement(EmptyDetail, empty)));
      expectClean('EmptyDetail (no workspaces)', html(createElement(EmptyDetail, { ...empty, nodes: [] })));
      expectClean('EmptyDetail (unauthorized)', html(createElement(EmptyDetail, { ...empty, status: 'unauthorized' as const })));
    });

    it('the pairing code body', () => {
      const code = { code: '123456', expiresAt: NOW + 240_000 };
      expectClean('PairingCodeBody', html(createElement(PairingCodeBody, { code, loading: false, failed: false, now: NOW })));
      expectClean('PairingCodeBody (expiring)', html(createElement(PairingCodeBody, { code, loading: false, failed: false, now: NOW + 239_000 })));
      expectClean('PairingCodeBody (expired)', html(createElement(PairingCodeBody, { code, loading: false, failed: false, now: NOW + 300_000 })));
      expectClean('PairingCodeBody (loading)', html(createElement(PairingCodeBody, { code: null, loading: true, failed: false, now: NOW })));
      expectClean('PairingCodeBody (failed)', html(createElement(PairingCodeBody, { code: null, loading: false, failed: true, now: NOW })));
    });
  });
}
