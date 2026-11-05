import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { DesktopPanelView, DesktopSection, type DesktopPanelViewProps } from './DesktopSection.js';
import { PairingCodeBody } from './PairingCodeSheet.js';
import type { DaemonStatus, TailscaleStatus } from './schema.js';

const DAEMON: DaemonStatus = {
  state: 'running',
  port: 7811,
  mode: 'spawned',
  pid: 4242,
  version: '1.2.3',
  machineName: 'PC',
  restricted: false,
  message: null,
  logTail: [],
};

const noop = (): void => undefined;

function props(overrides: Partial<DesktopPanelViewProps> = {}): DesktopPanelViewProps {
  return {
    version: '0.1.0',
    daemon: DAEMON,
    autostart: false,
    autostartBusy: false,
    tailscale: { state: 'off' },
    tailscaleBusy: false,
    update: null,
    checking: false,
    failure: null,
    onAutostart: noop,
    onPairing: noop,
    onCheckUpdate: noop,
    onTailscale: noop,
    ...overrides,
  };
}

const render = (overrides: Partial<DesktopPanelViewProps> = {}): string =>
  renderToStaticMarkup(createElement(DesktopPanelView, props(overrides)));

describe('DesktopSection outside Nanachi Desktop', () => {
  it('renders nothing when window.nanachiDesktop does not exist', () => {
    expect(renderToStaticMarkup(createElement(DesktopSection))).toBe('');
  });
});

