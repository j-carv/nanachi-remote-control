import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { ControlApi, ControlSection, SessionsViewState } from '../common/control-api.js';
import type { DaemonStatus, TailscaleStatus, UpdateCheckResult } from '../common/types.js';
import { createControlI18n } from './i18n.js';
import { initialSection, sessionsState, sessionsViewWanted } from './lib/sessions.js';
import { isSidebarToggle, sectionForShortcut } from './lib/shortcuts.js';
import { AccountsSection } from './sections/AccountsSection.js';
import { DevicesSection } from './sections/DevicesSection.js';
import { DiagnosticsSection } from './sections/DiagnosticsSection.js';
import { FoldersSection } from './sections/FoldersSection.js';
import { LogsSection, type LogTab } from './sections/LogsSection.js';
import { OverviewSection } from './sections/OverviewSection.js';
import { SessionsStage, SessionsUnavailable } from './sections/SessionsSection.js';
import { SettingsSection } from './sections/SettingsSection.js';
import { TailscaleSection } from './sections/TailscaleSection.js';
import { Sidebar } from './shell/Sidebar.js';
import { TitleBar } from './shell/TitleBar.js';
import { ApiProvider, useApi } from './state/api.js';
import { FoldersProvider, useFoldersStore } from './state/folders-store.js';
import { createLiveValue } from './state/live.js';
import { createLogViewStore } from './state/log-view.js';
import { useOverlayActive } from './state/overlay.js';
import { usePairingSession, usePairingSessionStore } from './state/pairing-session.js';
import { plain, useResource } from './state/resource.js';
import { ShellContext, type ShellValue } from './state/shell.js';
import { useSessionsViewport } from './state/sessions-viewport.js';
import { useHoldToasts } from './state/toast-hold.js';
import { useUninstallGuard, useUninstallGuardStore } from './state/uninstall-guard.js';
import { cx } from './ui/cx.js';
import { ToastProvider } from './ui/Toast.js';

const SIDEBAR_KEY = 'nanachi.control.sidebarCollapsed';
const NO_DIRTY: ReadonlySet<ControlSection> = new Set();
const FOLDERS_DIRTY: ReadonlySet<ControlSection> = new Set<ControlSection>(['folders']);

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  } catch {
    // Private mode or cleared storage: the sidebar simply starts expanded next time.
  }
}

function renderSection(section: ControlSection, daemon: DaemonStatus | null, viewState: SessionsViewState, openOverview: () => void): ReactNode {
  switch (section) {
    case 'overview':
      return <OverviewSection />;
    case 'folders':
      return <FoldersSection />;
    case 'devices':
      return <DevicesSection />;
    case 'accounts':
      return <AccountsSection />;
    case 'tailscale':
      return <TailscaleSection />;
    case 'diagnostics':
      return <DiagnosticsSection />;
    case 'logs':
      return <LogsSection />;
    case 'settings':
      return <SettingsSection />;
    case 'sessions':
      // Only reached while the PWA cannot be shown: the section explains why. With the daemon ready the shell draws the stage.
      return <SessionsUnavailable daemon={daemon} viewState={viewState} onOpenOverview={openOverview} />;
  }
}

