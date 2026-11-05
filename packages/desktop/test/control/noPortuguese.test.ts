import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { AgentAccountsInfo, ControlError, ControlSection, DeviceInfo, DriveInfo, FoldersState, LogsInfo } from '../../src/common/control-api.js';
import { dictionaries, LANGUAGES, type Language } from '../../src/common/i18n/index.js';
import type { DaemonStatus, TailscaleStatus, UpdateCheckResult } from '../../src/common/types.js';
import { MissingBridge } from '../../src/control/MissingBridge.js';
import { errorMessage, toControlError } from '../../src/control/lib/errors.js';
import { formatBytes, formatDate, formatDateTime, formatRelative } from '../../src/control/lib/format.js';
import { buildDraftEntries, changeSummary, driveKindLabel } from '../../src/control/lib/roots.js';
import { restartedMessage, savedMessage } from '../../src/control/lib/save.js';
import { AccountsView } from '../../src/control/sections/AccountsSection.js';
import { DevicesTable, PairingView, sortDevices } from '../../src/control/sections/DevicesSection.js';
import { DriveTile, FolderRow, FoldersView, SaveBar } from '../../src/control/sections/FoldersSection.js';
import { LogsView, type LogTab } from '../../src/control/sections/LogsSection.js';
import { OverviewView } from '../../src/control/sections/OverviewSection.js';
import { Page } from '../../src/control/sections/Page.js';
import { RestartDialog } from '../../src/control/sections/RestartDialog.js';
import { SessionsStage, SessionsUnavailable } from '../../src/control/sections/SessionsSection.js';
import { SettingsView } from '../../src/control/sections/SettingsSection.js';
import { TailscaleView } from '../../src/control/sections/TailscaleSection.js';
import { Sidebar } from '../../src/control/shell/Sidebar.js';
import { TitleBarView } from '../../src/control/shell/TitleBar.js';
import { ErrorState, GroupSkeleton } from '../../src/control/ui/States.js';
import { ToastProvider } from '../../src/control/ui/Toast.js';
import { html } from './render-helpers.js';
import { controlT } from './translator.js';

/**
 * Nothing in Portuguese may reach the English or the Spanish control center. Every view is rendered in both languages with
 * realistic data, and the text that comes out (visible text, labels, titles) must hold no text of the pt-BR dictionary, no
 * letter that Portuguese alone uses and none of its common words. The dictionaries are scanned key by key as well, for the
 * texts no view shows (a toast, a failed pairing). The scan has to be able to fail: the same views in Portuguese go through it
 * too, and it must find them out.
 */

const noop = (): void => undefined;
const TRANSLATED = ['en', 'es'] as const satisfies readonly Language[];
type Translated = (typeof TRANSLATED)[number];

/* ------------------------------------------------------------------- scanner */

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' };
const decode = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity);

/** The names of the three languages are always written in their own language: they are not part of what is checked. */
const OWN_LANGUAGE_NAMES: readonly string[] = LANGUAGES.map((language) => language.label);

/** What a person reads or hears: the text between tags, and the attributes that carry words (labels, titles, placeholders). */
function visibleText(markup: string): string {
  const attributes = [...markup.matchAll(/\s(?:aria-label|aria-description|aria-valuetext|title|placeholder|alt)="([^"]*)"/g)].map((match) => match[1] ?? '');
  const text = markup.replace(/<!--.*?-->/gs, '').replace(/<[^>]*>/g, '\n');
  let out = decode([text, ...attributes].join('\n'));
  for (const name of OWN_LANGUAGE_NAMES) out = out.split(name).join('');
  return out;
}

function flatten(node: unknown, prefix = ''): Map<string, string> {
  const leaves = new Map<string, string>();
  if (typeof node === 'string') return leaves.set(prefix, node);
  if (typeof node !== 'object' || node === null) return leaves;
  for (const [key, value] of Object.entries(node)) {
    for (const [path, text] of flatten(value, prefix === '' ? key : `${prefix}.${key}`)) leaves.set(path, text);
  }
  return leaves;
}

const PLACEHOLDER = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/g;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOT_A_LETTER_BEFORE = '(?<![\\p{L}\\p{M}])';
const NOT_A_LETTER_AFTER = '(?![\\p{L}\\p{M}])';

