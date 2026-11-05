import { messageOf } from '../common/message.js';
import type {
  ControlApi,
  ControlError,
  ControlResult,
  DriveInfo,
  FoldersState,
  LogsInfo,
  OverviewInfo,
  SaveRootsResult,
} from '../common/control-api.js';
import type { DaemonStatus, PairingCode, TailscaleStatus, UpdateCheckResult } from '../common/types.js';
import { controlFailure, toControlError } from './control-errors.js';
import { isAllowedLoginUrl, isAllowedReleaseUrl } from './control-policy.js';
import { DaemonApiError, type DaemonApi } from './daemon-api.js';
import { normalizeRoot, type RootsStore } from './roots-config.js';

/**
 * What the control center can ask Desktop to do: everything of `ControlApi` except the window, the version and the
 * event subscriptions (those belong to the window and the preload). The IPC layer validates the shape of what the page
 * sends; this layer validates its meaning (ids, paths, addresses) and never lets an expected failure escape as an
 * exception: a `ControlResult` carries it, in Portuguese.
 */
export type ControlActions = Omit<ControlApi, 'version' | 'window' | 'onDaemonStatus' | 'tailscale'> & {
  tailscale: Omit<ControlApi['tailscale'], 'onStatus'>;
};

/** A restart that did not end in a running daemon; carries the text for the user. */
class RestartFailedError extends Error {
  readonly failure: ControlError;
  constructor(failure: ControlError) {
    super(failure.message);
    this.failure = failure;
  }
}

/** The part of `DaemonHost` the control center uses. */
export interface ControlHost {
  status(): DaemonStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  onStatus(listener: (status: DaemonStatus) => void): () => void;
}

/** What only the shell can do (windows, dialogs, Explorer, the browser, other processes). */
export interface ControlSystem {
  /** The native multi-select folder picker. Empty when cancelled. */
  pickFolders(): Promise<string[]>;
  /** `shell.openPath`: resolves with an error text, or an empty string on success. */
  openPath(path: string): Promise<string>;
  /** `shell.showItemInFolder`: reveals an item in its parent folder; never runs it. */
  showItemInFolder(path: string): void;
  /** `shell.openExternal` for an address this layer already checked. */
  openExternal(url: string): Promise<void>;
  openSessions(): void;
  startUninstaller(): void;
}

export interface ControlServiceDeps {
  /** Desktop's data folder (also where the logs are). */
  home: string;
  appVersion: string;
  host: ControlHost;
  daemon: DaemonApi;
  roots: RootsStore;
  drives(): Promise<DriveInfo[]>;
  tailscale: {
    status(): TailscaleStatus;
    start(): Promise<TailscaleStatus>;
    stop(): Promise<TailscaleStatus>;
  };
  pairingCode(): Promise<PairingCode>;
  readLogs(): LogsInfo;
  autostart: { readonly supported: boolean; get(): boolean; set(enabled: boolean): boolean };
  checkForUpdate(): Promise<UpdateCheckResult>;
  system: ControlSystem;
  log(text: string): void;
  /** How long to wait for a restarted daemon to answer before reporting anyway. Default 30 s. */
  settleTimeoutMs?: number;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;
const MAX_ID_LENGTH = 128;

/** An agent or account or device id: plain text, no path separators and no control characters. */
function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID_LENGTH && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function ok<T>(value: T): ControlResult<T> {
  return { ok: true, value };
}

function invalidId(): ControlError {
  return controlFailure('invalid_input', 'Identificador inválido.');
}

/** What the lists that need the daemon answer while it cannot be asked (stopped, starting, in error or Tailscale-only). */
function daemonNotAskable(): ControlError {
  return controlFailure('daemon_unavailable', 'O daemon não está disponível agora, então o Nanachi não consegue consultá-lo.');
}

/** The number of sessions the user agreed to interrupt: a whole number from zero up, or nothing. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** A daemon that answers calls from this PC: up, and not restricted to Tailscale-only access. */
function askable(status: DaemonStatus): boolean {
  return (status.state === 'running' || status.state === 'attached') && !status.restricted;
}

/** The same folder written two ways (case, trailing backslash) is the same folder. */
function rootKey(path: string): string {
  return (normalizeRoot(path) ?? path).toLowerCase();
}

function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(rootKey));
  const right = new Set(b.map(rootKey));
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/** How a restart ended: the new daemon is up, is still starting after the wait, or did not come back as Desktop's own. */
type RestartOutcome = 'running' | 'starting' | 'failed';

