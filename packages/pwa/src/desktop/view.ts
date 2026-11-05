import type { StatusTone } from '../components/StatusDot.js';
import { t } from '../i18n/index.js';
import type { DaemonStatus, TailscaleStatus, UpdateCheckResult } from './schema.js';

/** Shown when the daemon answers but refuses this PC because `allowedTailscaleLogins` is set. */
export function restrictedText(): string {
  return t('desktop:daemon.restrictedText');
}

export interface DaemonView {
  tone: StatusTone;
  /** The status dot pulses while something is starting. */
  pulse: boolean;
  title: string;
  /** One quiet line under the title. */
  detail: string | null;
  /** Text for an error block: a daemon that failed, or one this PC cannot use. */
  problem: string | null;
  /** Last log lines, only when the daemon failed. */
  logTail: readonly string[];
}

function portLine(status: DaemonStatus): string {
  return status.version === null
    ? t('desktop:daemon.port', { port: status.port })
    : t('desktop:daemon.portVersion', { port: status.port, version: status.version });
}

/** What the "Daemon" row says for each status the main process can report. */
export function describeDaemon(status: DaemonStatus): DaemonView {
  const none = { pulse: false, problem: null, logTail: [] as readonly string[] };
  if (status.restricted && (status.state === 'running' || status.state === 'attached')) {
    return {
      ...none,
      tone: 'attention',
      title: t('desktop:daemon.restricted'),
      detail: portLine(status),
      problem: status.message ?? restrictedText(),
    };
  }
  switch (status.state) {
    case 'starting':
      return { ...none, tone: 'running', pulse: true, title: t('desktop:daemon.starting'), detail: status.message };
    case 'running':
      return { ...none, tone: 'success', title: t('desktop:daemon.running'), detail: portLine(status) };
    case 'attached':
      return {
        ...none,
        tone: 'success',
        title: t('desktop:daemon.attached'),
        detail: t('desktop:daemon.attachedDetail', { line: portLine(status) }),
      };
    case 'stopped':
      return { ...none, tone: 'muted', title: t('desktop:daemon.stopped'), detail: null };
    case 'error':
      return {
        ...none,
        tone: 'danger',
        title: t('desktop:daemon.error'),
        detail: null,
        problem: status.message ?? t('desktop:daemon.notRunning'),
        logTail: status.logTail,
      };
  }
}

/** `https://<dnsName>`: the address of the embedded node. A trailing dot of a DNS name is dropped. */
export function tailscaleAddress(dnsName: string): string {
  return `https://${dnsName.replace(/\.$/, '')}`;
}

export interface TailscaleView {
  /** The "Tailscale embutido" switch: on whenever the user asked for it, whatever the node is doing. */
  checked: boolean;
  tone: StatusTone;
  pulse: boolean;
  title: string;
  detail: string | null;
  /** Login link, only while the node waits for the account. */
  authUrl: string | null;
  /** Address to open on the phone, only while the node serves. */
  address: string | null;
  /** The message of a failure, for an error block. */
  problem: string | null;
}

export function describeTailscale(status: TailscaleStatus): TailscaleView {
  const base = { authUrl: null, address: null, problem: null, pulse: false, detail: null };
  switch (status.state) {
    case 'off':
      return { ...base, checked: false, tone: 'muted', title: t('desktop:tailscale.off') };
    case 'starting':
      return { ...base, checked: true, tone: 'running', pulse: true, title: t('desktop:tailscale.starting') };
    case 'needs_login':
      return {
        ...base,
        checked: true,
        tone: 'attention',
        title: t('desktop:tailscale.needsLogin'),
        detail: t('desktop:tailscale.needsLoginDetail'),
        authUrl: status.authUrl,
      };
    case 'running':
      return {
        ...base,
        checked: true,
        tone: 'success',
        title: t('desktop:tailscale.connected'),
        detail: status.tailnet === '' ? null : t('desktop:tailscale.tailnet', { name: status.tailnet }),
        address: tailscaleAddress(status.dnsName),
      };
    case 'error':
      return { ...base, checked: true, tone: 'danger', title: t('desktop:tailscale.error'), problem: status.message };
  }
}

/** The short instructions for the phone, once the node serves. */
export function phoneSteps(address: string): readonly string[] {
  return [
    t('desktop:tailscale.steps.install'),
    t('desktop:tailscale.steps.open', { address }),
    t('desktop:tailscale.steps.code'),
    t('desktop:tailscale.steps.share'),
  ];
}

/** `123456` as `123 456`, easier to read and to type on the phone. */
export function formatPairingCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export interface PairingCountdown {
  expired: boolean;
  /** `Expira em 4:12` / `Expires in 4:12`, or `Expirou` / `Expired`. */
  label: string;
}

export function pairingCountdown(expiresAt: number, now: number): PairingCountdown {
  const remainingSeconds = Math.ceil((expiresAt - now) / 1000);
  if (remainingSeconds <= 0) return { expired: true, label: t('desktop:pairing.expired') };
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, '0');
  return { expired: false, label: t('desktop:pairing.expiresIn', { time: `${minutes}:${seconds}` }) };
}

export interface UpdateView {
  /** Second line of the "Procurar atualização" ("Check for updates") row. */
  summary: string;
  tone: StatusTone;
  /** A release page to open in the browser, only when a newer version exists. */
  link: { label: string; url: string } | null;
}

export function describeUpdate(version: string, result: UpdateCheckResult | null, checking: boolean): UpdateView {
  if (checking) return { summary: t('desktop:update.checking'), tone: 'muted', link: null };
  if (result === null) return { summary: t('desktop:update.version', { version }), tone: 'muted', link: null };
  switch (result.status) {
    case 'up-to-date':
      return { summary: t('desktop:update.upToDate', { current: result.current }), tone: 'muted', link: null };
    case 'available':
      return {
        summary: t('desktop:update.available', { current: result.current, latest: result.latest }),
        tone: 'attention',
        link: { label: t('desktop:update.availableLink', { latest: result.latest }), url: result.url },
      };
    case 'error':
      return { summary: t('desktop:update.error', { current: result.current, message: result.message }), tone: 'danger', link: null };
  }
}
