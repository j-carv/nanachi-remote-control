import { describe, expect, it } from 'vitest';
import type { DaemonStatus, TailscaleStatus } from '../../src/common/types.js';
import {
  buildDiagnosticsReport,
  DIAGNOSTIC_LOG_LINES,
  reachabilityAddress,
  redactSecrets,
  shownLogLines,
  type DiagnosticsSnapshot,
} from '../../src/control/lib/diagnostics.js';

/** Synthetic secrets: none of them is a real credential. */
const TOKEN = 'AbC-dEf_123.ghiJKL456mnoPQR789';
const HEX64 = '9f8e7d6c5b4a39281706f5e4d3c2b1a0'.repeat(2);
const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('redactSecrets', () => {
  it.each([
    ['a token in a JSON log line', `{"level":30,"msg":"device paired","token":"${HEX64}"}`, '{"level":30,"msg":"device paired","token":"<redacted>"}'],
    ['a camelCase token key', `{"accessToken":"${TOKEN}","ok":true}`, '{"accessToken":"<redacted>","ok":true}'],
    ['an Authorization header', `Authorization: Bearer ${TOKEN}`, 'Authorization: <redacted>'],
    ['an Authorization header with no space after the colon', `Authorization:Bearer ${TOKEN}`, 'Authorization:<redacted>'],
    ['an Authorization header in JSON', `{"authorization":"Basic dXNlcjpzZWNyZXQ=","x":1}`, '{"authorization":"<redacted>","x":1}'],
    ['a pairing code written in Portuguese', 'código de pareamento: 482913', 'código de pareamento: <redacted>'],
    ['a pair parameter', 'pair=482913&device=1', 'pair=<redacted>&device=1'],
    ['a bearer token on its own', `sent Bearer ${TOKEN} to the daemon`, 'sent Bearer <redacted> to the daemon'],
    [
      'a pairing link with its fragment',
      'open https://office-pc.tail1234.ts.net:7780/#pair=eyJhbGciOiJIUzI1NiJ9abc',
      'open https://office-pc.tail1234.ts.net:7780/#pair=<redacted>',
    ],
    ['a pairing code in a sentence', 'pairing code 482913 issued', 'pairing code <redacted> issued'],
    ['a pairing code in JSON', '{"code":"482913","expiresAt":1}', '{"code":"<redacted>","expiresAt":1}'],
    ['an e-mail address', 'tailnet joao.silva@example.com', 'tailnet <redacted-email>'],
    ['a Windows user folder', 'C:\\Users\\sample-user\\AppData\\Roaming\\Nanachi\\config.json', 'C:\\Users\\<user>\\AppData\\Roaming\\Nanachi\\config.json'],
    ['a user folder with spaces and forward slashes', 'C:/Users/João Silva/OneDrive/x', 'C:/Users/<user>/OneDrive/x'],
    ['a user folder escaped in JSON', '{"home":"C:\\\\Users\\\\sample-user\\\\.nanachi"}', '{"home":"C:\\\\Users\\\\<user>\\\\.nanachi"}'],
    ['a 64-character hex string', `hash ${HEX64}`, 'hash <redacted>'],
    [
      'a push endpoint',
      '{"endpoint":"https://fcm.googleapis.com/fcm/send/cXyZ123","keys":{}}',
      '{"endpoint":"<redacted-push-endpoint>","keys":{}}',
    ],
    [
      'push subscription keys',
      '{"p256dh":"BNcRdreALRFXTkOOUHK5abc","auth":"tBHItJI5svbpez7KI4CCXg"}',
      '{"p256dh":"<redacted>","auth":"<redacted>"}',
    ],
  ])('redacts %s', (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    `session ${SESSION_ID} started in C:\\Projetos\\app`,
    `sessionId=${SESSION_ID} state=idle`,
    'keyboard layout and tokenizer ready, 2 workspaces',
    'Authentication failed for 2 accounts',
    'bearer authentication was refused',
    'the code is ready for review',
    'Paired devices: 3',
  ])('leaves ordinary text alone: %s', (line) => {
    expect(redactSecrets(line)).toBe(line);
  });

  it('is idempotent, so a line redacted twice reads the same', () => {
    const samples = [
      `{"token":"${HEX64}"}`,
      `Authorization: Bearer ${TOKEN}`,
      'open https://office-pc.tail1234.ts.net:7780/#pair=ABC123',
      'pairing code 482913 and joao.silva@example.com',
      'C:\\Users\\sample-user\\x',
      `session ${SESSION_ID}`,
    ];
    for (const sample of samples) {
      const once = redactSecrets(sample);
      expect(redactSecrets(once), sample).toBe(once);
    }
  });
});

describe('reachabilityAddress', () => {
  it('is the HTTPS address of a running node', () => {
    expect(reachabilityAddress({ state: 'running', dnsName: 'office-pc.tail1234.ts.net', tailnet: 'tail1234.ts.net', ips: [] })).toBe(
      'https://office-pc.tail1234.ts.net',
    );
  });

  it.each<TailscaleStatus>([{ state: 'off' }, { state: 'starting' }, { state: 'needs_login', authUrl: 'https://login.tailscale.com/a/x' }, { state: 'error', message: 'boom' }])(
    'is null when the node is not running (%j)',
    (status) => {
      expect(reachabilityAddress(status)).toBeNull();
    },
  );
});

