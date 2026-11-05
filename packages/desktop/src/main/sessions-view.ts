import { ALLOWED_EVENT_CHANNELS, EVENT_CHANNELS } from '../common/channels.js';
import type { ControlSection, SessionsViewState, SessionsViewport } from '../common/control-api.js';
import { daemonReady } from '../common/daemon-ready.js';
import type { Language } from '../common/i18n/languages.js';
import type { InputLike } from '../common/shortcuts.js';
import { sectionForInput } from '../common/shortcuts.js';
import type { DaemonStatus } from '../common/types.js';
import { messageOf } from '../common/message.js';
import { isSameOrigin } from './panel-policy.js';
import { decideSessionsView, type ContentSize, type ViewBounds } from './sessions-viewport.js';

/**
 * The sessions view: the PWA (the same app as on the phone) drawn by main over the content area of the control center while
 * the "Sessões" section is on screen. This module holds the decisions (when to create it, load it, show it, hide it, reload
 * it); the Electron objects are behind `ViewHandle`, built by `sessions-view-electron.ts`, so all of it runs under vitest.
 */

/** A page whose renderer dies this many times within `DEATH_WINDOW_MS` is not replaced again until the section is opened anew. */
export const MAX_DEATHS_IN_WINDOW = 2;
export const DEATH_WINDOW_MS = 30_000;

/** The part of the view's `webContents` this module drives. */
export interface ViewContents {
  loadURL(url: string): Promise<void>;
  reload(): void;
  isDestroyed(): boolean;
  /** The page is still loading (its preload has run, or is about to; its scripts may not be listening yet). */
  isLoading(): boolean;
  focus(): void;
  getURL(): string;
  /** An event for the page (the PWA bridge's `desktop:*` events). */
  send(channel: string, payload: unknown): void;
}

/** The part of a `WebContentsView` this module drives. */
export interface ViewHandle {
  readonly contents: ViewContents;
  setBounds(bounds: ViewBounds): void;
  setVisible(visible: boolean): void;
  /** The renderer process died (`reason` is Electron's, never `clean-exit`). */
  onRenderGone(listener: (reason: string) => void): void;
  /** A key press inside the view, before the page sees it; `consume` keeps the page from getting it. */
  onInput(listener: (input: InputLike, consume: () => void) => void): void;
  /** Closes the view's page (the host has already taken the view off the window). */
  dispose(): void;
}

/** The control window, as far as the view needs it. */
export interface SessionsHost {
  /** The window's content area, or null when there is no window. */
  contentSize(): ContentSize | null;
  /** The control window has the keyboard focus: the view never takes it from another application. */
  isFocused(): boolean;
  attach(handle: ViewHandle): void;
  /** Takes the view off the window (it is about to be disposed). */
  detach(handle: ViewHandle): void;
  /** Gives the keyboard back to the control center's own page. */
  focusPage(): void;
  /** Calls `listener` whenever the window is resized; returns the function that stops it. */
  onResize(listener: () => void): () => void;
}

export interface SessionsViewDeps {
  host: SessionsHost;
  /** `http://127.0.0.1:<port>`, read each time because the port can change between starts. */
  origin(): string;
  daemonStatus(): DaemonStatus;
  /** Builds the view: locked-down web preferences, the daemon origin only, the panel's preload. */
  createView(): ViewHandle;
  /** Runs before every load of the PWA: the cache is refreshed when the daemon serves another build, and Desktop is paired when needed. A failure only means the PWA starts unpaired. */
  prepare(): Promise<void>;
  /** Ctrl+1..8 pressed inside the view: the page has to show that section. */
  onShortcut(section: ControlSection): void;
  /** The view gave up (its page kept dying) or is fine again: the page shows an explanation instead of an empty area. */
  viewState(state: SessionsViewState): void;
  /** The clock, for tests. */
  now?(): number;
  note(text: string): void;
}

export interface SessionsView {
  /** What the control center page reported about the area for the view. */
  setViewport(viewport: SessionsViewport): void;
  /** The daemon status changed: hides the view when it is not ready; reloads it when the daemon came back or moved. */
  onDaemonStatus(status: DaemonStatus): void;
  /** Sends an event to the PWA (one of the bridge's fixed event channels); dropped unless the view shows the daemon's own origin. */
  send(channel: string, payload: unknown): void;
  /** Reloads the PWA, e.g. after Desktop paired again so the preload seeds the new token. */
  reload(): void;
  /**
   * Desktop's language changed. The PWA that is there switches at once through the bridge event (nothing reloads, so an
   * unsent message stays); one that is still loading is reloaded, because its preload then hands it the language; with no
   * page to tell, nothing happens and the next load takes the language from the preload. Says which of the three it was.
   */
  languageChanged(language: Language): 'sent' | 'reloaded' | 'none';
  /** True while a view exists (it is created the first time the section has something to show). */
  exists(): boolean;
  destroy(): void;
}

