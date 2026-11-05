import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import type { DaemonStatus, TailscaleStatus } from './schema.js';
import {
  describeDaemon,
  describeTailscale,
  describeUpdate,
  formatPairingCode,
  pairingCountdown,
  phoneSteps,
  restrictedText,
  tailscaleAddress,
} from './view.js';

const BASE: DaemonStatus = {
  state: 'running',
  port: 7811,
  mode: 'spawned',
  pid: 4242,
  version: '1.2.3',
  machineName: 'PC-DO-JOSE',
  restricted: false,
  message: null,
  logTail: [],
};

describe('describeDaemon', () => {
  it('running: success tone, port and version', () => {
    expect(describeDaemon(BASE)).toEqual({
      tone: 'success',
      pulse: false,
      title: 'Rodando',
      detail: 'Porta 7811 · versão 1.2.3',
      problem: null,
      logTail: [],
    });
  });

  it('running without a version only names the port', () => {
    expect(describeDaemon({ ...BASE, version: null }).detail).toBe('Porta 7811');
  });

  it('attached: says it is an existing daemon that Desktop will not stop', () => {
    const view = describeDaemon({ ...BASE, state: 'attached', mode: 'attached', pid: null });
    expect(view.title).toBe('Conectado ao daemon existente');
    expect(view.tone).toBe('success');
    expect(view.detail).toContain('Porta 7811');
    expect(view.detail).toContain('não o encerra');
  });

  it('starting pulses and shows the retry message of a crash', () => {
    const view = describeDaemon({ ...BASE, state: 'starting', version: null, message: 'O daemon caiu (código 1); tentando de novo em 2 s.' });
    expect(view).toMatchObject({ tone: 'running', pulse: true, title: 'Iniciando…', detail: 'O daemon caiu (código 1); tentando de novo em 2 s.' });
  });

  it('stopped is quiet', () => {
    expect(describeDaemon({ ...BASE, state: 'stopped', mode: 'none', pid: null })).toMatchObject({ tone: 'muted', title: 'Parado', problem: null });
  });

  it('error carries the message and the last log lines', () => {
    const view = describeDaemon({ ...BASE, state: 'error', message: 'O daemon caiu 6 vezes.', logTail: ['linha 1', 'linha 2'] });
    expect(view).toMatchObject({ tone: 'danger', title: 'Erro', problem: 'O daemon caiu 6 vezes.', logTail: ['linha 1', 'linha 2'] });
  });

  it('error without a message still explains itself', () => {
    expect(describeDaemon({ ...BASE, state: 'error' }).problem).toBe('O daemon não está rodando.');
  });

  it('restricted (allowedTailscaleLogins): the explanation, in the attention tone, for running and attached', () => {
    for (const state of ['running', 'attached'] as const) {
      const view = describeDaemon({ ...BASE, state, restricted: true, message: null });
      expect(view).toMatchObject({ tone: 'attention', title: 'Acesso local bloqueado', problem: restrictedText() });
    }
    expect(restrictedText()).toContain('allowedTailscaleLogins');
    expect(restrictedText()).toContain('NANACHI_HOME');
  });

  it('restricted prefers the message of Desktop when there is one', () => {
    expect(describeDaemon({ ...BASE, restricted: true, message: 'texto do Desktop' }).problem).toBe('texto do Desktop');
  });
});

describe('tailscaleAddress', () => {
  it('is https://<dnsName>, without a trailing dot', () => {
    expect(tailscaleAddress('nanachi-office-pc.tail1234.ts.net')).toBe('https://nanachi-office-pc.tail1234.ts.net');
    expect(tailscaleAddress('nanachi-office-pc.tail1234.ts.net.')).toBe('https://nanachi-office-pc.tail1234.ts.net');
  });
});

