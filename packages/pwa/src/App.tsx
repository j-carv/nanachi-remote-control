import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PairResponse } from '@nanachi/shared';
import { createApiClient } from './api.js';
import { getBrowserStorage } from './browserStorage.js';
import { ErrorNotice } from './components/ErrorNotice.js';
import {
  planRestore,
  readLastRoute,
  toPersistedRoute,
  writeLastRoute,
  type PersistedRoute,
} from './lastRoute.js';
import { MachineRoutes } from './MachineRoutes.js';
import {
  parseDevicesSearch,
  parseOpenDevicesMessage,
  parseOpenSessionMessage,
  parseSessionSearch,
  targetRoute,
  type DevicesTarget,
  type SessionTarget,
} from './push/notificationRoute.js';
import {
  readMachines,
  readSelectedId,
  readStoredMachines,
  removeMachine,
  resolveSelected,
  upsertMachine,
  writeMachines,
  writeSelectedId,
  type Machine,
  type StorageLike,
} from './machines.js';
import { requestPersistentStorageOnce } from './persistStorage.js';
import {
  activeRoute,
  depthOf,
  goToDepth,
  initialNav,
  pushNav,
  replaceNav,
  type Navigator,
  type NavState,
  type Route,
} from './navigation.js';
import { DevicesScreen } from './screens/DevicesScreen.js';
import { MainScreen } from './screens/MainScreen.js';
import { PairScreen } from './screens/PairScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { useConnectionPool } from './useConnectionPool.js';
import { UpdateBar } from './updates/UpdateBar.js';

export const SAVE_FAILED_TEXT = 'Não foi possível salvar o acesso neste aparelho';
export const READ_FAILED_TEXT = 'Não foi possível ler os acessos salvos neste aparelho. Pareie de novo para continuar.';

/** Pedido de persistência do storage (token), só se o navegador tiver `navigator.storage.persist`. */
function persistRequest(storage: StorageLike) {
  const manager: StorageManager | undefined = typeof navigator === 'undefined' ? undefined : navigator.storage;
  const persist = manager?.persist;
  return {
    storage,
    persist: typeof persist === 'function' && manager !== undefined ? () => manager.persist() : undefined,
    log: (line: string) => console.info(`nanachi: ${line}`),
  };
}

