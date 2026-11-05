import type { TFunction } from 'i18next';
import type { DaemonStatus, TailscaleStatus } from '../../common/types.js';

/** `muted` is the neutral grey; the others are the status tokens of docs/DESIGN.md. */
export type Tone = 'success' | 'running' | 'attention' | 'destructive' | 'muted';

export interface StatusSummary {
  /** One word, for the title bar and badges. */
  word: string;
  tone: Tone;
  /** Transitional state: the dot pulses (stops under reduced motion). */
  pulse: boolean;
  /** One short line for the overview. */
  detail: string;
}

/** The `t` of the control namespace (a helper outside React gets it from its caller). */
type T = TFunction<'control'>;

export function daemonSummary(status: DaemonStatus, t: T): StatusSummary {
  switch (status.state) {
    case 'running':
      return {
        word: t('status.daemon.running.word'),
        tone: status.restricted ? 'attention' : 'success',
        pulse: false,
        detail: t('status.daemon.running.detail'),
      };
    case 'attached':
      return {
        word: t('status.daemon.attached.word'),
        tone: status.restricted ? 'attention' : 'running',
        pulse: false,
        detail: t('status.daemon.attached.detail'),
      };
    case 'starting':
      return { word: t('status.daemon.starting.word'), tone: 'attention', pulse: true, detail: t('status.daemon.starting.detail') };
    case 'stopped':
      return { word: t('status.daemon.stopped.word'), tone: 'muted', pulse: false, detail: t('status.daemon.stopped.detail') };
    case 'error':
      return { word: t('status.daemon.error.word'), tone: 'destructive', pulse: false, detail: status.message ?? t('status.daemon.error.detail') };
  }
}

export function tailscaleSummary(status: TailscaleStatus, t: T): StatusSummary {
  switch (status.state) {
    case 'off':
      return { word: t('status.tailscale.off.word'), tone: 'muted', pulse: false, detail: t('status.tailscale.off.detail') };
    case 'starting':
      return { word: t('status.tailscale.starting.word'), tone: 'attention', pulse: true, detail: t('status.tailscale.starting.detail') };
    case 'needs_login':
      return { word: t('status.tailscale.needsLogin.word'), tone: 'attention', pulse: false, detail: t('status.tailscale.needsLogin.detail') };
    case 'running':
      return { word: t('status.tailscale.running.word'), tone: 'success', pulse: false, detail: status.dnsName };
    case 'error':
      return { word: t('status.tailscale.error.word'), tone: 'destructive', pulse: false, detail: status.message };
  }
}