describe('describeTailscale', () => {
  it('off: switch off, nothing else', () => {
    expect(describeTailscale({ state: 'off' })).toEqual({
      checked: false,
      tone: 'muted',
      pulse: false,
      title: 'Desligado',
      detail: null,
      authUrl: null,
      address: null,
      problem: null,
    });
  });

  it('starting: switch on, pulsing', () => {
    expect(describeTailscale({ state: 'starting' })).toMatchObject({ checked: true, pulse: true, tone: 'running' });
  });

  it('needs_login: the auth URL becomes the link', () => {
    const view = describeTailscale({ state: 'needs_login', authUrl: 'https://login.tailscale.com/a/abc' });
    expect(view).toMatchObject({ checked: true, tone: 'attention', authUrl: 'https://login.tailscale.com/a/abc', address: null });
  });

  it('running: the https address and the tailnet', () => {
    const status: TailscaleStatus = { state: 'running', dnsName: 'nanachi-office-pc.tail1234.ts.net', tailnet: 'user@example.com', ips: ['100.64.0.5'] };
    expect(describeTailscale(status)).toMatchObject({
      checked: true,
      tone: 'success',
      title: 'Conectado',
      detail: 'Tailnet user@example.com',
      address: 'https://nanachi-office-pc.tail1234.ts.net',
      authUrl: null,
    });
  });

  it('running without a tailnet name has no detail line', () => {
    expect(describeTailscale({ state: 'running', dnsName: 'a.ts.net', tailnet: '', ips: [] }).detail).toBeNull();
  });

  it('error: switch stays on so it can be turned off, message goes to the error block', () => {
    expect(describeTailscale({ state: 'error', message: 'HTTPS não habilitado' })).toMatchObject({
      checked: true,
      tone: 'danger',
      problem: 'HTTPS não habilitado',
    });
  });
});

describe('phoneSteps', () => {
  it('names the address and covers install, open, pairing code and Home Screen', () => {
    const steps = phoneSteps('https://nanachi-office-pc.tail1234.ts.net');
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain('Instale o app Tailscale no iPhone');
    expect(steps[1]).toContain('https://nanachi-office-pc.tail1234.ts.net');
    expect(steps[2]).toContain('Gerar código de pareamento');
    expect(steps[3]).toContain('Adicionar à Tela de Início');
  });
});

describe('pairing code helpers', () => {
  it('formats six digits in two groups and leaves anything else alone', () => {
    expect(formatPairingCode('123456')).toBe('123 456');
    expect(formatPairingCode('12345')).toBe('12345');
  });

  it('counts down to the expiry', () => {
    const now = 1_700_000_000_000;
    expect(pairingCountdown(now + 252_000, now)).toEqual({ expired: false, label: 'Expira em 4:12' });
    expect(pairingCountdown(now + 61_000, now)).toEqual({ expired: false, label: 'Expira em 1:01' });
    expect(pairingCountdown(now + 500, now)).toEqual({ expired: false, label: 'Expira em 0:01' });
    expect(pairingCountdown(now, now)).toEqual({ expired: true, label: 'Expirou' });
    expect(pairingCountdown(now - 5_000, now)).toEqual({ expired: true, label: 'Expirou' });
  });
});