const DAEMON: DaemonStatus = {
  state: 'running',
  port: 7780,
  mode: 'spawned',
  pid: 4242,
  version: '0.4.0',
  machineName: 'OFFICE-PC',
  restricted: false,
  message: null,
  logTail: [],
};

const RUNNING: TailscaleStatus = { state: 'running', dnsName: 'office-pc.tail1234.ts.net', tailnet: 'tail1234.ts.net', ips: ['100.101.102.103'] };

const ADVERSARIAL_LOG = [
  `{"level":30,"time":1762430400000,"msg":"device paired","token":"${HEX64}"}`,
  `Authorization: Bearer ${TOKEN}`,
  'pairing link https://office-pc.tail1234.ts.net:7780/#pair=ABC123secret',
  'pairing code 482913 issued to joao.silva@example.com',
  'loading C:\\Users\\sample-user\\AppData\\Roaming\\Nanachi\\config.json',
  '{"endpoint":"https://fcm.googleapis.com/fcm/send/cXyZ123","keys":{"p256dh":"BNcRdreALRFXTkOOUHK5abc","auth":"tBHItJI5svbpez7KI4CCXg"}}',
  `session ${SESSION_ID} started`,
];

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    generatedAt: Date.UTC(2026, 10, 6, 12, 0, 0),
    appVersion: '0.4.0',
    platform: 'Win32',
    dataFolder: 'C:\\Users\\sample-user\\AppData\\Roaming\\Nanachi',
    daemon: DAEMON,
    tailscale: RUNNING,
    activity: { workspaces: 2, sessions: 5, busySessions: 1, devices: 3 },
    overviewSyncedAt: Date.UTC(2026, 10, 6, 11, 58, 0),
    daemonEventAt: null,
    // 22 lines: the first two are older than the 20 the report keeps.
    logLines: [...Array.from({ length: 2 }, (_, index) => `old ${index}`), ...ADVERSARIAL_LOG, ...Array.from({ length: 13 }, (_, index) => `recent ${index}`)],
    ...overrides,
  };
}

describe('shownLogLines', () => {
  it('keeps the newest lines only, redacted', () => {
    expect(DIAGNOSTIC_LOG_LINES).toBe(20);
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index}`);
    const shown = shownLogLines(lines);
    expect(shown).toHaveLength(20);
    expect(shown[0]).toBe('line 5');
    expect(shownLogLines([`token: ${TOKEN}`])).toEqual(['token: <redacted>']);
  });
});

describe('buildDiagnosticsReport', () => {
  it('has the title, the timestamp and the sections in order', () => {
    const report = buildDiagnosticsReport(snapshot());
    expect(report.startsWith('Nanachi Desktop diagnostics')).toBe(true);
    expect(report).toContain('Generated: 2026-11-06T12:00:00.000Z');
    expect(report).toContain('Version: 0.4.0');
    expect(report).toContain('Platform: Win32');
    const order = ['\nApp\n', '\nDaemon\n', '\nTailscale\n', '\nReachability\n', '\nActivity\n', '\nSync\n', '\nLast log lines'].map((heading) => report.indexOf(heading));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('gives the phone address of a running node, and says so when there is none', () => {
    expect(buildDiagnosticsReport(snapshot())).toContain('Phone address: https://office-pc.tail1234.ts.net');
    const off = buildDiagnosticsReport(snapshot({ tailscale: { state: 'off' }, logLines: null }));
    expect(off).toContain('Phone address: not available');
    expect(off).not.toContain('DNS name:');
  });

  it('says when the activity and the logs could not be read', () => {
    const report = buildDiagnosticsReport(snapshot({ activity: null, logLines: null }));
    expect(report).toContain('Workspaces: not available');
    expect(report).toContain('Last log lines');
    expect(report).toContain('  not available');
  });

  it('keeps no token, pairing code, e-mail address, push key or user name from the adversarial snapshot', () => {
    const report = buildDiagnosticsReport(
      snapshot({
        daemon: { ...DAEMON, state: 'error', message: `Start failed: token=${TOKEN}` },
        tailscale: { ...RUNNING, tailnet: 'joao.silva@example.com' },
      }),
    );
    for (const secret of [TOKEN, HEX64, 'ABC123secret', '482913', 'joao', 'sample-user', 'fcm.googleapis.com', 'BNcRdreALRFXTkOOUHK5abc', 'tBHItJI5svbpez7KI4CCXg']) {
      expect(report, secret).not.toContain(secret);
    }
    expect(report).toContain('Last message: Start failed: token=<redacted>');
    expect(report).toContain('Tailnet: <redacted-email>');
    expect(report).toContain('Data folder: C:\\Users\\<user>\\AppData\\Roaming\\Nanachi');
  });

  it('shows the newest log lines only, each one exactly as the redaction gives it', () => {
    const report = buildDiagnosticsReport(snapshot());
    expect(report).not.toContain('old 0');
    expect(report).not.toContain('old 1');
    for (const line of ADVERSARIAL_LOG) expect(report).toContain(redactSecrets(line));
    expect(report).toContain('"token":"<redacted>"');
    expect(report).toContain('Authorization: <redacted>');
    expect(report).toContain('#pair=<redacted>');
    expect(report).toContain('pairing code <redacted> issued to <redacted-email>');
    expect(report).toContain(`session ${SESSION_ID} started`);
  });
});
