/**
 * An in-memory `ControlApi` for tests and for the screenshot/development build (`NANACHI_CONTROL_MOCK=1`, `?mock=1`).
 * It is never part of a shipped bundle: `main.tsx` reaches it only through a dead `__CONTROL_MOCK__` branch.
 *
 * The data is synthetic (generic names, paths and a made-up tailnet). Behaviour follows the contract in
 * `common/control-api.ts`: edits go through `save`, a restart goes through the daemon status events, and a
 * `ControlError` is a normal return value.
 */
import type {
  AgentAccountsInfo,
  ControlApi,
  ControlError,
  ControlResult,
  ControlSection,
  DeviceInfo,
  DriveInfo,
  FoldersState,
  LogsInfo,
  OverviewInfo,
  RootEntry,
  SaveRootsResult,
  SessionsViewState,
  SessionsViewport,
  WindowState,
} from '../../common/control-api.js';
import type { Language } from '../../common/i18n/index.js';
import type { DaemonStatus, PairingCode, TailscaleStatus, UpdateCheckResult } from '../../common/types.js';
import { MOCK_MESSAGES, type MockMessages } from './messages.js';

export type MockScenario = 'default' | 'empty' | 'readonly' | 'busy' | 'pending' | 'down' | 'attached' | 'login' | 'update';

export interface MockOptions {
  scenario?: MockScenario;
  /** Milliseconds every call takes (default 120); 0 answers on the next microtask, for tests. */
  latencyMs?: number;
  /** The clock, for tests. */
  now?: () => number;
  /** What the native folder picker returns. */
  picked?: string[];
  /** Desktop's language when the page starts (default pt-BR). The mock's error messages follow it, as main's do. */
  language?: Language;
}