describe('describeUpdate', () => {
  it('idle: the installed version', () => {
    expect(describeUpdate('0.3.0', null, false)).toEqual({ summary: 'Versão 0.3.0', tone: 'muted', link: null });
  });

  it('checking', () => {
    expect(describeUpdate('0.3.0', null, true).summary).toBe('Procurando…');
  });

  it('up to date', () => {
    expect(describeUpdate('0.3.0', { status: 'up-to-date', current: '0.3.0' }, false)).toEqual({
      summary: 'Versão 0.3.0. Você está na mais recente.',
      tone: 'muted',
      link: null,
    });
  });

  it('available: a link to the release page', () => {
    const view = describeUpdate('0.3.0', { status: 'available', current: '0.3.0', latest: '0.4.0', url: 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v0.4.0' }, false);
    expect(view.tone).toBe('attention');
    expect(view.summary).toContain('Nova versão 0.4.0');
    expect(view.link).toEqual({ label: 'Nova versão 0.4.0', url: 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v0.4.0' });
  });

  it('error keeps the message', () => {
    const view = describeUpdate('0.3.0', { status: 'error', current: '0.3.0', message: 'O GitHub respondeu HTTP 500.' }, false);
    expect(view).toMatchObject({ tone: 'danger', link: null });
    expect(view.summary).toContain('O GitHub respondeu HTTP 500.');
  });
});

describe('the Desktop texts in English', () => {
  it('describeDaemon words every state, and leaves the message of Desktop alone', () => {
    setLanguage('en');
    expect(describeDaemon(BASE)).toMatchObject({ title: 'Running', detail: 'Port 7811 · version 1.2.3' });
    expect(describeDaemon({ ...BASE, version: null }).detail).toBe('Port 7811');
    const attached = describeDaemon({ ...BASE, state: 'attached', mode: 'attached', pid: null });
    expect(attached.title).toBe('Connected to the existing daemon');
    expect(attached.detail).toBe('Port 7811 · version 1.2.3. Desktop does not stop it when you quit.');
    expect(describeDaemon({ ...BASE, state: 'starting', message: 'O daemon caiu (código 1).' })).toMatchObject({
      title: 'Starting…',
      detail: 'O daemon caiu (código 1).',
    });
    expect(describeDaemon({ ...BASE, state: 'stopped', mode: 'none', pid: null }).title).toBe('Stopped');
    expect(describeDaemon({ ...BASE, state: 'error' })).toMatchObject({ title: 'Error', problem: 'The daemon is not running.' });
    expect(describeDaemon({ ...BASE, state: 'error', message: 'O daemon caiu 6 vezes.' }).problem).toBe('O daemon caiu 6 vezes.');
    const restricted = describeDaemon({ ...BASE, restricted: true });
    expect(restricted.title).toBe('Local access blocked');
    expect(restricted.problem).toBe(restrictedText());
    expect(restrictedText()).toContain('NANACHI_HOME');
    expect(restrictedText()).toContain('only accepts access through Tailscale');
  });

  it('describeTailscale and the steps for the phone', () => {
    setLanguage('en');
    expect(describeTailscale({ state: 'off' }).title).toBe('Off');
    expect(describeTailscale({ state: 'starting' }).title).toBe('Starting…');
    const login = describeTailscale({ state: 'needs_login', authUrl: 'https://login.tailscale.com/a/abc' });
    expect(login.title).toBe('Sign in to your Tailscale account');
    expect(login.detail).toBe("Open the link, sign in and approve this PC. The address shows up here when it's done.");
    const running = describeTailscale({ state: 'running', dnsName: 'pc.tail1.ts.net.', tailnet: 'me@example.com', ips: [] });
    expect(running).toMatchObject({ title: 'Connected', detail: 'Tailnet me@example.com', address: 'https://pc.tail1.ts.net' });
    expect(describeTailscale({ state: 'error', message: 'falhou' })).toMatchObject({ title: 'Error', problem: 'falhou' });
    expect(phoneSteps('https://pc.tail1.ts.net')).toEqual([
      'Install the Tailscale app on the iPhone and sign in with the same account.',
      'Open https://pc.tail1.ts.net in Safari.',
      'If the app asks for a code, use "Generate pairing code" here.',
      'Tap Share, then "Add to Home Screen".',
    ]);
  });

  it('pairingCountdown and describeUpdate', () => {
    setLanguage('en');
    const now = 1_700_000_000_000;
    expect(pairingCountdown(now + 252_000, now)).toEqual({ expired: false, label: 'Expires in 4:12' });
    expect(pairingCountdown(now - 1000, now)).toEqual({ expired: true, label: 'Expired' });
    expect(describeUpdate('0.1.0', null, true).summary).toBe('Checking…');
    expect(describeUpdate('0.1.0', null, false).summary).toBe('Version 0.1.0');
    expect(describeUpdate('0.1.0', { status: 'up-to-date', current: '0.1.0' }, false).summary).toBe("Version 0.1.0. You're on the latest.");
    const available = describeUpdate('0.1.0', { status: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/x/y/releases/tag/v0.2.0' }, false);
    expect(available.summary).toBe('Version 0.1.0. New version 0.2.0 available.');
    expect(available.link?.label).toBe('New version 0.2.0');
    expect(describeUpdate('0.1.0', { status: 'error', current: '0.1.0', message: 'Sem rede.' }, false).summary).toBe('Version 0.1.0. Sem rede.');
  });
});