/** The pt-BR text of a key as a pattern: `{{placeholders}}` match anything on the line, and a whole word is not found inside another. */
function patternOf(value: string): RegExp {
  const body = value.split(PLACEHOLDER).map(escapeRegExp).join('[^\\n]*?');
  return new RegExp(`${NOT_A_LETTER_BEFORE}${body}${NOT_A_LETTER_AFTER}`, 'u');
}

/** A text needs four characters of its own (not counting placeholders) to be told apart from another language. */
const literalLength = (value: string): number => value.replace(PLACEHOLDER, '').trim().length;

const PT_BR = flatten(dictionaries['pt-BR'].control);
const OWN: Record<Translated, Map<string, string>> = { en: flatten(dictionaries.en.control), es: flatten(dictionaries.es.control) };

/** Words that no English or Spanish text of the interface uses (Spanish is in the tú form: "Abre", not "Abra"). */
const PORTUGUESE_ONLY = [
  'Salvar', 'Fechar', 'Tentar', 'de novo', 'novo', 'nova', 'novos', 'novas', 'pasta', 'pastas', 'aparelho', 'aparelhos', 'sessão', 'sessões', 'não',
  'você', 'vocês', 'uma', 'Erro', 'Atualizar', 'Atualizações', 'Carregando', 'Gerar', 'Expirou', 'Revogar', 'Revogado', 'Ativo', 'Criado', 'Nome', 'Ações',
  'Pareado', 'pareados', 'pareamento', 'Visão', 'Desligado', 'Baixar', 'Adicionar', 'Geral', 'Dados', 'Serviços', 'Atividade', 'Conexão', 'Endereço',
  'Endereços', 'Instale', 'Abra', 'Digite', 'Toque', 'Escolha', 'Veja', 'Aguardando', 'Indisponível', 'Somente', 'leitura', 'Nenhum', 'Nenhuma',
  'Enquanto', 'quando', 'então', 'já', 'ainda', 'também', 'seu', 'sua', 'seus', 'suas', 'Rolagem', 'Mensagem', 'Contas', 'Conta',
] as const;

/**
 * Portuguese words that are ordinary Spanish too (Cancelar, Abrir, Copiar, Iniciar...): a Spanish text may use them, so they
 * are only forbidden in English. This is the allowlist of the Spanish scan, and the reason is in the name.
 */
const ALSO_SPANISH = [
  'Cancelar', 'Abrir', 'Copiar', 'Copiado', 'Descartar', 'Expira', 'Iniciar', 'Iniciando', 'Reiniciar', 'Ajustes', 'disco', 'discos', 'para', 'Mostrar',
  'Verificar', 'Remover', 'Ligar', 'Parear', 'Esperando', 'Conectado', 'Conectada', 'Nunca', 'Idioma', 'Principal',
] as const;

const FORBIDDEN_WORDS: Record<Translated, readonly string[]> = { en: [...PORTUGUESE_ONLY, ...ALSO_SPANISH], es: PORTUGUESE_ONLY };

const wordPattern = (word: string): RegExp => new RegExp(`${NOT_A_LETTER_BEFORE}${escapeRegExp(word)}${NOT_A_LETTER_AFTER}`, 'iu');

/** What the text of a view or of a dictionary shows of Portuguese in `language`: its letters and its words. */
function portugueseLettersAndWords(language: Translated, text: string): string[] {
  const problems: string[] = [];
  // English has no accented letter at all; Spanish has its own (á é í ó ú ñ ü) but not the Portuguese ones.
  if (language === 'en') {
    const accented = text.normalize('NFD').match(/\p{L}\p{M}+/gu);
    if (accented) problems.push(`accented letters in English text: ${[...new Set(accented.map((letter) => letter.normalize('NFC')))].join(' ')}`);
  } else {
    const portugueseLetters = text.match(/[ãõçâêôÃÕÇÂÊÔ]/g);
    if (portugueseLetters) problems.push(`Portuguese-only letters in Spanish text: ${[...new Set(portugueseLetters)].join(' ')}`);
  }
  for (const word of FORBIDDEN_WORDS[language]) {
    if (wordPattern(word).test(text)) problems.push(`Portuguese word: ${word}`);
  }
  return problems;
}

