import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { createApiClient } from './api.js';
import type { Connection } from './connection.js';
import type { Machine, StorageLike } from './machines.js';
import { Screen } from './components/Screen.js';
import type { Navigator, Route } from './navigation.js';
import { FilesScreen } from './screens/FilesScreen.js';
import { FolderPickerScreen } from './screens/FolderPickerScreen.js';
import { SessionsScreen } from './screens/SessionsScreen.js';
import { WorkspacesScreen } from './screens/WorkspacesScreen.js';

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
// O editor traz o CodeMirror (e os parsers de linguagem): fica fora do bundle principal até abrir um arquivo.
const EditorScreen = lazy(() =>
  import('./screens/EditorScreen.js').then((module) => ({ default: module.EditorScreen })),
);

interface MachineRoutesProps {
  machine: Machine;
  route: Route;
  nav: Navigator;
  connection: Connection | undefined;
  storage: StorageLike;
}

function LazyFallback() {
  return (
    <Screen>
      <p className="text-muted-foreground">Carregando…</p>
    </Screen>
  );
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LazyFallback />}>{children}</Suspense>;
}

/** Telas que falam com uma máquina (workspaces, pastas, sessões, chat). Home, pareamento, ajustes e dispositivos ficam no App. */
export function MachineRoutes({ machine, route, nav, connection, storage }: MachineRoutesProps) {
  const api = useMemo(
    () => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }),
    [machine.baseUrl, machine.token],
  );
  const onRepair = () => nav.push({ kind: 'pair', baseUrl: machine.baseUrl });

  switch (route.kind) {
    case 'workspaces':
      return (
        <WorkspacesScreen machineName={machine.name} api={api} nav={nav} onRepair={onRepair} />
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
              onRepair={onRepair}
            />
          </Lazy>
        );
      }
      return (
        <Lazy>
          <ChatScreen
            key={route.session.id}
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