export function createSessionsView(deps: SessionsViewDeps): SessionsView {
  let handle: ViewHandle | null = null;
  /** Bumped whenever the view is replaced or destroyed, so a late answer of an older load is ignored. */
  let generation = 0;
  let viewport: SessionsViewport | null = null;
  let shown = false;
  let destroyed = false;
  /** When the renderer of a view died, newest last, within `DEATH_WINDOW_MS`. */
  let deaths: number[] = [];
  /** The page kept dying: no view exists until the section is opened anew. */
  let failed = false;
  const now = deps.now ?? Date.now;
  /** The origin the view was last told to load. */
  let loadedOrigin: string | null = null;
  let wasReady = daemonReady(deps.daemonStatus());
  const stopResize = deps.host.onResize(() => apply());

  function dispose(): void {
    generation += 1;
    const old = handle;
    handle = null;
    loadedOrigin = null;
    shown = false;
    if (old === null) return;
    try {
      deps.host.detach(old);
      old.dispose();
    } catch (error) {
      deps.note(`não foi possível fechar a vista das sessões: ${messageOf(error)}`);
    }
  }

  function load(target: ViewHandle): void {
    const mine = generation;
    const origin = deps.origin();
    loadedOrigin = origin;
    void (async () => {
      try {
        await deps.prepare();
      } catch {
        // Not paired: the PWA still loads and offers its own pairing screen. The caller logs the reason.
      }
      if (destroyed || generation !== mine || target.contents.isDestroyed()) return;
      try {
        await target.contents.loadURL(`${origin}/`);
      } catch (error) {
        // A load that another load replaced is not a failure; anything else is logged, and the next "daemon ready" retries.
        if (generation === mine && !target.contents.isDestroyed()) deps.note(`não foi possível carregar as sessões: ${messageOf(error)}`);
      }
    })();
  }

  function ensure(): ViewHandle {
    if (handle !== null) return handle;
    const created = deps.createView();
    handle = created;
    created.onRenderGone((reason) => {
      if (handle !== created) return;
      const at = now();
      deaths = [...deaths.filter((earlier) => at - earlier < DEATH_WINDOW_MS), at];
      // A page that died is replaced, not reloaded: it comes back at the same place if the section is on screen.
      dispose();
      if (deaths.length >= MAX_DEATHS_IN_WINDOW) {
        // A page that dies again at once will not be saved by another copy: the area goes back to the control center,
        // which says so, and the section opened anew tries once more.
        failed = true;
        deps.note(`as sessões pararam de novo (${reason}); a vista não será recriada até a seção ser aberta de novo`);
        deps.viewState('crashed');
      } else {
        deps.note(`as sessões pararam (${reason}); recriando a vista`);
      }
      apply();
    });
    created.onInput((input, consume) => {
      const section = sectionForInput(input);
      if (section === null) return;
      consume();
      deps.onShortcut(section);
    });
    deps.host.attach(created);
    load(created);
    return created;
  }

  /** Puts the view where the page said, and shows or hides it. */
  function apply(): void {
    if (destroyed) return;
    const size = deps.host.contentSize();
    const decision = decideSessionsView({
      viewport,
      daemonReady: daemonReady(deps.daemonStatus()) && !failed,
      contentSize: size ?? { width: 0, height: 0 },
    });
    if (decision.visible) {
      const target = ensure();
      if (decision.bounds !== null) target.setBounds(decision.bounds);
      target.setVisible(true);
      if (!shown) {
        shown = true;
        // The keyboard moves with the view only when the control window has it: showing or hiding the view while the user
        // works in another application must not pull the focus away.
        if (deps.host.isFocused()) target.contents.focus();
      }
      return;
    }
    if (handle !== null) {
      if (decision.bounds !== null) handle.setBounds(decision.bounds);
      handle.setVisible(false);
    }
    if (shown) {
      shown = false;
      if (deps.host.isFocused()) deps.host.focusPage();
    }
  }

  /** Sends an event to the page when it shows the daemon's own origin. True when it went out. */
  function deliver(channel: string, payload: unknown): boolean {
    if (handle === null || destroyed || !ALLOWED_EVENT_CHANNELS.has(channel) || handle.contents.isDestroyed()) return false;
    if (!isSameOrigin(handle.contents.getURL(), deps.origin())) return false;
    handle.contents.send(channel, payload);
    return true;
  }

  return {
    setViewport(next) {
      const opened = next.active && viewport?.active !== true;
      viewport = next;
      if (failed) {
        if (opened) {
          // The section was opened anew: another try, with a fresh count.
          failed = false;
          deaths = [];
          deps.viewState('ok');
        } else if (next.active) {
          // The page may have been reloaded since it was told: say it again.
          deps.viewState('crashed');
        }
      }
      apply();
    },
    onDaemonStatus(status) {
      const ready = daemonReady(status);
      const origin = deps.origin();
      if (handle !== null && ready) {
        if (loadedOrigin !== origin) {
          // The daemon moved (config.json changed its port): the old address is dead.
          load(handle);
        } else if (!wasReady) {
          // The daemon came back (a restart from Desktop, a crash): every session is stopped and the token may be new.
          load(handle);
        }
      }
      wasReady = ready;
      apply();
    },
    send(channel, payload) {
      deliver(channel, payload);
    },
    reload() {
      if (handle === null || loadedOrigin === null || handle.contents.isDestroyed()) return;
      handle.contents.reload();
    },
    languageChanged(language) {
      if (handle === null || loadedOrigin === null || destroyed || handle.contents.isDestroyed()) return 'none';
      if (handle.contents.isLoading()) {
        handle.contents.reload();
        return 'reloaded';
      }
      return deliver(EVENT_CHANNELS.language, language) ? 'sent' : 'none';
    },
    exists: () => handle !== null,
    destroy() {
      destroyed = true;
      stopResize();
      dispose();
    },
  };
}