describe('the Desktop group', () => {
  it('has the heading and the four rows of the contract', () => {
    const html = render();
    expect(html).toContain('data-slot="desktop-section"');
    expect(html).toMatch(/<h2[^>]*>.*Desktop<\/h2>/);
    expect(html).toContain('data-slot="desktop-daemon"');
    expect(html).toContain('Iniciar com o Windows');
    expect(html).toContain('Gerar código de pareamento');
    expect(html).toContain('Procurar atualização');
    expect(html).toContain('Tailscale embutido');
  });

  it('shows the daemon status with its tone and port', () => {
    const html = render();
    expect(html).toContain('data-state="running"');
    expect(html).toContain('Rodando');
    expect(html).toContain('Porta 7811 · versão 1.2.3');
    expect(html).not.toContain('data-slot="desktop-daemon-problem"');
  });

  it('says it is still asking while the status has not arrived', () => {
    const html = render({ daemon: null, tailscale: null, autostart: null });
    expect(html).toContain('Consultando…');
    expect(html).toContain('data-state="unknown"');
  });

  it('restricted: explains why the local panel cannot use the daemon', () => {
    const html = render({ daemon: { ...DAEMON, restricted: true } });
    expect(html).toContain('Acesso local bloqueado');
    expect(html).toContain('allowedTailscaleLogins');
    expect(html).toContain('data-slot="desktop-daemon-problem"');
  });

  it('error: shows the message and the last log lines', () => {
    const html = render({ daemon: { ...DAEMON, state: 'error', message: 'O daemon caiu 6 vezes.', logTail: ['Error: EADDRINUSE', 'boom'] } });
    expect(html).toContain('O daemon caiu 6 vezes.');
    expect(html).toContain('Últimas linhas do log do daemon');
    expect(html).toContain('Error: EADDRINUSE');
  });

  it('the autostart switch reflects the setting and is off until it is known', () => {
    expect(render({ autostart: true })).toMatch(/role="switch" aria-checked="true"/);
    const unknown = render({ autostart: null });
    expect(unknown).toMatch(/role="switch"[^>]*disabled/);
  });

  it('update row: idle shows the version, an available release shows a safe link', () => {
    expect(render()).toContain('Versão 0.1.0');
    const html = render({
      update: { status: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v0.2.0' },
    });
    expect(html).toContain('Nova versão 0.2.0');
    expect(html).toMatch(/<a[^>]*href="https:\/\/github\.com\/j-carv\/nanachi-remote-control\/releases\/tag\/v0\.2\.0"[^>]*rel="noopener noreferrer"/);
    expect(html).toContain('target="_blank"');
  });

  it('shows the failure of an action', () => {
    expect(render({ failure: 'action' })).toContain('Não consegui concluir isso agora.');
  });
});

describe('the Tailscale card', () => {
  const running: TailscaleStatus = { state: 'running', dnsName: 'nanachi-office-pc.tail1234.ts.net', tailnet: 'user@example.com', ips: ['100.64.0.5'] };

  it('off: only the switch, and nothing about the phone', () => {
    const html = render();
    expect(html).not.toContain('data-slot="desktop-tailscale-status"');
    expect(html).not.toContain('desktop-tailscale-address');
    expect(html).not.toContain('desktop-tailscale-login');
  });

  it('on and starting: the switch is checked and the status says so', () => {
    const html = render({ tailscale: { state: 'starting' } });
    expect(html).toContain('data-slot="desktop-tailscale-status"');
    expect(html).toContain('Iniciando…');
  });

  it('needs_login: a link that opens the auth URL outside the app', () => {
    const html = render({ tailscale: { state: 'needs_login', authUrl: 'https://login.tailscale.com/a/abc123' } });
    expect(html).toMatch(/<a[^>]*href="https:\/\/login\.tailscale\.com\/a\/abc123"[^>]*>/);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Entrar no Tailscale');
    expect(html).toContain('Falta entrar na sua conta do Tailscale');
  });

  it('running: the https address, a copy button and the phone steps', () => {
    const html = render({ tailscale: running });
    expect(html).toContain('data-slot="desktop-tailscale-address"');
    expect(html).toContain('https://nanachi-office-pc.tail1234.ts.net');
    expect(html).toContain('data-slot="copy-button"');
    expect(html).toContain('Instale o app Tailscale no dispositivo móvel');
    expect(html).toContain('Adicionar à Tela de Início');
    expect(html).toContain('MagicDNS');
    expect(html).not.toContain('desktop-tailscale-login');
  });

  it('error: the message of the sidecar in an alert block', () => {
    const html = render({ tailscale: { state: 'error', message: 'HTTPS não está habilitado na tailnet' } });
    expect(html).toContain('HTTPS não está habilitado na tailnet');
    expect(html).toContain('role="alert"');
  });

  it('uses no emoji', () => {
    const html = render({ tailscale: running, update: { status: 'up-to-date', current: '0.1.0' } });
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('PairingCodeBody', () => {
  const now = 1_700_000_000_000;

  it('shows the code in two groups with a countdown', () => {
    const html = renderToStaticMarkup(createElement(PairingCodeBody, { code: { code: '123456', expiresAt: now + 252_000 }, loading: false, failed: false, now }));
    expect(html).toContain('123 456');
    expect(html).toContain('aria-label="Código 1 2 3 4 5 6"');
    expect(html).toContain('Expira em 4:12');
    expect(html).toContain('data-expired="false"');
  });

  it('marks an expired code', () => {
    const html = renderToStaticMarkup(createElement(PairingCodeBody, { code: { code: '123456', expiresAt: now - 1000 }, loading: false, failed: false, now }));
    expect(html).toContain('Expirou');
    expect(html).toContain('data-expired="true"');
  });

  it('loading and failure', () => {
    const loading = renderToStaticMarkup(createElement(PairingCodeBody, { code: null, loading: true, failed: false, now }));
    expect(loading).toContain('Gerando o código…');
    const failed = renderToStaticMarkup(createElement(PairingCodeBody, { code: null, loading: false, failed: true, now }));
    expect(failed).toContain('Não consegui gerar o código agora.');
    expect(failed).toContain('role="alert"');
  });
});

describe('the Desktop group in English', () => {
  it('names the rows of the group', () => {
    setLanguage('en');
    const html = render();
    expect(html).toMatch(/<h2[^>]*>.*Desktop<\/h2>/);
    expect(html).toContain('Start with Windows');
    expect(html).toContain('Nanachi opens in the tray when you sign in to Windows.');
    expect(html).toContain('Generate pairing code');
    expect(html).toContain('To pair a mobile device or another browser with this PC.');
    expect(html).toContain('Check for updates');
    expect(html).toContain('Built-in Tailscale');
    expect(html).toContain('This PC joins your tailnet as a separate device.');
    expect(html).toContain('Running');
    expect(html).toContain('Port 7811 · version 1.2.3');
    expect(html).not.toContain('Iniciar com o Windows');
  });

  it('the failures of an action and of the update check', () => {
    setLanguage('en');
    expect(render({ failure: 'action' })).toContain('Could not complete that right now. Try again.');
    expect(render({ failure: 'update' })).toContain('Could not check for updates right now.');
  });

  it('the Tailscale card: sign-in link, address, steps and requirement', () => {
    setLanguage('en');
    const login = render({ tailscale: { state: 'needs_login', authUrl: 'https://login.tailscale.com/a/abc123' } });
    expect(login).toContain('Sign in to Tailscale');
    expect(login).toContain('Sign in to your Tailscale account');
    const running = render({ tailscale: { state: 'running', dnsName: 'nanachi-office-pc.tail1234.ts.net', tailnet: 'user@example.com', ips: [] } });
    expect(running).toContain('Address for the mobile device');
    expect(running).toContain('aria-label="Copy address"');
    expect(running).toContain('Install the Tailscale app on the mobile device');
    expect(running).toContain('Add to Home Screen');
    expect(running).toContain('The tailnet needs MagicDNS and HTTPS certificates enabled.');
    expect(running).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('the log of a daemon that failed', () => {
    setLanguage('en');
    const html = render({ daemon: { ...DAEMON, state: 'error', message: 'O daemon caiu 6 vezes.', logTail: ['linha 1'] } });
    expect(html).toContain('Last lines of the daemon log');
    expect(html).toContain('O daemon caiu 6 vezes.');
  });

  it('the pairing code: countdown, expiry and failure', () => {
    setLanguage('en');
    const now = 1_700_000_000_000;
    const live = renderToStaticMarkup(createElement(PairingCodeBody, { code: { code: '123456', expiresAt: now + 252_000 }, loading: false, failed: false, now }));
    expect(live).toContain('aria-label="Code 1 2 3 4 5 6"');
    expect(live).toContain('Expires in 4:12');
    const expired = renderToStaticMarkup(createElement(PairingCodeBody, { code: { code: '123456', expiresAt: now - 1000 }, loading: false, failed: false, now }));
    expect(expired).toContain('Expired');
    expect(renderToStaticMarkup(createElement(PairingCodeBody, { code: null, loading: true, failed: false, now }))).toContain('Generating the code…');
    const failed = renderToStaticMarkup(createElement(PairingCodeBody, { code: null, loading: false, failed: true, now }));
    expect(failed).toContain('Could not generate the code right now.');
    expect(failed).toContain('role="alert"');
  });
});
