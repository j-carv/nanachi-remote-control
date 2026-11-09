import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { createApiClient } from './api.js';
import type { Connection, ConnectionStatus } from './connection.js';
import type { Machine, StorageLike } from './machines.js';
import { Screen } from './components/Screen.js';
import type { Navigator, Route } from './navigation.js';
import { FilesScreen } from './screens/FilesScreen.js';
import { FolderPickerScreen } from './screens/FolderPickerScreen.js';
import { SessionsScreen } from './screens/SessionsScreen.js';
import { WorkspacesScreen } from './screens/WorkspacesScreen.js';
import { SchedulesScreen } from './screens/SchedulesScreen.js';

// Telas pesadas (markdown, xterm) saem do bundle principal: carregam ao abrir a primeira vez.
// O service worker precacheia os chunks, então funcionam offline depois de instalados.
const ChatScreen = lazy(() =>
  import('./screens/ChatScreen.js').then((module) => ({ default: module.ChatScreen })),
);
const TerminalScreen = lazy(() =>
  import('./screens/TerminalScreen.js').then((module) => ({ default: module.TerminalScreen })),
);
const ChangesScreen = lazy(() =>
  import('./screens/ChangesScreen.js').then((module) => ({ default: module.ChangesScreen })),
);
const CommitsScreen = lazy(() =>
  import('./screens/CommitsScreen.js').then((module) => ({ default: module.CommitsScreen })),
);
const CommitScreen = lazy(() =>
  import('./screens/CommitScreen.js').then((module) => ({ default: module.CommitScreen })),
);
// O editor traz o CodeMirror (e os parsers de linguagem): fica fora do bundle principal até abrir um arquivo.
const EditorScreen = lazy(() =>
  import('./screens/EditorScreen.js').then((module) => ({ default: module.EditorScreen })),
);

interface MachineRoutesProps {
  machine: Machine;
  route: Route;
  nav: Navigator;
  connection: Connection | undefined;
  /** The machine's connection state, for the workspace list's counts (they reload when the machine comes back). */
  status: ConnectionStatus | undefined;
  storage: StorageLike;
}

function LazyFallback() {
  const { t } = useTranslation();
  return (
    <Screen>
      <p className="text-muted-foreground">{t('states.loading')}</p>
    </Screen>
  );
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LazyFallback />}>{children}</Suspense>;
}

/** Telas que falam com uma máquina (workspaces, pastas, sessões, chat). Home, pareamento, ajustes e dispositivos ficam no App. */
export function MachineRoutes({ machine, route, nav, connection, status, storage }: MachineRoutesProps) {
  const api = useMemo(
    () => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }),
    [machine.baseUrl, machine.token],
  );
  const onRepair = () => nav.push({ kind: 'pair', baseUrl: machine.baseUrl });

  switch (route.kind) {
    case 'workspaces':
      return (
        <WorkspacesScreen
          machineName={machine.name}
          api={api}
          connection={connection}
          status={status}
          nav={nav}
          onRepair={onRepair}
        />
      );

    case 'folders':
      return <FolderPickerScreen api={api} nav={nav} onRepair={onRepair} />;

    case 'sessions':
      return (
        <SessionsScreen
          key={route.workspace.id}
          machineName={machine.name}
          workspace={route.workspace}
          api={api}
          connection={connection}
          storage={storage}
          nav={nav}
          onRepair={onRepair}
        />
      );

    case 'schedules':
      return <SchedulesScreen key={JSON.stringify([machine.id, machine.baseUrl, machine.token, route.workspace.id])} api={api} workspace={route.workspace} machineName={machine.name} nav={nav} onRepair={onRepair} />;

    case 'chat':
      // Sessão PTY não tem chat: mesma rota e cabeçalho, com o terminal no lugar da conversa.
      if (route.session.kind === 'pty') {
        return (
          <Lazy>
            <TerminalScreen
              key={route.session.id}
              machineName={machine.name}
              workspace={route.workspace}
              session={route.session}
              api={api}
              connection={connection}
              nav={nav}
            />
          </Lazy>
        );
      }
      return (
        <Lazy>
          <ChatScreen
            key={JSON.stringify([machine.id, route.session.id])}
            machineId={machine.id}
            machineName={machine.name}
            workspace={route.workspace}
            session={route.session}
            api={api}
            connection={connection}
            storage={storage}
            nav={nav}
            onRepair={onRepair}
          />
        </Lazy>
      );

    case 'changes':
      return (
        <Lazy>
          <ChangesScreen
            machineName={machine.name}
            workspace={route.workspace}
            session={route.session}
            api={api}
            nav={nav}
            onRepair={onRepair}
          />
        </Lazy>
      );

    case 'commits':
      return (
        <Lazy>
          <CommitsScreen
            key={route.session.id}
            machineName={machine.name}
            workspace={route.workspace}
            session={route.session}
            api={api}
            nav={nav}
            onRepair={onRepair}
          />
        </Lazy>
      );

    case 'commit':
      return (
        <Lazy>
          <CommitScreen
            key={route.hash}
            machineName={machine.name}
            workspace={route.workspace}
            session={route.session}
            hash={route.hash}
            api={api}
            nav={nav}
            onRepair={onRepair}
          />
        </Lazy>
      );

    case 'files':
      return (
        <FilesScreen
          key={route.path}
          workspace={route.workspace}
          path={route.path}
          api={api}
          nav={nav}
          onRepair={onRepair}
        />
      );

    case 'editor':
      return (
        <Lazy>
          <EditorScreen
            key={route.path}
            workspace={route.workspace}
            path={route.path}
            api={api}
            nav={nav}
            onRepair={onRepair}
          />
        </Lazy>
      );

    case 'home':
    case 'pair':
    case 'settings':
    case 'devices':
      return null;
  }
}
