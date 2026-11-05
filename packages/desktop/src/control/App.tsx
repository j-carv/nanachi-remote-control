import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ControlApi, ControlSection } from '../common/control-api.js';
import type { DaemonStatus, TailscaleStatus } from '../common/types.js';
import { isSidebarToggle, sectionForShortcut } from './lib/shortcuts.js';
import { AccountsSection } from './sections/AccountsSection.js';
import { DevicesSection } from './sections/DevicesSection.js';
import { FoldersSection } from './sections/FoldersSection.js';
import { LogsSection } from './sections/LogsSection.js';
import { OverviewSection } from './sections/OverviewSection.js';
import { SettingsSection } from './sections/SettingsSection.js';
import { TailscaleSection } from './sections/TailscaleSection.js';
import { Sidebar } from './shell/Sidebar.js';
import { TitleBar } from './shell/TitleBar.js';
import { ApiProvider, useApi } from './state/api.js';
import { FoldersProvider, useFoldersStore } from './state/folders-store.js';
import { createLiveValue } from './state/live.js';
import { useReported } from './state/reported.js';
import { useResource } from './state/resource.js';
import { ShellContext, type ShellValue } from './state/shell.js';
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

function renderSection(section: ControlSection): ReactNode {
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
    case 'logs':
      return <LogsSection />;
    case 'settings':
      return <SettingsSection />;
  }
}

function Shell() {
  const api = useApi();
  const [section, setSection] = useState<ControlSection>('overview');
  const [visited, setVisited] = useState<ReadonlySet<ControlSection>>(() => new Set<ControlSection>(['overview']));
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const pairingRequest = useRef(false);
  const focusTitle = useRef(false);
  const main = useRef<HTMLElement>(null);

  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
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
        const key = `${status.state}:${status.port}:${String(status.restricted)}`;
        if (daemonKey.current === key) return;
        daemonKey.current = key;
        void reloadOverview(true);
        if (foldersVisited.current) void reloadFolders(true);
      }),
    [api, daemonLive, reloadOverview, reloadFolders],
  );
  useEffect(() => api.tailscale.onStatus(setTailscale), [api, setTailscale]);

  const navigate = useCallback((next: ControlSection, options?: { pairing?: boolean }): void => {
    if (options?.pairing) pairingRequest.current = true;
    focusTitle.current = true;
    setSection(next);
    setVisited((current) => (current.has(next) ? current : new Set(current).add(next)));
  }, []);

  // After a section change the title takes the focus, so keyboard and screen reader users start at the top of the page.
  useEffect(() => {
    if (!focusTitle.current) return;
    focusTitle.current = false;
    main.current?.scrollTo({ top: 0 });
    document.getElementById('page-title')?.focus({ preventScroll: true });
  }, [section]);

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
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, toggleSidebar]);

  const reported = useReported();
  const openSessions = useCallback((): void => {
    reported(() => api.openSessions(), 'Não foi possível abrir as sessões.');
  }, [api, reported]);
  const takePairingRequest = useCallback((): boolean => {
    const requested = pairingRequest.current;
    pairingRequest.current = false;
    return requested;
  }, []);

  const shell = useMemo<ShellValue>(
    () => ({
      section,
      navigate,
      takePairingRequest,
      overview: overview.state,
      reloadOverview,
      daemon,
      tailscale,
      setTailscale,
      openSessions,
      foldersDirty: folders.dirty,
    }),
    [section, navigate, takePairingRequest, overview.state, reloadOverview, daemon, tailscale, openSessions, folders.dirty],
  );

  const version = overview.state.status === 'ready' ? overview.state.data.appVersion : api.version;

  return (
    <ShellContext.Provider value={shell}>
      <FoldersProvider value={folders}>
        <div className="flex h-full flex-col bg-background">
          <TitleBar machineName={daemon?.machineName ?? null} daemon={daemon} onOpenStatus={() => navigate('overview')} />
          <div className="flex min-h-0 flex-1">
            <Sidebar
              section={section}
              collapsed={collapsed}
              dirty={folders.dirty ? FOLDERS_DIRTY : NO_DIRTY}
              version={version}
              onSelect={navigate}
              onToggle={toggleSidebar}
              onOpenSessions={openSessions}
            />
            <main ref={main} id="main" aria-labelledby="page-title" className="@container min-w-0 flex-1 overflow-y-auto bg-background [scrollbar-gutter:stable]">
              <div
                key={section}
                className={cx('animate-page mx-auto flex w-full flex-col px-8 pt-7 pb-8', section === 'logs' ? 'h-full max-w-[1244px]' : 'max-w-[984px]')}
              >
                {renderSection(section)}
              </div>
            </main>
          </div>
        </div>
      </FoldersProvider>
    </ShellContext.Provider>
  );
}

/** The control center: the window's own chrome, the sidebar and the section on screen. */
export function App({ api }: { api: ControlApi }) {
  return (
    <ApiProvider api={api}>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </ApiProvider>
  );
}