function AppRoutes() {
  const storage = useMemo(() => getBrowserStorage(), []);
  const [initialStored] = useState(() => readStoredMachines(storage));
  const [machines, setMachines] = useState<Machine[]>(() => readMachines(storage));
  const [accessNotice, setAccessNotice] = useState<string | null>(() =>
    initialStored.status === 'unreadable' ? READ_FAILED_TEXT : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelectedId(storage));
  const [nav, setNav] = useState<NavState>(() =>
    initialNav(machines.length > 0 ? { kind: 'home' } : { kind: 'pair', baseUrl: null }),
  );
  const { pool, statuses } = useConnectionPool(machines);
  const selected = resolveSelected(machines, selectedId);
  const selectedMachineId = selected?.id;
  // A rota só é gravada depois de saber onde o app está (restauração respondida) ou após o usuário navegar.
  // Assim, abrir o app offline não apaga o lugar salvo.
  const persistRef = useRef(false);
  const navigatedRef = useRef(false);

  function markNavigated(): void {
    navigatedRef.current = true;
    persistRef.current = true;
  }

  // Gesto de voltar do iOS dispara popstate; a profundidade no history.state diz qual tela voltar.
  useEffect(() => {
    window.history.replaceState({ depth: 0 }, '');
    const onPop = (event: PopStateEvent) => {
      markNavigated();
      setNav((previous) => goToDepth(previous, depthOf(event.state)));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /**
   * Mostra um destino (rota salva ou sessão de uma notificação): reconstrói a pilha
   * (home → … → destino) para o gesto de voltar funcionar. O que sumiu no PC cai para o nível
   * válido mais próximo. `force` faz o destino ganhar do que o usuário já navegou.
   */
  function showSaved(
    machine: Machine,
    saved: PersistedRoute,
    force: boolean,
    isActive: () => boolean,
    onError: () => void,
  ): void {
    const api = createApiClient({ baseUrl: machine.baseUrl, token: machine.token });
    planRestore(saved, api).then(
      (stack) => {
        if (!isActive()) return;
        persistRef.current = true;
        if (navigatedRef.current && !force) return;
        for (let depth = 1; depth < stack.length; depth++) {
          window.history.pushState({ depth }, '');
        }
        select(machine.id);
        setNav({ routes: stack, index: stack.length - 1 });
      },
      onError,
    );
  }

  /** Abre a sessão de uma notificação. Sem resposta do PC, fica na home dessa máquina. */
  function openNotification(target: SessionTarget): void {
    const machine = machines.find((item) => item.id === target.machineId);
    if (machine === undefined) return;
    showSaved(machine, targetRoute(target), true, () => true, () => select(machine.id));
  }

  /** Aviso de aparelho novo (Entrar com Tailscale): Configurações → Dispositivos da máquina. */
  function openDevices(target: DevicesTarget): void {
    const machine = machines.find((item) => item.id === target.machineId);
    if (machine === undefined) return;
    const stack: Route[] = [{ kind: 'home' }, { kind: 'settings' }, { kind: 'devices' }];
    for (let depth = 1; depth < stack.length; depth++) {
      window.history.pushState({ depth }, '');
    }
    select(machine.id);
    markNavigated();
    setNav({ routes: stack, index: stack.length - 1 });
  }

  // Reabre onde parou. Se o app abriu por uma notificação (?machine=&workspace=&session=), o destino
  // vence a rota salva, e a query sai da URL para não reabrir ao recarregar.
  useEffect(() => {
    const devices = parseDevicesSearch(window.location.search);
    if (devices !== null) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
      openDevices(devices);
      return;
    }

    const target = parseSessionSearch(window.location.search);
    if (target !== null) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
      openNotification(target);
      return;
    }

    let active = true;
    const saved = readLastRoute(storage);
    const machine = saved === null ? undefined : machines.find((item) => item.id === saved.machineId);
    if (saved === null || machine === undefined) {
      persistRef.current = true;
      return () => {
        active = false;
      };
    }
    // Sem resposta do PC: fica na home sem gravar, para não perder a rota salva.
    showSaved(machine, saved, false, () => active, () => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Clique na notificação com o app já aberto: o service worker manda a sessão para esta janela.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      const target = parseOpenSessionMessage(event.data);
      if (target !== null) openNotification(target);
      const devices = parseOpenDevicesMessage(event.data);
      if (devices !== null) openDevices(devices);
    };
    container.addEventListener('message', onMessage);
    return () => container.removeEventListener('message', onMessage);
    // openNotification lê `machines`; reinscreve quando a lista muda.
  }, [machines]);

  useEffect(() => {
    if (!persistRef.current || selectedMachineId === undefined) return;
    const persisted = toPersistedRoute(selectedMachineId, activeRoute(nav));
    if (persisted !== null) writeLastRoute(storage, persisted);
  }, [nav, selectedMachineId, storage]);

  const router: Navigator = {
    push(route) {
      markNavigated();
      const next = pushNav(nav, route);
      window.history.pushState({ depth: next.depth }, '');
      setNav(next.nav);
    },
    back() {
      markNavigated();
      if (nav.index > 0) window.history.back();
    },
    replace(route) {
      markNavigated();
      window.history.replaceState({ depth: nav.index }, '');
      setNav(replaceNav(nav, route));
    },
  };

  /** Grava a lista. Se o storage recusar, o aviso aparece e a lista segue só nesta sessão. */
  function commitMachines(next: Machine[]): void {
    const saved = writeMachines(storage, next);
    setAccessNotice(saved ? null : SAVE_FAILED_TEXT);
    setMachines(next);
  }

  function select(id: string): void {
    writeSelectedId(storage, id);
    setSelectedId(id);
  }

  function handlePaired(result: PairResponse, baseUrl: string): void {
    const machine: Machine = {
      id: result.machineId,
      name: result.machineName,
      baseUrl,
      token: result.token,
    };
    commitMachines(upsertMachine(machines, machine));
    select(machine.id);
    // O token está salvo: pede ao navegador que não apague o storage sob pressão (uma vez por aparelho).
    void requestPersistentStorageOnce(persistRequest(storage));
    if (nav.index > 0) router.back();
    else router.replace({ kind: 'home' });
  }

  /** Esquece a máquina neste celular (sem perguntar). Devolve a que ficou selecionada, se houver. */
  function forgetMachine(machine: Machine): Machine | undefined {
    const next = removeMachine(machines, machine.id);
    commitMachines(next);
    const fallback = resolveSelected(next, selectedId);
    if (fallback === undefined) {
      writeSelectedId(storage, null);
      setSelectedId(null);
    } else {
      select(fallback.id);
    }
    return fallback;
  }

  function handleRemove(machine: Machine): void {
    if (!window.confirm(`Remover "${machine.name}" deste celular?`)) return;
    if (forgetMachine(machine) === undefined) router.replace({ kind: 'pair', baseUrl: null });
  }

  const route = activeRoute(nav);

  function renderScreen(current: Route): ReactNode {
    if (current.kind === 'pair' || selected === undefined) {
      return (
        <PairScreen
          initialBaseUrl={
            current.kind === 'pair' && current.baseUrl !== null ? current.baseUrl : window.location.origin
          }
          canCancel={machines.length > 0}
          onCancel={() => router.back()}
          onPaired={handlePaired}
        />
      );
    }

    if (current.kind === 'home') {
      return (
        <MainScreen
          machines={machines}
          selected={selected}
          statuses={statuses}
          onSelect={select}
          onAdd={() => router.push({ kind: 'pair', baseUrl: null })}
          onRemove={handleRemove}
          onRepair={(machine) => router.push({ kind: 'pair', baseUrl: machine.baseUrl })}
          onOpenWorkspaces={() => router.push({ kind: 'workspaces' })}
          onOpenSettings={() => router.push({ kind: 'settings' })}
          onOpenSession={openNotification}
        />
      );
    }

    if (current.kind === 'settings') {
      return <SettingsScreen machines={machines} selected={selected} nav={router} />;
    }

    if (current.kind === 'devices') {
      return (
        <DevicesScreen
          machine={selected}
          nav={router}
          onRevokedSelf={() => {
            // Revogou este aparelho: a máquina sai daqui e o app vai para o pareamento dela.
            forgetMachine(selected);
            router.replace({ kind: 'pair', baseUrl: selected.baseUrl });
          }}
        />
      );
    }

    return (
      <MachineRoutes
        machine={selected}
        route={current}
        nav={router}
        connection={pool.get(selected.id)}
        storage={storage}
      />
    );
  }

  return (
    <>
      {accessNotice !== null && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[calc(env(safe-area-inset-top,0px)+8px)]">
          <div className="pointer-events-auto w-full max-w-[560px]">
            <ErrorNotice
              message={accessNotice}
              action={{ label: 'Entendi', onClick: () => setAccessNotice(null) }}
            />
          </div>
        </div>
      )}
      {renderScreen(route)}
    </>
  );
}

/** Root of the app: the screens, plus the update bar, which is shown above every screen. */
export function App() {
  return (
    <>
      <AppRoutes />
      <UpdateBar />
    </>
  );
}
