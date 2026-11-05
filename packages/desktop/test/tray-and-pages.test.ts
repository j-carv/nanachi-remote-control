import { describe, expect, it } from 'vitest';
import { statusLabel } from '../src/common/status-label.js';
import type { DaemonState, DaemonStatus } from '../src/common/types.js';
import {
  escapeHtml,
  formatRemaining,
  groupCode,
  renderPairingHtml,
  renderStatusPageHtml,
  toDataUrl,
} from '../src/main/pages.js';
import { buildTrayMenu, trayTooltip, type TrayActions } from '../src/main/tray-menu.js';

function status(state: DaemonState, patch: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    state,
    port: 7811,
    mode: 'none',
    pid: null,
    version: null,
    machineName: null,
    restricted: false,
    message: null,
    logTail: [],
    ...patch,
  };
}

describe('status labels', () => {
  it('uses the wording of the contract', () => {
    expect(statusLabel({ state: 'running' })).toBe('Nanachi · rodando');
    expect(statusLabel({ state: 'attached' })).toBe('Nanachi · conectado ao daemon existente');
    expect(statusLabel({ state: 'stopped' })).toBe('Nanachi · parado');
    expect(statusLabel({ state: 'error' })).toBe('Nanachi · erro');
    expect(statusLabel({ state: 'starting' })).toBe('Nanachi · iniciando');
  });
});

describe('tray menu', () => {
  function actions(): TrayActions & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      openPanel: () => void calls.push('open'),
      generatePairingCode: () => void calls.push('pair'),
      setAutostart: (enabled) => void calls.push(`autostart:${enabled}`),
      quit: () => void calls.push('quit'),
    };
  }

  it('has the items of the contract in order, the status first', () => {
    const menu = buildTrayMenu({ status: status('running'), autostart: false, autostartSupported: true, actions: actions() });
    expect(menu.map((item) => item.label ?? item.type)).toEqual([
      'Nanachi · rodando',
      'separator',
      'Abrir painel',
      'Gerar código de pareamento',
      'Iniciar com o Windows',
      'separator',
      'Sair',
    ]);
    expect(menu[0]?.enabled).toBe(false);
  });

  it('wires every click to its action', () => {
    const a = actions();
    const menu = buildTrayMenu({ status: status('attached'), autostart: true, autostartSupported: true, actions: a });
    const click = (label: string, checked?: boolean): void => {
      const item = menu.find((entry) => entry.label === label);
      (item?.click as ((i: unknown) => void) | undefined)?.({ checked });
    };
    click('Abrir painel');
    click('Gerar código de pareamento');
    click('Iniciar com o Windows', false);
    click('Sair');
    expect(a.calls).toEqual(['open', 'pair', 'autostart:false', 'quit']);
  });

  it('shows the autostart checkbox state, and disables it outside the installed app', () => {
    const on = buildTrayMenu({ status: status('running'), autostart: true, autostartSupported: true, actions: actions() });
    expect(on.find((item) => item.label === 'Iniciar com o Windows')).toMatchObject({ type: 'checkbox', checked: true, enabled: true });
    const dev = buildTrayMenu({ status: status('running'), autostart: false, autostartSupported: false, actions: actions() });
    expect(dev.find((item) => item.label === 'Iniciar com o Windows')?.enabled).toBe(false);
  });

  it('offers a pairing code only while a daemon answers', () => {
    const enabled = (state: DaemonState): boolean | undefined =>
      buildTrayMenu({ status: status(state), autostart: false, autostartSupported: true, actions: actions() }).find(
        (item) => item.label === 'Gerar código de pareamento',
      )?.enabled;
    expect(enabled('running')).toBe(true);
    expect(enabled('attached')).toBe(true);
    expect(enabled('starting')).toBe(false);
    expect(enabled('stopped')).toBe(false);
    expect(enabled('error')).toBe(false);
  });

  it('tooltip is the status line, with the reason on error, capped at 127 characters', () => {
    expect(trayTooltip(status('running'))).toBe('Nanachi · rodando');
    expect(trayTooltip(status('error', { message: 'porta em uso' }))).toBe('Nanachi · erro: porta em uso');
    const long = trayTooltip(status('error', { message: 'x'.repeat(500) }));
    expect(long.length).toBe(127);
  });
});

