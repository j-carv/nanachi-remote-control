import type { OverviewInfo } from '../../common/control-api.js';
import type { DaemonStatus, TailscaleStatus } from '../../common/types.js';

/**
 * The Diagnostics section: what its page shows and what its "Copy report" button copies. The report is plain text in English
 * only, for a bug report or a support message: its labels are fixed English words, so it reads the same whatever the app
 * language is. The page shows the same redacted log lines, so a screenshot of the page does not show a secret that the report
 * would hide.
 *
 * Redaction is one pass of patterns over the text, applied to the whole report (which covers each log line too). It removes
 * tokens, pairing codes, e-mail addresses, push subscription keys and the user name in profile paths. It keeps the tailnet name
 * and the IP addresses on purpose: they are what someone needs to find the node, and they are not secrets.
 */

/** How many of the newest daemon log lines the page and the report show. */
export const DIAGNOSTIC_LOG_LINES = 20;

export interface DiagnosticsSnapshot {
  /** When the report is made, epoch ms. */
  generatedAt: number;
  appVersion: string;
  /** The platform name the window reports (`Win32` on Windows), or null when the window cannot tell. */
  platform: string | null;
  dataFolder: string;
  daemon: DaemonStatus;
  tailscale: TailscaleStatus;
  /** Null when the daemon could not be asked. */
  activity: OverviewInfo['activity'];
  /** When the overview last came back from main, epoch ms; null before the first answer. */
  overviewSyncedAt: number | null;
  /** When the daemon status last arrived as an event, epoch ms; null before the first event. */
  daemonEventAt: number | null;
  /** The daemon log, oldest line first; null when it could not be read. */
  logLines: readonly string[] | null;
}

/**
 * The redaction rules, in order. Each rule keeps the name of what it hides (`token:`, `Authorization:`, `code`), so the text
 * still says what was there. Each replacement is written so that a second pass gives the same text: `redactSecrets` is
 * idempotent, and the tests check it.
 */
const REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // The pairing secret of a link: everything after `#pair=`, in any URL.
  [/#pair=(?!<redacted>)[^\s"'<>]+/gi, '#pair=<redacted>'],
  // Push subscriptions: the endpoint of a push service, the `endpoint` field, and the `p256dh` and `auth` keys.
  [/https?:\/\/(?:[\w-]+\.)*(?:fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)(?:\/[^\s"'<>]*)?/gi, '<redacted-push-endpoint>'],
  [/(["']?endpoint["']?\s*[:=]\s*["']?)https?:\/\/[^\s"'<>]+/gi, '$1<redacted-push-endpoint>'],
  [/(["']?(?:p256dh|auth)["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-+\/=]{16,}/gi, '$1<redacted>'],
  // Authorization headers, and their JSON form: the whole value after the name, scheme included (`Bearer`, `Basic`).
  [/(\bauthorization["']?\s*[:=]\s*["']?)[^\r\n"',;}\]]+/gi, '$1<redacted>'],
  // A bearer token on its own.
  [/(\bbearer\s+)[A-Za-z0-9._~+\/-]{20,}=*/gi, '$1<redacted>'],
  // A secret under a name that says what it is: `token: x`, `"accessToken":"x"`, `apiKey=x`, `password=x`, `code=x`.
  [/([A-Za-z_]*(?:token|secret|passw(?:or)?d|key|code)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+\/-]{20,}=*/gi, '$1<redacted>'],
  // A pairing code: six digits next to the word, in English, Portuguese or Spanish.
  [/(\b(?:pairing|pair|code|c[oó]digo|pareamento|emparejamiento)\b["']?\s*[:=]?\s*["']?)\d{6}(?!\d)/gi, '$1<redacted>'],
  // JSON Web Tokens: three base64url parts, the first one starting with `eyJ`.
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<redacted>'],
  // A long hex string, such as a 64-character device token or a hash. UUIDs are shorter per group, so they stay.
  [/\b[0-9a-f]{40,}\b/gi, '<redacted>'],
  // E-mail addresses, such as the login a tailnet is named after.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<redacted-email>'],
  // The Windows user name in a profile path: `C:\Users\<name>\` keeps the folders and hides the name.
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n"']+/gi, '$1<user>'],
];

/** The text with every secret, e-mail address and profile user name replaced by a marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTION_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** The newest log lines, redacted: what the page shows and what the report copies. */
export function shownLogLines(lines: readonly string[]): string[] {
  return lines.slice(-DIAGNOSTIC_LOG_LINES).map(redactSecrets);
}

/** The address a phone uses to reach the daemon, when the embedded Tailscale node is running. */
export function reachabilityAddress(tailscale: TailscaleStatus): string | null {
  return tailscale.state === 'running' ? `https://${tailscale.dnsName}` : null;
}

function instant(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString();
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** One `Label: value` line. A value is kept on one line, so a multi-line message cannot break the layout of the report. */
function field(label: string, value: string): string {
  return `  ${label}: ${value.replace(/\s*[\r\n]+\s*/g, ' ').trim()}`;
}

function tailscaleDetails(tailscale: TailscaleStatus): string[] {
  switch (tailscale.state) {
    case 'running':
      return [field('DNS name', tailscale.dnsName), field('Tailnet', tailscale.tailnet), field('IP addresses', tailscale.ips.join(', ') || 'none')];
    case 'error':
      return [field('Error message', tailscale.message)];
    case 'off':
    case 'starting':
    case 'needs_login':
      return [];
  }
}

function activityLines(activity: OverviewInfo['activity']): string[] {
  if (activity === null) {
    return [field('Workspaces', 'not available'), field('Sessions', 'not available'), field('In progress', 'not available'), field('Paired devices', 'not available')];
  }
  return [
    field('Workspaces', String(activity.workspaces)),
    field('Sessions', String(activity.sessions)),
    field('In progress', String(activity.busySessions)),
    field('Paired devices', String(activity.devices)),
  ];
}

function logBlock(lines: readonly string[] | null): string[] {
  if (lines === null) return ['  not available'];
  const shown = shownLogLines(lines);
  return shown.length === 0 ? ['  none'] : shown.map((line) => `  ${line}`);
}

/**
 * The report as plain English text, redacted as a whole. The timestamp is UTC (ISO 8601), so the report reads the same on
 * any machine. Each section is a heading and indented `Label: value` lines.
 */
export function buildDiagnosticsReport(snapshot: DiagnosticsSnapshot): string {
  const { daemon, tailscale } = snapshot;
  const lines: string[] = [
    'Nanachi Desktop diagnostics',
    `Generated: ${new Date(snapshot.generatedAt).toISOString()}`,
    '',
    'App',
    field('Version', snapshot.appVersion),
    field('Platform', snapshot.platform ?? 'unknown'),
    field('Data folder', snapshot.dataFolder),
    '',
    'Daemon',
    field('State', daemon.state),
    field('Port', String(daemon.port)),
    field('Mode', daemon.mode),
    field('Process ID', daemon.pid === null ? 'none' : String(daemon.pid)),
    field('Version', daemon.version ?? 'unknown'),
    field('Local access blocked', yesNo(daemon.restricted)),
    field('Machine name', daemon.machineName ?? 'unknown'),
    field('Last message', daemon.message ?? 'none'),
    '',
    'Tailscale',
    field('State', tailscale.state),
    ...tailscaleDetails(tailscale),
    field('Built-in node', 'yes (a separate tailnet device; the Windows Tailscale is not used)'),
    '',
    'Reachability',
    field('Phone address', reachabilityAddress(tailscale) ?? 'not available'),
    '',
    'Activity',
    ...activityLines(snapshot.activity),
    '',
    'Sync',
    field('Last overview refresh', instant(snapshot.overviewSyncedAt)),
    field('Last daemon status event', instant(snapshot.daemonEventAt)),
    '',
    `Last log lines (daemon log, newest last, at most ${DIAGNOSTIC_LOG_LINES})`,
    ...logBlock(snapshot.logLines),
  ];
  return `${redactSecrets(lines.join('\n'))}\n`;
}