/** A text of the pt-BR dictionary that is shown where the text of the same key in `language` should be. */
function portugueseTexts(language: Translated, text: string): string[] {
  const problems: string[] = [];
  for (const [key, value] of PT_BR) {
    if (literalLength(value) < 4 || OWN[language].get(key) === value) continue;
    if (patternOf(value).test(text)) problems.push(`pt-BR text of ${key}: ${value}`);
  }
  return problems;
}

/** Every problem the text of a view has in `language`. Empty: nothing of Portuguese is left. */
const portugueseIn = (language: Translated, text: string): string[] => [...portugueseTexts(language, text), ...portugueseLettersAndWords(language, text)];

/* ----------------------------------------------------------------- fixtures */

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const daemon = (extra: Partial<DaemonStatus> = {}): DaemonStatus => ({
  state: 'running',
  port: 7780,
  mode: 'spawned',
  pid: 4242,
  version: '0.1.0',
  machineName: 'OFFICE-PC',
  restricted: false,
  message: null,
  logTail: [],
  ...extra,
});

const overviewInfo = (
  daemonExtra: Partial<DaemonStatus> = {},
  tailscale: TailscaleStatus = { state: 'off' },
  activity: { workspaces: number; sessions: number; busySessions: number; devices: number } | null = { workspaces: 4, sessions: 12, busySessions: 2, devices: 3 },
) => ({ daemon: daemon(daemonExtra), tailscale, activity, dataFolder: 'C:\\Users\\user\\.nanachi-desktop', appVersion: '0.1.0' });

const overview = (language: Language, info: ReturnType<typeof overviewInfo>): string =>
  html(createElement(OverviewView, { info, restarting: false, tailscaleBusy: false, onRestart: noop, onStartTailscale: noop, onTailscaleLogin: noop, onNavigate: noop, onOpenDataFolder: noop }), language);

const drive = (extra: Partial<DriveInfo> = {}): DriveInfo => ({ root: 'D:\\', label: 'Data', kind: 'fixed', totalBytes: 1000 * 1024 ** 3, freeBytes: 400 * 1024 ** 3, ...extra });
const savedRoots = [
  { path: 'C:\\Projects', exists: true, coveredBy: null },
  { path: 'E:\\Old', exists: false, coveredBy: null },
];
const rows = buildDraftEntries(savedRoots, ['C:\\Projects', 'E:\\Old', 'C:\\Projects\\blog']);
const foldersState = (extra: Partial<FoldersState> = {}): FoldersState => ({
  roots: savedRoots,
  rootsUnknown: false,
  drives: [drive(), drive({ root: 'C:\\', label: 'Windows', totalBytes: 476 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 })],
  editable: true,
  restartPending: false,
  busySessions: 0,
  ...extra,
});
const foldersBase = {
  entries: rows,
  paths: rows.map((row) => row.path),
  changes: { added: [], removed: [], dirty: false },
  saving: false,
  restarting: false,
  onPick: noop,
  onRemove: noop,
  onToggleDrive: noop,
  onReveal: noop,
  onDiscard: noop,
  onSave: noop,
  onRestartNow: noop,
};

const devices: DeviceInfo[] = [
  { id: 'old', name: 'Old iPad', createdAt: NOW - 90 * DAY, lastSeenAt: NOW - 12 * DAY, revoked: true, isThisApp: false },
  { id: 'self', name: 'Nanachi Desktop (PC)', createdAt: NOW - DAY, lastSeenAt: NOW - 5_000, revoked: false, isThisApp: true },
  { id: 'phone', name: 'Ana iPhone', createdAt: NOW - 20 * DAY, lastSeenAt: NOW - 3 * 60_000, revoked: false, isThisApp: false },
  { id: 'never', name: 'Browser', createdAt: NOW - 3 * DAY, lastSeenAt: null, revoked: false, isThisApp: false },
];

const agents: AgentAccountsInfo[] = [
  {
    agentId: 'claude',
    agentName: 'Claude Code',
    multiAccount: true,
    accounts: [
      { id: 'default', name: 'Default', principal: true, active: true, status: 'logged_in', identity: 'me@example.com' },
      { id: 'work', name: 'Work', principal: false, active: false, status: 'logged_in', identity: 'work@example.com' },
      { id: 'old', name: 'Old', principal: false, active: false, status: 'logged_out', identity: null },
      { id: 'spare', name: 'Spare', principal: false, active: false, status: 'unknown', identity: null },
    ],
  },
  { agentId: 'omp', agentName: 'Oh My Pi', multiAccount: false, accounts: [{ id: 'default', name: 'Default', principal: true, active: true, status: 'logged_in', identity: null }] },
];