export interface MockControl extends ControlApi {
  /** Test hooks, not part of the contract. */
  mock: {
    setDaemon: (status: DaemonStatus) => void;
    setTailscale: (status: TailscaleStatus) => void;
    setPicked: (paths: string[]) => void;
    /** What main would do when the tray asks for a section. */
    navigate: (section: ControlSection) => void;
    /** What main would do when the sessions view gives up or comes back. */
    setSessionsView: (state: SessionsViewState) => void;
    /** Every report of the sessions area, in order. */
    viewports: SessionsViewport[];
    calls: string[];
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

const DATA_FOLDER = 'C:\\Users\\user\\.nanachi-desktop';
const PORT = 7780;

function error(code: ControlError['code'], message: string): ControlError {
  return { ok: false, code, message };
}
function ok<T>(value: T): ControlResult<T> {
  return { ok: true, value };
}

function normalize(path: string): string {
  const cleaned = path.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  return /^[a-z]:$/i.test(cleaned) ? `${cleaned}\\` : cleaned;
}

export function createMockControlApi(options: MockOptions = {}): MockControl {
  const scenario = options.scenario ?? 'default';
  const latency = options.latencyMs ?? 120;
  const clock = options.now ?? (() => Date.now());
  const calls: string[] = [];
  const viewports: SessionsViewport[] = [];
  let language: Language = options.language ?? 'pt-BR';
  const languageListeners = new Set<(next: Language) => void>();
  const navigateListeners = new Set<(section: ControlSection) => void>();
  const sessionsViewListeners = new Set<(state: SessionsViewState) => void>();
  let picked = options.picked ?? ['C:\\Projetos\\blog', 'D:\\Clientes'];
  // Read at the moment of each answer, so a language change in the middle of a session is followed (as main does).
  const text = (): MockMessages => MOCK_MESSAGES[language];

  const delay = (): Promise<void> => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const track = (name: string): void => {
    calls.push(name);
  };
  // Attached to a daemon Desktop did not start: it does not know this app, so devices and accounts answer these.
  const attached = scenario === 'attached';
  const unknownApp = (): ControlError => error('not_paired', text().notPaired);
  const down = (): ControlError => error('daemon_unavailable', text().unreachable(PORT));

  let autostart = { value: true, supported: true };

  /* ---------------------------------------------------------------- window */
  let windowState: WindowState = { maximized: false, focused: true };
  const windowListeners = new Set<(state: WindowState) => void>();
  const emitWindow = (): void => windowListeners.forEach((listener) => listener(windowState));

  /* ---------------------------------------------------------------- daemon */
  let daemon: DaemonStatus = {
    state: scenario === 'down' ? 'error' : scenario === 'attached' ? 'attached' : 'running',
    port: PORT,
    mode: scenario === 'attached' ? 'attached' : scenario === 'down' ? 'none' : 'spawned',
    pid: scenario === 'attached' || scenario === 'down' ? null : 14232,
    version: '0.1.0',
    machineName: 'OFFICE-PC',
    restricted: false,
    message: scenario === 'down' ? text().portBusy(PORT) : null,
    // Log lines are what the process wrote, not texts of the interface: they are never translated.
    logTail: scenario === 'down' ? ['[desktop] porta 7780 ocupada', '[desktop] nova tentativa em 15 s'] : [],
  };
  const daemonListeners = new Set<(status: DaemonStatus) => void>();
  const setDaemon = (status: DaemonStatus): void => {
    daemon = status;
    daemonListeners.forEach((listener) => listener(status));
  };

  /* ------------------------------------------------------------- tailscale */
  let tailscale: TailscaleStatus = { state: 'off' };
  const tailscaleListeners = new Set<(status: TailscaleStatus) => void>();
  const setTailscale = (status: TailscaleStatus): void => {
    tailscale = status;
    tailscaleListeners.forEach((listener) => listener(status));
  };

  /* --------------------------------------------------------------- folders */
  const drives: DriveInfo[] = [
    { root: 'C:\\', label: 'Windows', kind: 'fixed', totalBytes: 476 * GB, freeBytes: 118 * GB },
    { root: 'D:\\', label: 'Dados', kind: 'fixed', totalBytes: 1.82 * 1024 * GB, freeBytes: 912 * GB },
    { root: 'E:\\', label: 'PENDRIVE', kind: 'removable', totalBytes: 29.8 * GB, freeBytes: 3.2 * GB },
    { root: 'Z:\\', label: 'Servidor', kind: 'network', totalBytes: 931 * GB, freeBytes: 112 * GB },
  ];
  let saved: Array<{ path: string; exists: boolean }> =
    scenario === 'empty'
      ? []
      : [
          { path: 'C:\\Projetos', exists: true },
          { path: 'C:\\Projetos\\nanachi-remote', exists: true },
          { path: 'D:\\Trabalho', exists: true },
          { path: 'E:\\Antigos', exists: false },
        ];
  let applied = saved.map((entry) => entry.path.toLowerCase()).join('|');
  if (scenario === 'pending') applied = 'C:\\Projetos'.toLowerCase();
  const editable = scenario !== 'readonly' && scenario !== 'attached';
  const busySessions = scenario === 'busy' ? 2 : 0;

  const foldersState = (): FoldersState => {
    const roots: RootEntry[] = saved.map((entry) => {
      const key = entry.path.toLowerCase();
      const parent = saved.find((other) => other !== entry && key.startsWith(`${other.path.toLowerCase().replace(/\\$/, '')}\\`));
      return { path: entry.path, exists: entry.exists, coveredBy: parent?.path ?? null };
    });
    // A daemon Desktop did not start has its own list, which this app cannot read: unknown and empty, never Desktop's own.
    return {
      roots: attached ? [] : roots,
      rootsUnknown: attached,
      drives,
      editable,
      restartPending: !attached && saved.map((entry) => entry.path.toLowerCase()).join('|') !== applied,
      busySessions,
    };
  };

  /* --------------------------------------------------------------- devices */
  let devices: DeviceInfo[] = [
    { id: 'dev-1', name: 'iPhone da Ana', createdAt: clock() - 21 * DAY, lastSeenAt: clock() - 3 * MINUTE, revoked: false, isThisApp: false },
    { id: 'dev-2', name: 'Nanachi Desktop (OFFICE-PC)', createdAt: clock() - 2 * DAY, lastSeenAt: clock() - 20_000, revoked: false, isThisApp: true },
    { id: 'dev-3', name: 'Navegador do notebook', createdAt: clock() - 40 * DAY, lastSeenAt: clock() - 26 * HOUR, revoked: false, isThisApp: false },
    { id: 'dev-4', name: 'iPad antigo', createdAt: clock() - 90 * DAY, lastSeenAt: clock() - 12 * DAY, revoked: true, isThisApp: false },
  ];
  if (scenario === 'empty') devices = [];

  /* -------------------------------------------------------------- accounts */
  let accounts: AgentAccountsInfo[] = [
    {
      agentId: 'claude',
      agentName: 'Claude Code',
      multiAccount: true,
      accounts: [
        { id: 'default', name: 'Principal', principal: true, active: true, status: 'logged_in', identity: 'user@example.com' },
        { id: 'work', name: 'Trabalho', principal: false, active: false, status: 'logged_in', identity: 'work@example.com' },
        { id: 'test', name: 'Teste', principal: false, active: false, status: 'logged_out', identity: null },
      ],
    },
    {
      agentId: 'codex',
      agentName: 'Codex',
      multiAccount: true,
      accounts: [
        { id: 'default', name: 'Principal', principal: true, active: true, status: 'logged_in', identity: 'user@example.com' },
        { id: 'alt', name: 'Pessoal', principal: false, active: false, status: 'unknown', identity: null },
      ],
    },
    {
      agentId: 'omp',
      agentName: 'Oh My Pi',
      multiAccount: false,
      accounts: [{ id: 'default', name: 'Principal', principal: true, active: true, status: 'logged_in', identity: 'OpenRouter' }],
    },
  ];

  /* ------------------------------------------------------------------ logs */
  let logTick = 0;
  const daemonLog: string[] = [
    '[daemon] iniciando Nanachi 0.1.0',
    '[daemon] banco aberto em C:\\Users\\user\\.nanachi-desktop\\data.db',
    '[daemon] ouvindo em 127.0.0.1:7780',
    '[daemon] 3 aparelhos pareados',
    '[acp] claude: sessão 4f2a retomada',
    '[acp] aviso: o agente demorou 4,2 s para responder',
    '[http] GET /api/health 200 2 ms',
    '[http] GET /api/workspaces 200 6 ms',
  ];
  const tailscaleLog: string[] = scenario === 'empty' ? [] : ['[tsnet] iniciando o nó nanachi-office-pc', '[tsnet] estado: precisa de login', '[tsnet] estado: ligado'];
  const logs = (): LogsInfo => {
    logTick += 1;
    const extra = Array.from({ length: Math.min(logTick, 6) }, (_, index) => `[http] GET /api/sessions 200 ${3 + index} ms`);
    return { daemon: scenario === 'down' ? [...daemonLog, '[daemon] erro: EADDRINUSE 127.0.0.1:7780'] : [...daemonLog, ...extra], tailscale: [...tailscaleLog] };
  };

  /* ------------------------------------------------------------- api object */
  const api: MockControl = {
    version: '0.1.0',
    get language() {
      return language;
    },
    onNavigate(callback) {
      navigateListeners.add(callback);
      return () => navigateListeners.delete(callback);
    },
    onLanguage(callback) {
      languageListeners.add(callback);
      return () => languageListeners.delete(callback);
    },
    window: {
      async minimize() {
        track('window.minimize');
      },
      async toggleMaximize() {
        track('window.toggleMaximize');
        windowState = { ...windowState, maximized: !windowState.maximized };
        emitWindow();
        return windowState;
      },
      async close() {
        track('window.close');
      },
      async state() {
        return windowState;
      },
      onState(callback) {
        windowListeners.add(callback);
        return () => windowListeners.delete(callback);
      },
    },
    async overview() {
      track('overview');
      await delay();
      if (scenario === 'down') return error('daemon_unavailable', text().unreachableShort(PORT));
      const info: OverviewInfo = {
        daemon,
        tailscale,
        activity: attached ? null : { workspaces: 6, sessions: 23, busySessions, devices: devices.filter((device) => !device.revoked).length },
        dataFolder: DATA_FOLDER,
        appVersion: '0.1.0',
      };
      return ok(info);
    },
    onDaemonStatus(callback) {
      daemonListeners.add(callback);
      return () => daemonListeners.delete(callback);
    },
    async restartDaemon() {
      track('restartDaemon');
      await delay();
      if (daemon.mode !== 'spawned') return error('not_own_daemon', text().notOwnDaemon);
      setDaemon({ ...daemon, state: 'starting', pid: null });
      setTimeout(() => setDaemon({ ...daemon, state: 'running', pid: 15880 }), latency > 0 ? 900 : 0);
      applied = saved.map((entry) => entry.path.toLowerCase()).join('|');
      return ok(daemon);
    },
    async openDataFolder() {
      track('openDataFolder');
    },
    sessions: {
      async setViewport(viewport) {
        track('sessions.setViewport');
        viewports.push(viewport);
      },
      onState(callback) {
        sessionsViewListeners.add(callback);
        return () => sessionsViewListeners.delete(callback);
      },
    },
    folders: {
      async get() {
        track('folders.get');
        await delay();
        return scenario === 'down' ? down() : ok(foldersState());
      },
      async pick() {
        track('folders.pick');
        await delay();
        return picked;
      },
      async save(roots, restart, confirmedBusy) {
        track(`folders.save:${restart ? 'restart' : 'later'}`);
        await delay();
        if (!editable) return error('not_own_daemon', text().rootsReadOnly);
        // Like main: the busy sessions are counted again, and nothing is written until the user agreed to interrupt them.
        if (restart && busySessions > (confirmedBusy ?? 0)) {
          const asked: SaveRootsResult = { state: foldersState(), applied: 'needs_confirmation' };
          return ok(asked);
        }
        const next: Array<{ path: string; exists: boolean }> = [];
        for (const raw of roots) {
          const path = normalize(raw);
          if (!/^[a-z]:\\/i.test(path)) return error('invalid_input', text().notAFullPath(raw));
          if (next.some((entry) => entry.path.toLowerCase() === path.toLowerCase())) continue;
          const known = saved.find((entry) => entry.path.toLowerCase() === path.toLowerCase());
          next.push({ path, exists: known ? known.exists : true });
        }
        saved = next;
        if (restart) {
          applied = saved.map((entry) => entry.path.toLowerCase()).join('|');
          setDaemon({ ...daemon, state: 'starting', pid: null });
          setTimeout(() => setDaemon({ ...daemon, state: 'running', pid: 15880 }), latency > 0 ? 900 : 0);
        }
        const result: SaveRootsResult = { state: foldersState(), applied: restart ? 'restarted' : 'pending' };
        return ok(result);
      },
      async reveal(path) {
        track(`folders.reveal:${path}`);
      },
    },
    devices: {
      async list() {
        track('devices.list');
        await delay();
        if (attached) return unknownApp();
        return scenario === 'down' ? down() : ok(devices.map((device) => ({ ...device })));
      },
      async revoke(id) {
        track(`devices.revoke:${id}`);
        await delay();
        const target = devices.find((device) => device.id === id);
        if (!target) return error('invalid_input', text().deviceGone);
        if (target.isThisApp) return error('invalid_input', text().deviceSelf);
        devices = devices.map((device) => (device.id === id ? { ...device, revoked: true } : device));
        return ok(devices.map((device) => ({ ...device })));
      },
      async pairingCode() {
        track('devices.pairingCode');
        await delay();
        if (attached) return unknownApp();
        const code: PairingCode = { code: String(100000 + Math.floor(Math.random() * 900000)), expiresAt: clock() + 5 * MINUTE - 1000 };
        return ok(code);
      },
    },
    accounts: {
      async list(refresh) {
        track(refresh ? 'accounts.list:refresh' : 'accounts.list');
        await delay();
        if (attached) return error('unauthorized', text().accountsRefused);
        return ok(accounts.map((agent) => ({ ...agent, accounts: agent.accounts.map((account) => ({ ...account })) })));
      },
      async setActive(agentId, accountId) {
        track(`accounts.setActive:${agentId}:${accountId}`);
        await delay();
        accounts = accounts.map((agent) =>
          agent.agentId === agentId ? { ...agent, accounts: agent.accounts.map((account) => ({ ...account, active: account.id === accountId })) } : agent,
        );
        return ok(accounts);
      },
    },
    tailscale: {
      async status() {
        track('tailscale.status');
        await delay();
        return tailscale;
      },
      async start() {
        track('tailscale.start');
        await delay();
        setTailscale({ state: 'starting' });
        setTimeout(
          () =>
            setTailscale(
              scenario === 'login'
                ? { state: 'needs_login', authUrl: 'https://login.tailscale.com/a/0123456789ab' }
                : { state: 'running', dnsName: 'nanachi-office-pc.tail4e2f1.ts.net', tailnet: 'user@example.com', ips: ['100.101.102.103', 'fd7a:115c:a1e0::1234'] },
            ),
          latency > 0 ? 1100 : 0,
        );
        return tailscale;
      },
      async stop() {
        track('tailscale.stop');
        await delay();
        setTailscale({ state: 'off' });
        return tailscale;
      },
      onStatus(callback) {
        tailscaleListeners.add(callback);
        return () => tailscaleListeners.delete(callback);
      },
      async openLogin(url) {
        track(`tailscale.openLogin:${url}`);
      },
    },
    logs: {
      async get() {
        track('logs.get');
        await delay();
        return logs();
      },
      async openFolder() {
        track('logs.openFolder');
      },
    },
    settings: {
      async setLanguage(next) {
        track(`settings.setLanguage:${next}`);
        const previous = language;
        language = next;
        // A status that carries main's own message is worded again, as main would on its next report.
        if (daemon.message === MOCK_MESSAGES[previous].portBusy(PORT)) setDaemon({ ...daemon, message: text().portBusy(PORT) });
        languageListeners.forEach((listener) => listener(next));
        return next;
      },
      async getAutostart() {
        track('settings.getAutostart');
        await delay();
        return autostart;
      },
      async setAutostart(value) {
        track(`settings.setAutostart:${value}`);
        await delay();
        autostart = { ...autostart, value };
        return autostart;
      },
      async checkForUpdate() {
        track('settings.checkForUpdate');
        await delay();
        const result: UpdateCheckResult =
          scenario === 'update'
            ? { status: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v0.2.0' }
            : { status: 'up-to-date', current: '0.1.0' };
        return result;
      },
      async openUpdate(url) {
        track(`settings.openUpdate:${url}`);
      },
      async uninstall() {
        track('settings.uninstall');
      },
    },
    mock: {
      setDaemon,
      setTailscale,
      setPicked: (paths) => {
        picked = paths;
      },
      navigate: (section) => navigateListeners.forEach((listener) => listener(section)),
      setSessionsView: (state) => sessionsViewListeners.forEach((listener) => listener(state)),
      viewports,
      calls,
    },
  };
  return api;
}