function Shell() {
  const api = useApi();
  // A window opened for the tray's "Abrir sessões" starts on that section (`?section=`); main asks an open one to go there.
  const [section, setSection] = useState<ControlSection>(() => initialSection(window.location.search));
  const [visited, setVisited] = useState<ReadonlySet<ControlSection>>(() => new Set<ControlSection>([initialSection(window.location.search)]));
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // State that belongs to a section but must survive switching away from it: the section remounts on every switch.
  const pairingStore = usePairingSessionStore(api);
  const pairing = usePairingSession(pairingStore);
  const [logsTab, setLogsTab] = useState<LogTab>('daemon');
  const [logView] = useState(() => createLogViewStore());
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  // The uninstall button's guard: a switch of section remounts Settings, and the remount must neither re-enable it nor restart it.
  const uninstallStore = useUninstallGuardStore();
  const uninstallGuard = useUninstallGuard(uninstallStore);
  const focusTitle = useRef(false);
  const main = useRef<HTMLElement>(null);

  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  /** What main says about the sessions view: `crashed` when its page kept dying and main stopped replacing it. */
  const [viewState, setViewState] = useState<SessionsViewState>('ok');
  const [tailscale, setTailscaleState] = useState<TailscaleStatus | null>(null);
  // The daemon and Tailscale status come from events and from the overview poll. An answer to a poll is older than any
  // event that arrived while the call was in flight, so it never overwrites one (see `state/live.ts`).
  const [daemonLive] = useState(() => createLiveValue<DaemonStatus>());
  const [tailscaleLive] = useState(() => createLiveValue<TailscaleStatus>());
  const overview = useResource(async () => {
    const daemonToken = daemonLive.begin();
    const tailscaleToken = tailscaleLive.begin();
    const result = await api.overview();
    if (result.ok) {
      if (daemonLive.offer(daemonToken, result.value.daemon)) setDaemon(result.value.daemon);
      if (tailscaleLive.offer(tailscaleToken, result.value.tailscale)) setTailscaleState(result.value.tailscale);
    }
    return result;
  });
  const { reload: reloadOverview } = overview;
  // When the overview and the daemon status last arrived: the Diagnostics section shows both, so a stale page is visible.
  const [overviewSyncedAt, setOverviewSyncedAt] = useState<number | null>(null);
  const [daemonEventAt, setDaemonEventAt] = useState<number | null>(null);
  useEffect(() => {
    if (overview.state.status === 'ready') setOverviewSyncedAt(Date.now());
  }, [overview.state]);
  // The logs are read when the Diagnostics section opens (its own call reloads them): `enabled: false` postpones the first load.
  const logs = useResource(() => plain(() => api.logs.get()), { enabled: false });
  const { reload: reloadLogs } = logs;
  const folders = useFoldersStore(visited.has('folders'));
  const { reload: reloadFolders } = folders.resource;
  const foldersVisited = useRef(false);
  foldersVisited.current = visited.has('folders');

  const setTailscale = useCallback(
    (status: TailscaleStatus): void => {
      tailscaleLive.event(status);
      setTailscaleState(status);
    },
    [tailscaleLive],
  );
  // The activity numbers (workspaces, sessions, devices) come from the daemon itself, so what the first load found while
  // the daemon was still starting is stale: ask again when its state, port or access changes, instead of waiting for the
  // poll. The folders section depends on the running daemon too (is a restart still pending? how many sessions are busy?),
  // so a restart from anywhere also refreshes it, if it was ever opened.
  const daemonKey = useRef<string | null>(null);
  useEffect(
    () =>
      api.onDaemonStatus((status) => {
        daemonLive.event(status);
        setDaemon(status);
        setDaemonEventAt(Date.now());
        const key = `${status.state}:${status.port}:${String(status.restricted)}`;
        if (daemonKey.current === key) return;
        daemonKey.current = key;
        void reloadOverview(true);
        if (foldersVisited.current) void reloadFolders(true);
      }),
    [api, daemonLive, reloadOverview, reloadFolders],
  );
  useEffect(() => api.tailscale.onStatus(setTailscale), [api, setTailscale]);
  useEffect(() => api.sessions.onState(setViewState), [api]);

  const navigate = useCallback(
    (next: ControlSection, options?: { pairing?: boolean }): void => {
      if (options?.pairing) pairingStore.open();
      focusTitle.current = true;
      setSection(next);
      setVisited((current) => (current.has(next) ? current : new Set(current).add(next)));
    },
    [pairingStore],
  );

  // After a section change the title takes the focus, so keyboard and screen reader users start at the top of the page.
  useEffect(() => {
    if (!focusTitle.current) return;
    focusTitle.current = false;
    main.current?.scrollTo({ top: 0 });
    document.getElementById('page-title')?.focus({ preventScroll: true });
  }, [section]);

  // The tray (or Ctrl+1..8 pressed inside the PWA, which holds the keyboard) asks for a section.
  useEffect(() => api.onNavigate(navigate), [api, navigate]);

  const toggleSidebar = useCallback((): void => {
    setCollapsed((current) => {
      writeCollapsed(!current);
      return !current;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (document.querySelector('dialog[open]')) return;
      const target = sectionForShortcut(event);
      if (target) {
        event.preventDefault();
        navigate(target);
      } else if (isSidebarToggle(event)) {
        // On Sessões the sidebar is the rail whatever was saved: toggling would only change the choice out of sight.
        if (section === 'sessions') return;
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, toggleSidebar, section]);

  const openSessions = useCallback((): void => navigate('sessions'), [navigate]);
  const openOverview = useCallback((): void => navigate('overview'), [navigate]);

  const shell = useMemo<ShellValue>(
    () => ({
      section,
      navigate,
      pairing,
      logsTab,
      setLogsTab,
      logView,
      updateCheck,
      setUpdateCheck,
      uninstallGuard,
      overview: overview.state,
      reloadOverview,
      daemon,
      tailscale,
      setTailscale,
      overviewSyncedAt,
      daemonEventAt,
      logs: logs.state,
      reloadLogs,
      openSessions,
      foldersDirty: folders.dirty,
    }),
    [
      section,
      navigate,
      pairing,
      logsTab,
      logView,
      updateCheck,
      uninstallGuard,
      overview.state,
      reloadOverview,
      daemon,
      tailscale,
      overviewSyncedAt,
      daemonEventAt,
      logs.state,
      reloadLogs,
      openSessions,
      folders.dirty,
    ],
  );

  const version = overview.state.status === 'ready' ? overview.state.data.appVersion : api.version;

  // The Sessões section with a daemon that is ready: the PWA is drawn by main over the whole content area, so the page keeps
  // that area bare and tells main where it is (and whether a dialog needs it; toasts wait instead). When the PWA page kept
  // dying main hides the view: the area then shows the explanation, and the section still reports itself as on screen, so
  // opening it anew (a report that turns active again) is what tries once more.
  const sessionsSelected = section === 'sessions';
  const sessionsStatus = sessionsState(daemon, viewState);
  const sessionsOnScreen = sessionsSelected && sessionsStatus === 'ready';
  const covered = useOverlayActive();
  useSessionsViewport(api, main, { active: sessionsSelected && sessionsViewWanted(sessionsStatus), covered });
  useHoldToasts(sessionsOnScreen);

  return (
    <ShellContext.Provider value={shell}>
      <FoldersProvider value={folders}>
        <div className="flex h-full flex-col bg-background">
          <TitleBar machineName={daemon?.machineName ?? null} daemon={daemon} nativeTips={sessionsSelected} onOpenStatus={() => navigate('overview')} />
          <div className="flex min-h-0 flex-1">
            <Sidebar
              section={section}
              collapsed={collapsed}
              dirty={folders.dirty ? FOLDERS_DIRTY : NO_DIRTY}
              version={version}
              onSelect={navigate}
              onToggle={toggleSidebar}
              sessionsOpen={sessionsSelected}
            />
            <main
              ref={main}
              id="main"
              aria-labelledby="page-title"
              className={cx('@container min-w-0 flex-1 bg-background', sessionsOnScreen ? 'overflow-hidden' : 'overflow-y-auto [scrollbar-gutter:stable]')}
            >
              {sessionsOnScreen ? (
                <SessionsStage />
              ) : (
                <div
                  key={section}
                  className={cx('animate-page mx-auto flex w-full flex-col px-8 pt-7 pb-8', section === 'logs' ? 'h-full max-w-[1244px]' : 'max-w-[984px]')}
                >
                  {renderSection(section, daemon, viewState, openOverview)}
                </div>
              )}
            </main>
          </div>
        </div>
      </FoldersProvider>
    </ShellContext.Provider>
  );
}

/**
 * The control center: the window's own chrome, the sidebar and the section on screen. Its language is main's: it starts from
 * the one the preload read and follows every change, so the tray and the page never disagree.
 */
export function App({ api }: { api: ControlApi }) {
  const i18n = useMemo(() => createControlI18n(api.language), [api]);
  useEffect(() => {
    document.documentElement.lang = i18n.language;
    return api.onLanguage((language) => {
      void i18n.changeLanguage(language);
      document.documentElement.lang = language;
    });
  }, [api, i18n]);
  return (
    <I18nextProvider i18n={i18n}>
      <ApiProvider api={api}>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </ApiProvider>
    </I18nextProvider>
  );
}
