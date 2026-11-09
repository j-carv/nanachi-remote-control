import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { OverviewInfo } from '../../src/common/control-api.js';
import type { DaemonStatus, TailscaleStatus } from '../../src/common/types.js';
import { DiagnosticsView, type DiagnosticsViewProps } from '../../src/control/sections/DiagnosticsSection.js';
import type { DiagnosticsSnapshot } from '../../src/control/lib/diagnostics.js';
import { html } from './render-helpers.js';

const noop = (): void => undefined;

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

const ACTIVITY: OverviewInfo['activity'] = { workspaces: 2, sessions: 5, busySessions: 1, devices: 3 };

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    generatedAt: Date.UTC(2026, 10, 6, 12, 0, 0),
    appVersion: '0.4.0',
    platform: 'Win32',
    dataFolder: 'C:\\Users\\sample-user\\AppData\\Roaming\\Nanachi',
    daemon: DAEMON,
    tailscale: RUNNING,
    activity: ACTIVITY,
    overviewSyncedAt: Date.UTC(2026, 10, 6, 11, 58, 0),
    daemonEventAt: null,
    logLines: ['started', '{"token":"9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0"}'],
    ...overrides,
  };
}

function view(overrides: Partial<DiagnosticsViewProps> = {}): string {
  const props: DiagnosticsViewProps = { snapshot: snapshot(), logsLoading: false, refreshing: false, onRefresh: noop, ...overrides };
  return html(createElement(DiagnosticsView, props), 'en');
}

describe('diagnostics page', () => {
  it('shows the groups with their English labels', () => {
    const markup = view();
    for (const label of ['App', 'Daemon', 'Tailscale', 'Reachability', 'Activity', 'Sync', 'Last log lines']) expect(markup).toContain(`>${label}<`);
    for (const label of ['Port', 'Process ID', 'DNS name', 'Built-in node', 'Address for your mobile device', 'Workspaces', 'Paired devices']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('office-pc.tail1234.ts.net');
    expect(markup).toContain('https://office-pc.tail1234.ts.net');
    expect(markup).toContain('0.4.0');
  });

  it('says the phone address is not available when the node is not running', () => {
    const markup = view({ snapshot: snapshot({ tailscale: { state: 'off' } }) });
    expect(markup).toContain('Not available');
    expect(markup).not.toContain('https://office-pc');
  });

  it('shows the log lines redacted, as the report does', () => {
    const markup = view();
    expect(markup).toContain('&quot;token&quot;:&quot;&lt;redacted&gt;&quot;');
    expect(markup).not.toContain('9f8e7d6c5b4a');
  });

  it('shows a skeleton while the log lines load and a calm note when they cannot be read', () => {
    expect(view({ snapshot: snapshot({ logLines: null }), logsLoading: true })).toContain('aria-busy="true"');
    const failed = view({ snapshot: snapshot({ logLines: null }), logsLoading: false });
    expect(failed).toContain('The log could not be read right now.');
  });

  it('says the activity numbers are not available when the daemon did not answer', () => {
    const markup = view({ snapshot: snapshot({ activity: null }) });
    expect(markup).toContain('Activity numbers are not available right now');
  });

  it('has a Refresh button that is busy while it runs', () => {
    expect(view()).toContain('Refresh');
    expect(view({ refreshing: true })).toMatch(/aria-busy="true"|disabled=""/);
  });
});