/** `C:\x` and `c:\X\` are the same place. */
function pathKey(path: string): string {
  return (normalizeRoot(path) ?? path).toLowerCase();
}

/** Paths the page handed out of the native picker are remembered (up to this many) so it may ask to show them. */
const MAX_PICKED = 1024;

export function createControlService(deps: ControlServiceDeps): ControlActions {
  const { host, daemon, roots, system } = deps;
  /** The folders the picker returned: not saved yet, but the editor shows them and may ask to reveal them. */
  const picked = new Set<string>();

  /** The restart requested through `restartDaemon` that has not finished. */
  let restarting: Promise<ControlResult<DaemonStatus>> | null = null;
  /** Saves and restarts never overlap: each waits for the one before it. */
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  }

  /** Every expected failure becomes a `ControlError`; an unexpected one is also written to the log. */
  function failureOf(error: unknown): ControlError {
    if (error instanceof RestartFailedError) return error.failure;
    const failure = toControlError(error);
    if (failure.code === 'unknown') deps.log(`centro de controle: ${messageOf(error)}`);
    return failure;
  }

  async function safely<T>(run: () => Promise<T>): Promise<ControlResult<T>> {
    try {
      return ok(await run());
    } catch (error) {
      return failureOf(error);
    }
  }

  /** Resolves when the daemon has left `starting` (it answered, or it failed), or after the timeout. */
  function settled(): Promise<void> {
    if (host.status().state !== 'starting') return Promise.resolve();
    return new Promise((resolve) => {
      let off: () => void = () => undefined;
      const timer = setTimeout(() => {
        off();
        resolve();
      }, deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
      off = host.onStatus((status) => {
        if (status.state === 'starting') return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  async function restart(): Promise<RestartOutcome> {
    await host.stop();
    await host.start();
    await settled();
    // The answer is what the daemon is now, not that the calls above returned.
    const status = host.status();
    if (status.state === 'starting') return 'starting';
    return status.state === 'running' && status.mode === 'spawned' ? 'running' : 'failed';
  }

  /** The text for a restart that did not end in a running daemon of Desktop's own. */
  function restartFailure(): ControlError {
    const status = host.status();
    const detail = status.message === null ? '' : ` ${status.message}`;
    if (status.state === 'attached') {
      return controlFailure('daemon_unavailable', 'O daemon foi parado, mas outro programa já usava a porta e o Nanachi se conectou a ele em vez de iniciar o seu.');
    }
    return controlFailure('daemon_unavailable', `O daemon foi parado, mas não conseguiu iniciar de novo.${detail} Veja a aba Logs.`);
  }

  async function openFolder(path: string): Promise<void> {
    const problem = await system.openPath(path);
    if (problem !== '') deps.log(`não foi possível abrir ${path}: ${problem}`);
  }

  /** The sessions a restart would interrupt right now; zero when the daemon cannot say. */
  async function busyNow(): Promise<number> {
    if (!askable(host.status())) return 0;
    try {
      return (await daemon.activity()).busySessions;
    } catch {
      return 0;
    }
  }

  /** What the editor may be showing: the saved folders, the folders just picked, and the drives. */
  async function revealable(): Promise<Set<string>> {
    const allowed = new Set<string>([...roots.read(), ...picked].map(pathKey));
    for (const drive of await deps.drives()) allowed.add(pathKey(drive.root));
    return allowed;
  }

  async function readActivity(status: DaemonStatus): Promise<OverviewInfo['activity']> {
    if (!askable(status)) return null;
    try {
      const [activity, devices] = await Promise.all([daemon.activity(), daemon.devices()]);
      return { ...activity, devices: devices.length };
    } catch {
      return null;
    }
  }

  async function foldersState(): Promise<FoldersState> {
    const status = host.status();
    const saved = roots.read();
    const live = async (): Promise<{ roots: string[] | null; busy: number }> => {
      if (!askable(status)) return { roots: null, busy: 0 };
      const [liveRoots, activity] = await Promise.allSettled([daemon.roots(), daemon.activity()]);
      return {
        roots: liveRoots.status === 'fulfilled' ? liveRoots.value : null,
        busy: activity.status === 'fulfilled' ? activity.value.busySessions : 0,
      };
    };
    const [drives, running] = await Promise.all([deps.drives(), live()]);

    // A daemon Desktop did not start has its own folders: those are the real ones, and they are read-only here. When it
    // cannot be asked, its list is unknown; Desktop's own list is not a substitute for it.
    const attached = status.mode === 'attached';
    const rootsUnknown = attached && running.roots === null;
    const shown = attached ? (running.roots ?? []).map((path) => normalizeRoot(path) ?? path) : saved;
    return {
      roots: await roots.describe(shown),
      rootsUnknown,
      drives,
      editable: !attached,
      restartPending: status.mode === 'spawned' && running.roots !== null && !sameRoots(running.roots, saved),
      busySessions: running.busy,
    };
  }

  return {
    overview: () =>
      safely(async () => {
        // The states are read after the activity: reading them first would send an answer that is already old when the
        // page gets it, and the page would put it over a status event that arrived meanwhile.
        const activity = await readActivity(host.status());
        return {
          daemon: host.status(),
          tailscale: deps.tailscale.status(),
          activity,
          dataFolder: deps.home,
          appVersion: deps.appVersion,
        };
      }),

    // Callers that arrive while a restart is pending (or running) share it: one restart, one answer.
    restartDaemon: () => {
      restarting ??= exclusive(async (): Promise<ControlResult<DaemonStatus>> => {
        if (host.status().mode === 'attached') {
          return controlFailure('not_own_daemon', 'O Nanachi está usando um daemon que ele não iniciou, então não pode reiniciá-lo por aqui.');
        }
        return safely(async () => {
          const outcome = await restart();
          if (outcome === 'failed') throw new RestartFailedError(restartFailure());
          return host.status();
        });
      }).finally(() => {
        restarting = null;
      });
      return restarting;
    },

    openSessions: () => {
      system.openSessions();
      return Promise.resolve();
    },

    openDataFolder: () => openFolder(deps.home),

    folders: {
      get: () => safely(foldersState),

      pick: async () => {
        const chosen = await system.pickFolders();
        const seen = new Set<string>();
        const paths: string[] = [];
        for (const raw of chosen) {
          const path = normalizeRoot(raw);
          if (path === null || seen.has(path.toLowerCase())) continue;
          seen.add(path.toLowerCase());
          paths.push(path);
        }
        if (picked.size + paths.length > MAX_PICKED) picked.clear();
        for (const path of paths) picked.add(pathKey(path));
        return paths;
      },

      save: (input, restartNow, confirmedBusy) =>
        exclusive(async (): Promise<ControlResult<SaveRootsResult>> => {
          if (confirmedBusy !== undefined && !isCount(confirmedBusy)) {
            return controlFailure('invalid_input', 'A confirmação de sessões em andamento é inválida.');
          }
          if (host.status().mode === 'attached') {
            return controlFailure(
              'not_own_daemon',
              'O Nanachi está conectado a um daemon que ele não iniciou; a lista de pastas dele não pode ser editada por aqui.',
            );
          }
          return safely(async () => {
            // Only a daemon Desktop runs itself is restarted. With nothing running, the next start reads the new list.
            const willRestart = restartNow && host.status().mode === 'spawned';
            // What the screen showed may be minutes old: the sessions are counted again right before anything is touched,
            // and a restart that would interrupt more than the user agreed to waits for a new answer.
            if (willRestart && (await busyNow()) > (confirmedBusy ?? 0)) {
              return { state: await foldersState(), applied: 'needs_confirmation' as const };
            }
            await roots.save(input);
            let applied: SaveRootsResult['applied'] = 'pending';
            if (willRestart) {
              const outcome = await restart();
              applied = outcome === 'running' ? 'restarted' : outcome === 'starting' ? 'starting' : 'restart_failed';
            }
            return { state: await foldersState(), applied };
          });
        }),

      reveal: async (path) => {
        const normalized = typeof path === 'string' ? normalizeRoot(path) : null;
        if (normalized === null) throw new TypeError('caminho inválido');
        // Only what the editor can be showing: the page does not get to point Desktop at an arbitrary path.
        if (!(await revealable()).has(pathKey(normalized))) throw new TypeError('caminho fora da lista');
        const kind = await roots.probe(normalized);
        if (kind === 'timeout') {
          deps.log(`não foi possível abrir ${normalized}: o local não respondeu a tempo`);
          return;
        }
        // A folder is opened; anything else is only shown in its parent, so a file is never run.
        if (kind === 'dir') return openFolder(normalized);
        system.showItemInFolder(normalized);
      },
    },

    devices: {
      list: () => (askable(host.status()) ? safely(() => daemon.devices()) : Promise.resolve(daemonNotAskable())),

      revoke: async (id) => {
        if (!isValidId(id)) return invalidId();
        if (!askable(host.status())) return daemonNotAskable();
        try {
          const before = await daemon.devices();
          const target = before.find((device) => device.id === id);
          // Already gone: nothing to do.
          if (target === undefined) return ok(before);
          if (target.isThisApp) {
            return controlFailure('invalid_input', 'Este é o dispositivo que o próprio Nanachi Desktop usa; revogá-lo o desconectaria do daemon.');
          }
          try {
            await daemon.revokeDevice(id);
          } catch (error) {
            // Revoked meanwhile (from the phone, or twice): the goal is met.
            if (!(error instanceof DaemonApiError) || error.kind !== 'not_found') throw error;
          }
          return ok(await daemon.devices());
        } catch (error) {
          return failureOf(error);
        }
      },

      pairingCode: () => {
        if (!askable(host.status())) {
          return Promise.resolve(controlFailure('daemon_unavailable', 'O daemon não está rodando, então não dá para gerar um código agora.'));
        }
        return safely(() => deps.pairingCode());
      },
    },

    accounts: {
      list: (refresh) => (askable(host.status()) ? safely(() => daemon.accounts(refresh === true)) : Promise.resolve(daemonNotAskable())),

      setActive: (agentId, accountId) => {
        if (!isValidId(agentId) || !isValidId(accountId)) return Promise.resolve(invalidId());
        if (!askable(host.status())) return Promise.resolve(daemonNotAskable());
        return safely(async () => {
          await daemon.setActiveAccount(agentId, accountId);
          return daemon.accounts(false);
        });
      },
    },

    tailscale: {
      status: () => Promise.resolve(deps.tailscale.status()),
      start: () => deps.tailscale.start(),
      stop: () => deps.tailscale.stop(),
      // The address Tailscale itself is asking the user to visit; the page can only repeat it. A page that sends another
      // address, or asks while no login is pending, opens nothing.
      openLogin: (url) => {
        const status = deps.tailscale.status();
        const pending = status.state === 'needs_login' ? isAllowedLoginUrl(status.authUrl) : null;
        const requested = isAllowedLoginUrl(url);
        if (pending === null || requested !== pending) return Promise.reject(new TypeError('endereço não permitido'));
        return system.openExternal(pending);
      },
    },

    logs: {
      get: () => Promise.resolve(deps.readLogs()),
      openFolder: () => openFolder(deps.home),
    },

    settings: {
      getAutostart: () => Promise.resolve({ value: deps.autostart.get(), supported: deps.autostart.supported }),
      setAutostart: (value) => Promise.resolve({ value: deps.autostart.set(value), supported: deps.autostart.supported }),
      checkForUpdate: () => deps.checkForUpdate(),
      openUpdate: (url) => {
        const allowed = isAllowedReleaseUrl(url);
        if (allowed === null) return Promise.reject(new TypeError('endereço não permitido'));
        return system.openExternal(allowed);
      },
      uninstall: () => {
        system.startUninstaller();
        return Promise.resolve();
      },
    },
  };
}