const NONCE = 'bm9uY2UxMjM0NTY3OA==';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe('pairing page', () => {
  const html = renderPairingHtml({ code: '004217', expiresAt: 1_000_000 + 125_000, qrDataUrl: PNG, nonce: NONCE, now: 1_000_000 });

  it('shows the grouped code, the countdown and the QR', () => {
    expect(html).toContain('004 217');
    expect(html).toContain('Expira em 02:05');
    expect(html).toContain(`<img src="${PNG}"`);
    expect(html).toContain('data-expires-at="1125000"');
  });

  it('has a strict CSP: no network, scripts only with the nonce, images only as data', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src data:");
    expect(html).toContain(`script-src 'nonce-${NONCE}'`);
    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });

  it('follows the monochrome tokens and the system theme, with no emoji', () => {
    expect(html).toContain('--ui-background: oklch(0.985 0 0)');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('--ui-background: oklch(0.145 0 0)');
    expect(EMOJI.test(html)).toBe(false);
  });

  it('refuses a code that is not six digits and a QR that is not a PNG data URL', () => {
    const base = { expiresAt: 1, qrDataUrl: PNG, nonce: NONCE, now: 0 };
    expect(() => renderPairingHtml({ ...base, code: '12345' })).toThrow();
    expect(() => renderPairingHtml({ ...base, code: '<b>123456' })).toThrow();
    expect(() => renderPairingHtml({ ...base, code: '123456', qrDataUrl: 'https://evil.example/q.png' })).toThrow();
  });

  it('formats time left and the expired state', () => {
    expect(formatRemaining(61_000, 0)).toBe('Expira em 01:01');
    expect(formatRemaining(1_000, 5_000)).toMatch(/expirado/);
    expect(groupCode('123456')).toBe('123 456');
  });

  it('the countdown script stays inside the page: it reads its own element and writes text', () => {
    const script = html.slice(html.indexOf('<script'), html.indexOf('</script>'));
    expect(script).toContain("getElementById('pairing')");
    expect(script).toContain('textContent');
    expect(script).not.toContain('innerHTML');
    expect(script).not.toContain('fetch');
  });
});

describe('status page', () => {
  it('shows the error, its reason and the log tail, escaped, with no script', () => {
    const html = renderStatusPageHtml({
      state: 'error',
      port: 7811,
      message: 'O daemon caiu 6 vezes <b>em 2 minutos</b>.',
      logTail: ['{"msg":"EADDRINUSE"}', '<script>alert(1)</script>'],
    });
    expect(html).toContain('O daemon não conseguiu iniciar');
    expect(html).toContain('&lt;b&gt;em 2 minutos&lt;/b&gt;');
    expect(html).toContain('EADDRINUSE');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
    expect(html).toContain("default-src 'none'");
    expect(EMOJI.test(html)).toBe(false);
  });

  it('explains a daemon that only accepts Tailscale, in the error tone', () => {
    const html = renderStatusPageHtml({
      state: 'attached',
      port: 7777,
      restricted: true,
      message: 'O daemon responde, mas só aceita acessos pelo Tailscale (allowedTailscaleLogins no config.json).',
      logTail: [],
    });
    expect(html).toContain('O painel local não consegue usar este daemon');
    expect(html).toContain('allowedTailscaleLogins');
    expect(html).toContain('class="error"');
    expect(html).not.toContain('Abrindo o painel');
  });

  it('says it is waiting while the daemon starts', () => {
    const html = renderStatusPageHtml({ state: 'starting', port: 7811, message: null, logTail: [] });
    expect(html).toContain('Iniciando o daemon');
    expect(html).toContain('porta 7811');
  });
});

describe('helpers', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  });

  it('toDataUrl round-trips', () => {
    const url = toDataUrl('<p>ação</p>');
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.split(',')[1] ?? '')).toBe('<p>ação</p>');
  });
});