const settings = (language: Language, extra: Partial<Parameters<typeof SettingsView>[0]> = {}): string =>
  html(
    createElement(SettingsView, {
      language,
      onLanguage: noop,
      languageBusy: false,
      version: '0.1.0',
      dataFolder: 'C:\\Users\\user\\.nanachi-desktop',
      autostart: { value: true, supported: true },
      autostartBusy: false,
      onAutostart: noop,
      update: null,
      checking: false,
      onCheckUpdate: noop,
      onDownload: noop,
      onOpenDataFolder: noop,
      uninstalling: false,
      onUninstall: noop,
      ...extra,
    }),
    language,
  );

const available: UpdateCheckResult = { status: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v0.2.0' };

const TAILSCALE_STATES: TailscaleStatus[] = [
  { state: 'off' },
  { state: 'starting' },
  { state: 'needs_login', authUrl: 'https://login.tailscale.com/a/x' },
  { state: 'running', dnsName: 'pc.tail1.ts.net', tailnet: 'user@example.com', ips: ['100.64.0.1', 'fd7a::1'] },
  { state: 'running', dnsName: 'pc.tail1.ts.net', tailnet: 'user@example.com', ips: [] },
  { state: 'error', message: 'no network' },
];

const ERROR_CODES: ControlError['code'][] = ['daemon_unavailable', 'not_paired', 'unauthorized', 'invalid_input', 'io', 'not_own_daemon', 'unknown'];

const LOG_CASES: Array<{ tab: LogTab; following: boolean; logs: LogsInfo }> = [
  { tab: 'daemon', following: true, logs: { daemon: ['[daemon] ready', 'ERROR something failed'], tailscale: [] } },
  { tab: 'daemon', following: false, logs: { daemon: [], tailscale: [] } },
  { tab: 'tailscale', following: true, logs: { daemon: ['[daemon] ready'], tailscale: [] } },
  { tab: 'tailscale', following: true, logs: { daemon: [], tailscale: ['[tsnet] up'] } },
];

type Views = ReadonlyArray<readonly [name: string, render: (language: Language) => string]>;

const VIEWS: Views = [
  [
    'title bar',
    (language) =>
      (['running', 'attached', 'starting', 'stopped', 'error'] as const)
        .map((state) =>
          html(
            createElement(TitleBarView, { machineName: 'OFFICE-PC', daemon: daemon({ state }), windowState: { maximized: state === 'attached', focused: true }, nativeTips: state === 'attached', onMinimize: noop, onToggleMaximize: noop, onClose: noop, onOpenStatus: noop }),
            language,
          ),
        )
        .join('\n'),
  ],
  [
    'sidebar',
    (language) =>
      [
        { collapsed: false, sessionsOpen: false },
        { collapsed: true, sessionsOpen: false },
        { collapsed: false, sessionsOpen: true },
      ]
        .map(({ collapsed, sessionsOpen }) => html(createElement(Sidebar, { section: sessionsOpen ? 'sessions' : 'folders', collapsed, dirty: new Set<ControlSection>(['folders']), version: '0.1.0', onSelect: noop, onToggle: noop, sessionsOpen }), language))
        .join('\n'),
  ],
  [
    'every page heading and the toast region',
    (language) =>
      [
        ...(['overview', 'folders', 'devices', 'accounts', 'tailscale', 'logs', 'settings', 'sessions'] as const).map((section) => html(createElement(Page, { section, children: null }), language)),
        html(createElement(ToastProvider, null, createElement('div')), language),
      ].join('\n'),
  ],
  [
    'overview',
    (language) =>
      [
        overviewInfo(),
        overviewInfo({ state: 'attached', mode: 'attached', pid: null }, { state: 'needs_login', authUrl: 'https://login.tailscale.com/a/x' }, null),
        overviewInfo({ state: 'error', mode: 'none', pid: null, logTail: ['[daemon] port busy'] }, { state: 'error', message: 'no network' }),
        overviewInfo({ state: 'stopped', mode: 'none', pid: null }, { state: 'running', dnsName: 'pc.tail1.ts.net', tailnet: 't', ips: ['100.1.1.1'] }),
        overviewInfo({ restricted: true }, { state: 'starting' }, { workspaces: 1, sessions: 0, busySessions: 0, devices: 0 }),
        overviewInfo({ state: 'starting', pid: null }),
      ]
        .map((info) => overview(language, info))
        .join('\n'),
  ],
  [
    'drive tiles and folder rows',
    (language) =>
      [
        ...(['fixed', 'removable', 'network', 'optical', 'unknown'] as const).map((kind) => html(createElement(DriveTile, { drive: drive({ kind }), paths: ['d:\\', 'D:\\Work'], editable: true, onToggle: noop }), language)),
        html(createElement(DriveTile, { drive: drive(), paths: ['D:\\Work', 'D:\\More'], editable: true, onToggle: noop }), language),
        html(createElement(DriveTile, { drive: drive({ totalBytes: null, freeBytes: null }), paths: [], editable: false, onToggle: noop }), language),
        ...rows.map((entry) => html(createElement(FolderRow, { entry, editable: true, onReveal: noop, onRemove: noop }), language)),
        ...rows.slice(0, 1).map((entry) => html(createElement(FolderRow, { entry, editable: false, onReveal: noop, onRemove: noop }), language)),
      ].join('\n'),
  ],
  [
    'folders view and save bar',
    (language) =>
      [
        html(createElement(FoldersView, { ...foldersBase, state: foldersState() }), language),
        html(createElement(FoldersView, { ...foldersBase, entries: [], paths: [], state: foldersState({ roots: [] }) }), language),
        html(createElement(FoldersView, { ...foldersBase, state: foldersState({ editable: false, busySessions: 2 }) }), language),
        html(createElement(FoldersView, { ...foldersBase, entries: [], paths: [], state: foldersState({ editable: false, rootsUnknown: true, roots: [] }) }), language),
        html(createElement(FoldersView, { ...foldersBase, state: foldersState({ restartPending: true, drives: [] }) }), language),
        html(createElement(FoldersView, { ...foldersBase, state: foldersState(), changes: { added: ['x'], removed: ['z', 'y'], dirty: true } }), language),
        html(createElement(SaveBar, { changes: { added: ['x', 'y'], removed: ['z'], dirty: true }, saving: false, busySessions: 0, onDiscard: noop, onSave: noop }), language),
        html(createElement(SaveBar, { changes: { added: [], removed: ['z', 'y'], dirty: true }, saving: true, busySessions: 3, onDiscard: noop, onSave: noop }), language),
      ].join('\n'),
  ],
  [
    'restart dialog',
    (language) =>
      ([
        ['save', 2],
        ['save', 1],
        ['restart', 1],
        ['restart', 0],
      ] as const)
        .map(([mode, busySessions]) => html(createElement(RestartDialog, { open: true, mode, busySessions, busy: false, onCancel: noop, onLater: noop, onNow: noop }), language))
        .join('\n'),
  ],
  [
    'devices: table and pairing',
    (language) =>
      [
        html(createElement(DevicesTable, { devices: sortDevices(devices), now: NOW, onRevoke: noop }), language),
        html(createElement(PairingView, { code: '482915', remainingMs: 272_000, fraction: 0.9, regenerating: false, onRegenerate: noop, onClose: noop }), language),
        html(createElement(PairingView, { code: '482915', remainingMs: 0, fraction: 0, regenerating: true, onRegenerate: noop, onClose: noop }), language),
      ].join('\n'),
  ],
  [
    'accounts',
    (language) =>
      [
        html(createElement(AccountsView, { agents, settingActive: null, onSetActive: noop, onOpenSessions: noop }), language),
        html(createElement(AccountsView, { agents: [], settingActive: null, onSetActive: noop, onOpenSessions: noop }), language),
      ].join('\n'),
  ],
  [
    'tailscale in every state',
    (language) => TAILSCALE_STATES.map((status) => html(createElement(TailscaleView, { status, busy: false, onToggle: noop, onLogin: noop, onRetry: noop }), language)).join('\n'),
  ],
  [
    'logs',
    (language) =>
      LOG_CASES.map(({ tab, following, logs }) =>
        html(createElement(LogsView, { logs, tab, onTab: noop, following, onFollowChange: noop, resumeToken: 0, onResume: noop, onCopy: noop, onOpenFolder: noop }), language),
      ).join('\n'),
  ],
  [
    'settings',
    (language) =>
      [
        settings(language),
        settings(language, { autostart: { value: false, supported: false }, update: { status: 'up-to-date', current: '0.1.0' }, uninstalling: true }),
        settings(language, { update: available, languageBusy: true, dataFolder: null }),
        settings(language, { update: { status: 'error', current: '0.1.0', message: 'No connection.' }, autostart: null, checking: true }),
      ].join('\n'),
  ],
  [
    'error and loading states',
    (language) =>
      [
        ...ERROR_CODES.map((code) => html(createElement(ErrorState, { error: { ok: false, code, message: 'The daemon did not answer.' }, onRetry: noop }), language)),
        html(createElement(ErrorState, { error: toControlError(new Error('boom')), onRetry: noop }), language),
        html(createElement(GroupSkeleton, { rows: 2 }), language),
      ].join('\n'),
  ],
  [
    'sessions: stage and every unavailable state',
    (language) =>
      [
        html(createElement(SessionsStage), language),
        ...[
          null,
          daemon({ state: 'starting', pid: null }),
          daemon({ state: 'stopped', mode: 'none', pid: null }),
          daemon({ state: 'error', mode: 'none', pid: null, logTail: ['[daemon] port busy'] }),
          daemon({ state: 'running', restricted: true }),
          daemon({ state: 'error', mode: 'none', message: 'Port 7780 is in use.' }),
        ].map((status) => html(createElement(SessionsUnavailable, { daemon: status, onOpenOverview: noop }), language)),
        html(createElement(SessionsUnavailable, { daemon: daemon({ state: 'running' }), viewState: 'crashed', onOpenOverview: noop }), language),
      ].join('\n'),
  ],
  ['missing bridge', (language) => html(createElement(MissingBridge), language)],
  [
    'the texts of the toasts and of the formatting helpers',
    (language) => {
      const t = controlT(language);
      const messages = [
        ...(['restarted', 'starting', 'restart_failed', 'pending'] as const).map((applied) => savedMessage(applied, t)),
        restartedMessage(daemon(), t),
        restartedMessage(daemon({ state: 'starting' }), t),
      ].flatMap((toast) => [toast.title ?? '', toast.message]);
      const when = [NOW - 5_000, NOW - 60_000, NOW - 3 * 3_600_000, NOW - 26 * 3_600_000, NOW - 3 * DAY, NOW - 40 * DAY, null].map((ms) => formatRelative(ms, NOW, t));
      return [
        ...messages,
        ...when,
        formatDate(NOW, t),
        formatDateTime(NOW, t),
        formatBytes(12.3 * 1024 ** 3, language),
        errorMessage(toControlError(new Error('boom')), t),
        changeSummary({ added: ['a'], removed: [], dirty: true }, t),
        changeSummary({ added: [], removed: ['a', 'b'], dirty: true }, t),
        changeSummary({ added: ['a', 'b'], removed: ['c'], dirty: true }, t),
        ...(['fixed', 'removable', 'network', 'optical', 'unknown'] as const).map((kind) => driveKindLabel(kind, t)),
      ].join('\n');
    },
  ],
];

/**
 * Keys whose text is the same word in Portuguese and in that language, and why. Everything else must be translated: a key
 * that is still the pt-BR text is a copy that nobody translated.
 */
const IDENTICAL_TO_PORTUGUESE: Record<Translated, Readonly<Record<string, string>>> = {
  en: {
    'sections.tailscale.label': 'the product name',
    'sections.logs.label': 'Logs: the word of the glossary, the same in English',
    'devices.table.status': 'Status: the same word in English',
  },
  es: {
    'sections.tailscale.label': 'the product name',
    'sections.settings.label': 'Ajustes: the glossary word, the same in Spanish',
    'shell.titleBar.minimize': 'Minimizar: ordinary Spanish',
    'shell.titleBar.maximize': 'Maximizar: ordinary Spanish',
    'shell.titleBar.restore': 'Restaurar: ordinary Spanish',
    'status.daemon.attached.word': 'Conectado: ordinary Spanish',
    'status.daemon.starting.word': 'Iniciando: ordinary Spanish',
    'status.tailscale.starting.word': 'Iniciando: ordinary Spanish',
    'common.cancel': 'Cancelar: ordinary Spanish',
    'common.copied': 'Copiado: ordinary Spanish',
    'overview.start': 'Iniciar: ordinary Spanish',
    'overview.restart': 'Reiniciar: ordinary Spanish',
    'folders.drivesHeading': 'Discos: ordinary Spanish',
    'folders.drive.kind.fixed': 'Disco local: ordinary Spanish',
    'folders.drive.kind.optical': 'Óptico: ordinary Spanish',
    'folders.drive.kind.unknown': 'Disco: ordinary Spanish',
    'folders.drive.label': 'Disco {{letter}}: ordinary Spanish',
    'folders.drive.usedOf': 'usados de: ordinary Spanish',
    'folders.row.inside': 'Dentro de: ordinary Spanish',
    'folders.saveBar.discard': 'Descartar: ordinary Spanish',
    'devices.pairing.codeLabel': 'Código: ordinary Spanish',
    'devices.pairing.copy': 'Copiar código: ordinary Spanish',
    'devices.table.lastSeen': 'Último uso: ordinary Spanish',
    'accounts.main': 'Principal: ordinary Spanish',
    'accounts.status.loggedIn': 'Conectada: ordinary Spanish',
    'format.relative.never': 'Nunca: ordinary Spanish',
    'logs.copy': 'Copiar: ordinary Spanish',
    'settings.languageTitle': 'Idioma: ordinary Spanish',
    'settings.uninstall': 'Desinstalar…: ordinary Spanish',
  },
};

/* -------------------------------------------------------------------- tests */

describe.each(TRANSLATED)('no Portuguese in the %s control center', (language) => {
  it.each(VIEWS)('%s', (_name, render) => {
    const text = visibleText(render(language));
    // A view that rendered nothing would pass for the wrong reason.
    expect(text.trim().length).toBeGreaterThan(0);
    expect(portugueseIn(language, text)).toEqual([]);
  });

  it('the dictionary, key by key, is free of Portuguese too (what no view shows is scanned as well)', () => {
    const problems: string[] = [];
    for (const [key, text] of OWN[language]) {
      const found = portugueseLettersAndWords(language, text);
      if (found.length > 0) problems.push(`${key}: ${found.join('; ')}`);
      const model = PT_BR.get(key);
      if (model === text && literalLength(text) >= 4 && IDENTICAL_TO_PORTUGUESE[language][key] === undefined) problems.push(`${key} is still the pt-BR text: ${text}`);
    }
    expect(problems).toEqual([]);
  });

  it('every key allowed to be identical to Portuguese really is, so the allowlist never outlives its reason', () => {
    for (const key of Object.keys(IDENTICAL_TO_PORTUGUESE[language])) expect(OWN[language].get(key), key).toBe(PT_BR.get(key));
  });
});

describe('the scan can fail', () => {
  it.each(TRANSLATED)('every view in Portuguese is found out when it is read as %s', (language) => {
    for (const [name, render] of VIEWS) expect(portugueseIn(language, visibleText(render('pt-BR'))).length, name).toBeGreaterThan(0);
  });

  it('a single leftover pt-BR sentence in an English view is reported by key', () => {
    const text = `${visibleText(overview('en', overviewInfo()))}\nAbrir pasta`;
    expect(portugueseIn('en', text)).toContain('pt-BR text of common.openFolder: Abrir pasta');
  });

  it('English text with an accent, and Spanish text with a ã or a ç, are reported; Spanish accents are not', () => {
    expect(portugueseLettersAndWords('en', 'Café')).toEqual(['accented letters in English text: é']);
    expect(portugueseLettersAndWords('es', 'Navegação')).toEqual(['Portuguese-only letters in Spanish text: ç ã']);
    expect(portugueseLettersAndWords('es', 'Abre la carpeta del año, ¿qué tal? ¡Listo!')).toEqual([]);
  });

  it('Spanish may use the words it shares with Portuguese; English may not', () => {
    expect(portugueseLettersAndWords('es', 'Cancelar')).toEqual([]);
    expect(portugueseLettersAndWords('en', 'Cancelar')).toEqual(['Portuguese word: Cancelar']);
    expect(portugueseLettersAndWords('es', 'Salvar los cambios')).toEqual(['Portuguese word: Salvar']);
  });
});
