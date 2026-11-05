import { CONTROL_SECTIONS, type ControlSection, type SessionsViewState } from '../../common/control-api.js';
import { daemonReady } from '../../common/daemon-ready.js';
import type { DaemonStatus } from '../../common/types.js';

/**
 * What the Sessões section shows. `ready` means main draws the PWA over the content area; every other state is the control
 * center's own explanation, because the PWA could only show a connection error there. `null` (the first status has not
 * arrived) counts as starting. `crashed` is a ready daemon whose PWA page kept dying (`viewState`): main stopped replacing it
 * until the section is opened again.
 */
export type SessionsState = 'ready' | 'crashed' | 'starting' | 'stopped' | 'error' | 'restricted';

export function sessionsState(daemon: DaemonStatus | null, viewState: SessionsViewState = 'ok'): SessionsState {
  if (daemon === null) return 'starting';
  if (daemonReady(daemon)) return viewState === 'crashed' ? 'crashed' : 'ready';
  // A daemon that answers but refuses this PC is its own explanation, whatever its state word says.
  if (daemon.restricted) return 'restricted';
  switch (daemon.state) {
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    case 'starting':
    case 'running':
    case 'attached':
      return 'starting';
  }
}

/**
 * Whether the section tells main it is on screen (`SessionsViewport.active`). A crashed view still does: main hides it and
 * keeps the area free, and the report of the section being opened anew is what makes it try again.
 */
export function sessionsViewWanted(state: SessionsState): boolean {
  return state === 'ready' || state === 'crashed';
}

/** The section a window was opened on (`?section=sessions`, set by main for the tray's "Abrir sessões"); anything else is the overview. */
export function initialSection(search: string): ControlSection {
  const requested = new URLSearchParams(search).get('section');
  return CONTROL_SECTIONS.find((section) => section === requested) ?? 'overview';
}
